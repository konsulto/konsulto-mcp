import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';
import { randomBytes } from 'node:crypto';
import { LoadedCredentials } from './token-loader.js';
import { toAgentError, ToolError } from '../errors/agent-actionable.js';

// Axios wrapper used by every tool. Centralizes:
//   - Bearer auth header injection
//   - Correlation IDs for log correlation across the user's session
//   - 429 backoff with a single retry (the LLM will see the surfaced
//     message and decide whether to step back further)
//   - Error mapping to ToolError so tools can pass the message straight
//     to the MCP response without per-tool branching
//
// Tools never construct axios instances directly — they take this client
// as a constructor arg or import its singleton. Keeps the auth header,
// timeout, and retry policy in one place.

const REQUEST_TIMEOUT_MS = 30_000;
const RATE_LIMIT_BACKOFF_MIN_MS = 500;
const RATE_LIMIT_BACKOFF_MAX_MS = 5_000;

export class ApiClient {
  private readonly axios: AxiosInstance;
  private readonly endpoint: string;

  constructor(creds: LoadedCredentials) {
    this.endpoint = creds.endpoint.replace(/\/+$/, '');
    this.axios = axios.create({
      baseURL: this.endpoint,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${creds.token}`,
        'User-Agent': `konsulto-mcp/${getPkgVersion()} node/${process.versions.node}`,
        'Content-Type': 'application/json',
      },
    });
  }

  // Public surface: matches axios method names but rethrows ToolError so
  // tool handlers can `try { client.get(…) } catch (err) { return errResult(err) }`
  // without checking shape.
  async get<T = unknown>(path: string, config?: AxiosRequestConfig): Promise<T> {
    return this.request<T>({ ...config, method: 'GET', url: path });
  }

  async post<T = unknown>(
    path: string,
    body?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.request<T>({ ...config, method: 'POST', url: path, data: body });
  }

  async put<T = unknown>(
    path: string,
    body?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.request<T>({ ...config, method: 'PUT', url: path, data: body });
  }

  async patch<T = unknown>(
    path: string,
    body?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.request<T>({ ...config, method: 'PATCH', url: path, data: body });
  }

  async delete<T = unknown>(path: string, config?: AxiosRequestConfig): Promise<T> {
    return this.request<T>({ ...config, method: 'DELETE', url: path });
  }

  // Build a deep-link URL from a relative client-side path. e.g.
  //   webUrl('/audits/abc/findings/xyz') → 'https://app.konsulto.io/audits/abc/findings/xyz'
  // The web app and the API live on different subdomains; we guess the
  // mapping (api.* → app.*) and let users override via KONSULTO_APP_URL.
  webUrl(path: string): string {
    const overridden = process.env.KONSULTO_APP_URL?.trim().replace(/\/+$/, '');
    if (overridden) return `${overridden}${ensureLeadingSlash(path)}`;
    const guessed = this.endpoint.replace(/\/\/api\./, '//app.');
    return `${guessed}${ensureLeadingSlash(path)}`;
  }

  private async request<T>(config: AxiosRequestConfig): Promise<T> {
    const correlationId = randomBytes(6).toString('hex');
    const headers = {
      ...(config.headers ?? {}),
      'X-Request-Id': correlationId,
    };
    const finalConfig = { ...config, headers };

    try {
      const res = await this.axios.request<T>(finalConfig);
      return res.data;
    } catch (err) {
      // Single retry on 429 with backoff. The backend's KeyedThrottlerGuard
      // buckets by apiKeyId, so a brief pause typically clears it.
      const ax = err as AxiosError;
      if (ax?.isAxiosError && ax.response?.status === 429) {
        const retryAfter = parseRetryAfter(
          ax.response?.headers?.['retry-after'] as string | undefined,
        );
        await sleep(retryAfter);
        try {
          const res = await this.axios.request<T>(finalConfig);
          return res.data;
        } catch (err2) {
          throw new ToolError(toAgentError(err2).message, (err2 as AxiosError)?.response?.status);
        }
      }
      const mapped = toAgentError(err);
      throw new ToolError(mapped.message, mapped.status);
    }
  }
}

function ensureLeadingSlash(p: string): string {
  return p.startsWith('/') ? p : `/${p}`;
}

function parseRetryAfter(header: string | undefined): number {
  if (!header) {
    return RATE_LIMIT_BACKOFF_MIN_MS + Math.floor(Math.random() * RATE_LIMIT_BACKOFF_MIN_MS);
  }
  const seconds = parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, RATE_LIMIT_BACKOFF_MAX_MS);
  }
  return RATE_LIMIT_BACKOFF_MIN_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Read package.json version at runtime for the User-Agent header. Wrapped
// in try/catch so packaging quirks don't break the server.
function getPkgVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const url = new URL('../../package.json', import.meta.url);
    // dynamic require avoids the JSON-import assertion churn.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require(url.pathname);
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
