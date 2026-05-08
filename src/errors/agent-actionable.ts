// Map HTTP errors → strings the LLM can act on. The standard pattern is:
// "what failed (in plain English)" + "the next step the agent should take".
// Status codes alone (403, 422) leave the LLM guessing; concrete next-step
// strings drive better tool sequencing.
//
// Used by the API client wrapper. Tools surface these messages directly
// in the tool result content so Claude Code can read and react.

import { AxiosError } from 'axios';

export type AgentError = {
  // The user-facing message — what the LLM (and the human reading the
  // chat) should see. Concrete and actionable.
  message: string;
  // HTTP status when known. Tools can use this to decide branching
  // behavior (e.g. retry on 5xx, give up on 4xx).
  status?: number;
  // Original error for debugging in logs. Not surfaced to the LLM.
  cause?: unknown;
};

export class ToolError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ToolError';
    this.status = status;
  }
}

export function toAgentError(err: unknown, context?: string): AgentError {
  if (err instanceof ToolError) {
    return { message: err.message, status: err.status, cause: err };
  }
  if ((err as AxiosError)?.isAxiosError) {
    return mapAxiosError(err as AxiosError, context);
  }
  if (err instanceof Error) {
    return {
      message: context ? `${context}: ${err.message}` : err.message,
      cause: err,
    };
  }
  return {
    message: context ? `${context}: ${String(err)}` : String(err),
    cause: err,
  };
}

function mapAxiosError(err: AxiosError, context?: string): AgentError {
  const status = err.response?.status;
  const data: any = err.response?.data;
  const serverMsg =
    typeof data?.message === 'string'
      ? data.message
      : Array.isArray(data?.message)
        ? data.message.join('; ')
        : typeof data === 'string'
          ? data
          : '';

  const prefix = context ? `${context}: ` : '';

  if (status === 401) {
    return {
      message:
        prefix +
        'authentication failed. Your Konsulto MCP token is invalid, expired, or has been revoked. ' +
        'Mint a new one under Profile → MCP Tokens in the web app, then update your ~/.konsulto/credentials.',
      status,
      cause: err,
    };
  }
  if (status === 403) {
    return {
      message:
        prefix +
        `permission denied${serverMsg ? ` (${serverMsg})` : ''}. ` +
        'Either your role lacks the required permission, or the tenant has disabled MCP integration. ' +
        'Ask a Konsulto admin to grant you the necessary scope or enable the feature.',
      status,
      cause: err,
    };
  }
  if (status === 404) {
    return {
      message:
        prefix +
        `not found${serverMsg ? ` (${serverMsg})` : ''}. ` +
        'Verify the audit/finding/template ID is correct and that you are a member of the audit.',
      status,
      cause: err,
    };
  }
  if (status === 409) {
    return {
      message: prefix + (serverMsg || 'conflict — the resource already exists or has been modified.'),
      status,
      cause: err,
    };
  }
  if (status === 422 || status === 400) {
    return {
      message:
        prefix +
        `request rejected: ${serverMsg || 'invalid input'}. ` +
        'Re-read the tool input schema and adjust the offending fields.',
      status,
      cause: err,
    };
  }
  if (status === 429) {
    const retryAfter = err.response?.headers?.['retry-after'];
    return {
      message:
        prefix +
        `rate-limited by Konsulto API.${retryAfter ? ` Retry after ${retryAfter}s.` : ''} ` +
        'Reduce the call rate or pause briefly before retrying.',
      status,
      cause: err,
    };
  }
  if (status && status >= 500) {
    return {
      message:
        prefix +
        `Konsulto API returned ${status}${serverMsg ? ` (${serverMsg})` : ''}. ` +
        'This is a server-side issue — retry once, then surface the failure to the user.',
      status,
      cause: err,
    };
  }
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    return {
      message:
        prefix +
        `cannot reach Konsulto API at ${err.config?.baseURL ?? 'configured endpoint'}. ` +
        'Check the user\'s network or the KONSULTO_ENDPOINT setting.',
      cause: err,
    };
  }
  return {
    message: prefix + (err.message || 'unknown HTTP error'),
    status,
    cause: err,
  };
}
