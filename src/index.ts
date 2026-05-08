#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ApiClient } from './auth/api-client.js';
import { loadCredentials, CredentialError } from './auth/token-loader.js';
import { SessionState } from './context/session-state.js';
import { loadWorkspaceConfig } from './context/workspace-config.js';
import { buildServer } from './server.js';

// Stdio entrypoint. Spawned by Claude Code (or any MCP-capable client) via
// `npx -y @konsulto/mcp` from ~/.claude/mcp.json. NEVER use console.log
// here — stdout is the MCP transport. All diagnostics go to stderr; the
// SDK's transport ignores it.

async function main(): Promise<void> {
  let creds;
  try {
    creds = loadCredentials();
  } catch (err) {
    const msg = err instanceof CredentialError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
    process.stderr.write(`[konsulto-mcp] startup failed: ${msg}\n`);
    process.exit(1);
  }

  // .konsulto.yml resolution. The folder pin is overridden by the YAML's
  // own `endpoint` field if present, so a team-shared file can point a
  // sub-team at a different environment without touching credentials.
  const workspace = loadWorkspaceConfig();
  if (workspace?.endpoint) {
    creds = { ...creds, endpoint: workspace.endpoint };
  }

  const client = new ApiClient(creds);
  const state = new SessionState();

  // Pre-pin active audit if .konsulto.yml carries one. Failure to resolve
  // (audit deleted, user lost access) is non-fatal — the user can still
  // use konsulto_set_active_audit to switch.
  if (workspace?.audit) {
    try {
      // We accept an ID directly OR a slug. Resolution happens against the
      // /audits endpoint with a fast-path for ObjectId.
      if (/^[a-f0-9]{24}$/i.test(workspace.audit)) {
        const audit = (await client.get<any>(`/audits/${workspace.audit}`)) as any;
        if (audit) {
          state.setActiveAudit({
            id: String(audit._id ?? audit.id),
            name: audit.name,
          });
        }
      } else {
        // Treat as a name to fuzzy-resolve against the user's audits.
        const data = (await client.get<any>('/audits', {
          params: { page: '1', limit: '100', memberOnly: 'true' },
        })) as any;
        const items = (data?.items ?? data?.data ?? data ?? []) as any[];
        const norm = workspace.audit.toLowerCase().trim();
        const found =
          items.find((a) => String(a.name).toLowerCase() === norm) ??
          (items.filter((a) => String(a.name).toLowerCase().includes(norm)).length === 1
            ? items.find((a) => String(a.name).toLowerCase().includes(norm))
            : null);
        if (found) {
          state.setActiveAudit({ id: String(found._id ?? found.id), name: found.name });
        } else {
          process.stderr.write(
            `[konsulto-mcp] .konsulto.yml at ${workspace.configPath} pins "${workspace.audit}" but no matching audit was found. ` +
              `Use konsulto_set_active_audit to switch manually.\n`,
          );
        }
      }
    } catch (err) {
      process.stderr.write(
        `[konsulto-mcp] could not resolve audit pin from ${workspace.configPath}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  const server = buildServer({ client, state, workspace });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Stay alive until the transport closes (Claude Code disconnect or stdin EOF).
}

main().catch((err) => {
  process.stderr.write(
    `[konsulto-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
