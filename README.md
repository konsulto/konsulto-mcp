# @konsulto/mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](package.json)

MCP server that lets Claude Code (and any other MCP-capable client) drive the [Konsulto](https://konsulto.io) cybersecurity audit platform from the CLI:

- **Read** — list audits you're on, search findings/templates, read a finding (including body rendered as markdown so the LLM can reason about prose), read a single section.
- **Write** — compose findings from structured fields (backend builds the Tiptap body), update scalars, append/replace section prose using markdown, bulk-change status with dry-run preview.
- **Evidence** — upload files/inline content/base64, graft evidence into a finding's body at the right section.
- **Scope & assets** — list scope, list/create assets, match-or-create an asset and link it to a finding.

Acts as the user, with their role permissions, gated by a per-user MCP token. Three runtime gates: tenant feature flag enabled, role has `mcp:use`, token not revoked/expired.

## Quick start

### 1. Mint an MCP token in the Konsulto web app

Sign in → **Profile → MCP Tokens** → **New MCP token**. Copy the `kon_mcp_…` value once — it isn't shown again. (Tenant admin must have enabled MCP integration first under **Account → API Access**.)

### 2. Save the token locally

```bash
mkdir -p ~/.konsulto && chmod 700 ~/.konsulto
cat > ~/.konsulto/credentials <<EOF
token: kon_mcp_REPLACE_WITH_YOUR_TOKEN
endpoint: https://api.konsulto.io
EOF
chmod 600 ~/.konsulto/credentials
```

Or use the `KONSULTO_TOKEN` env var if you'd rather not write a file.

### 3. Tell Claude Code about the server

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "konsulto": {
      "command": "npx",
      "args": ["-y", "@konsulto/mcp"]
    }
  }
}
```

Verify the wiring:

```bash
npx @konsulto/mcp doctor
```

You should see all green checks.

## Folder pinning (optional, recommended)

Run `npx @konsulto/mcp init` inside an engagement folder to pin it to one audit:

```
~/audits/acme-q2-pentest/
├── .konsulto.yml          ← pins this folder to one audit
├── recon/
└── notes.md
```

When Claude Code launches in that folder (or any subfolder), the MCP auto-pins the audit. No more thinking about audit IDs.

The file is sharable with your team — it contains an audit ID and optional endpoint, **no secrets**.

## Workflow patterns

| Pattern | When to use |
|---|---|
| **Folder-pinned `.konsulto.yml`** | Repeat work on the same engagement. Run `konsulto init` once per folder. |
| **`set_active_audit` per session** | One workspace, switching audits mentally. Tell Claude "switch to <audit name>". |
| **Explicit per-call** | Juggling several audits in one session. Pass `audit:` to each tool call. |

## Tools

Every tool is prefixed `konsulto_*` so it doesn't collide with other MCPs (Burp, nmap, prowler, etc.) you might have configured.

### Identity & context

| Tool | What it does |
|---|---|
| `konsulto_whoami` | Identity, permissions, active audit. Call first in a session. |
| `konsulto_list_my_audits` | List audits you're a member of. |
| `konsulto_set_active_audit` | Pin one audit for the rest of the session (fuzzy match by name). |
| `konsulto_get_audit_context` | One-shot orientation — name, status, scope/asset counts, severity rollup, team. |

### Templates

| Tool | What it does |
|---|---|
| `konsulto_search_templates` | Find finding templates by query/severity. Slim shape — id, title, severity, summary, slot names, taxonomy. No body. |

### Findings — read

| Tool | What it does |
|---|---|
| `konsulto_search_findings` | Search within an audit (defaults to active). |
| `konsulto_get_finding` | Read a finding including its body rendered as markdown so the LLM can reason about prose. |
| `konsulto_read_section` | Read just one section of a finding's body as markdown. Cheaper than `get_finding` for "explain the POC". |

### Findings — write

| Tool | What it does |
|---|---|
| `konsulto_compose_finding` | Create from structured fields + optional template + evidence. Backend builds the Tiptap body. |
| `konsulto_update_finding` | Change scalar fields (title, severity, status, taxonomy, assets). |
| `konsulto_bulk_update_status` | Mass status change. Supports `dryRun: true` for preview. |
| `konsulto_append_to_section` | Add markdown prose to a section. Section names accept aliases (recommendations, mitigation, fix, summary, etc.) — they normalize to canonical keys server-side. |
| `konsulto_replace_section` | Replace a section's prose. Old content saved on the audit trail. |

### Evidence

| Tool | What it does |
|---|---|
| `konsulto_attach_evidence` | Upload a file path / inline content / base64. Returns an evidenceId. |
| `konsulto_add_evidence_to_finding` | Graft an evidenceId into an existing finding's body (`auto` placement walks poc → description → impact → remediation → end). |

### Scope & assets

| Tool | What it does |
|---|---|
| `konsulto_list_scope` | Scope elements for an audit — what's authorized to test. |
| `konsulto_list_assets` | Assets in the audit (or tenant-wide). |
| `konsulto_create_asset` | Create a host / URL / IAM-role / etc. when a scan reveals one not yet tracked. |
| `konsulto_link_asset` | Match-or-create an asset by name and attach it to a finding. |

## Helper CLI

The same `npx @konsulto/mcp` command runs as the stdio MCP server when
called with no arguments (what Claude Code does), and as an interactive
helper when called with a subcommand:

- `npx @konsulto/mcp init` — write `.konsulto.yml` for the current folder
- `npx @konsulto/mcp whoami` — verify token, show identity + permissions
- `npx @konsulto/mcp doctor` — sanity-check credentials, token, reachability, and configuration

## Troubleshooting

Run `npx @konsulto/mcp doctor` first — it prints a one-line fix for the first failure. For the rest:

| Symptom | Fix |
|---|---|
| `No Konsulto credentials found` | Set `KONSULTO_TOKEN` env or create `~/.konsulto/credentials` (see Quick start). |
| Token rejected as the wrong type | You used a non-MCP token. Mint one under Profile → MCP Tokens. |
| Authentication errors on every call | Token revoked or expired — mint a fresh one. |
| Permission errors after working previously | Your role or tenant settings changed. Ask an admin. |
| Loose-permissions warning at startup | `chmod 600 ~/.konsulto/credentials` |

## Security

- **Treat tokens like passwords.** They carry your role's permissions to anyone who holds them. Don't share or commit them.
- **Revoke if leaked.** Web app → Profile → MCP Tokens. Revocations take effect on the next request.
- **Watch your inbox.** Konsulto emails you on suspicious token activity — investigate and revoke if you didn't trigger it.
- **Verify the package.** Published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) — `npm view @konsulto/mcp` shows the signature.

## Multi-engagement on one machine

Set `KONSULTO_PROFILE=acme` to read `~/.konsulto/credentials.acme` instead of the default. Useful when you're contracting on a customer's Konsulto tenant from the same laptop you use for your firm's tenant.

## License

MIT — see [LICENSE](LICENSE).
