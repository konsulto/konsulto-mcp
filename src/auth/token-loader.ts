import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

// Token + endpoint resolution. Precedence: ENV → ~/.konsulto/credentials.
// We refuse `kon_live_*` (tenant integration keys) — those exist for
// tenant-level integrations, not per-user MCP traffic. Mixing them up
// would bypass the three-gate model the backend enforces (tenant feature
// flag, role mcp:use, key not revoked/expired) since the backend routes
// them differently.

export type LoadedCredentials = {
  token: string;
  endpoint: string;
  source: 'env' | 'file';
  // Path of the file (when source === 'file'). For diagnostics in
  // `konsulto doctor` and the helper CLI — never logged in normal flow.
  filePath?: string;
};

export class CredentialError extends Error {
  // Exposed on the message so the LLM sees an actionable hint when the
  // server fails to start.
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

const DEFAULT_ENDPOINT = 'https://api.konsulto.io';

// Hard-fail prefixes so a wrong-shape token surfaces immediately rather
// than waiting for a 401 from the backend.
const MCP_PREFIX = 'kon_mcp_';
const TENANT_PREFIX = 'kon_live_';

export function loadCredentials(): LoadedCredentials {
  // 1. Env wins. Useful for CI / containers / `KONSULTO_TOKEN=… npx @konsulto/mcp`.
  const envToken = process.env.KONSULTO_TOKEN?.trim();
  if (envToken) {
    assertMcpToken(envToken);
    return {
      token: envToken,
      endpoint: process.env.KONSULTO_ENDPOINT?.trim() || DEFAULT_ENDPOINT,
      source: 'env',
    };
  }

  // 2. Credentials file. ~/.konsulto/credentials by default; per-user
  //    profile via KONSULTO_PROFILE=name → ~/.konsulto/credentials.name.
  const profile = process.env.KONSULTO_PROFILE?.trim();
  const filename = profile ? `credentials.${profile}` : 'credentials';
  const filePath = join(homedir(), '.konsulto', filename);

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new CredentialError(
        `No Konsulto credentials found.\n` +
          `  Set KONSULTO_TOKEN=kon_mcp_… in your environment, OR\n` +
          `  create ${filePath} with:\n` +
          `    token: kon_mcp_YOUR_TOKEN\n` +
          `    endpoint: https://api.konsulto.io\n` +
          `  Then chmod 600 the file.`,
      );
    }
    throw new CredentialError(
      `Failed to read ${filePath}: ${err?.message ?? String(err)}`,
    );
  }

  // File-mode check — warn (don't fail) if anyone-readable. Failing would
  // block users on a fresh clone before they realize chmod is required.
  // The helper CLI's `konsulto doctor` upgrades this to a hard FAIL.
  try {
    const mode = statSync(filePath).mode & 0o777;
    if (mode & 0o077) {
      // eslint-disable-next-line no-console
      console.warn(
        `[konsulto-mcp] credentials file ${filePath} has loose permissions ` +
          `(mode ${mode.toString(8).padStart(3, '0')}). Run: chmod 600 ${filePath}`,
      );
    }
  } catch {
    // Stat failure is non-fatal; the readFileSync above already proved
    // the file is accessible.
  }

  const parsed = parseCredentialsYaml(raw, filePath);
  assertMcpToken(parsed.token);

  return {
    token: parsed.token,
    endpoint: parsed.endpoint || DEFAULT_ENDPOINT,
    source: 'file',
    filePath,
  };
}

function parseCredentialsYaml(
  raw: string,
  filePath: string,
): { token: string; endpoint?: string } {
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err: any) {
    throw new CredentialError(
      `Could not parse YAML at ${filePath}: ${err?.message ?? String(err)}`,
    );
  }
  if (!doc || typeof doc !== 'object') {
    throw new CredentialError(
      `${filePath} is empty or not a YAML mapping. Expected:\n` +
        `  token: kon_mcp_…\n  endpoint: https://api.konsulto.io`,
    );
  }
  const obj = doc as Record<string, unknown>;
  const token = typeof obj.token === 'string' ? obj.token.trim() : '';
  const endpoint =
    typeof obj.endpoint === 'string' ? obj.endpoint.trim() : undefined;

  if (!token) {
    throw new CredentialError(
      `${filePath} is missing a "token" field.`,
    );
  }
  return { token, endpoint };
}

function assertMcpToken(token: string): void {
  if (token.startsWith(TENANT_PREFIX)) {
    throw new CredentialError(
      `This token (${token.slice(0, 12)}…) is a tenant integration key, ` +
        `not an MCP token. Mint an MCP token under your account ` +
        `Profile → MCP Tokens. The MCP server only accepts kon_mcp_* tokens.`,
    );
  }
  if (!token.startsWith(MCP_PREFIX)) {
    throw new CredentialError(
      `Token does not look like a Konsulto MCP token (expected prefix ${MCP_PREFIX}). ` +
        `Mint one under Profile → MCP Tokens in the Konsulto web app.`,
    );
  }
}
