# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- GitHub Actions CI workflow — runs `npm ci && npm run typecheck && npm run build`
  on every push to `main`/`dev` and every PR.
- Tag-triggered publish workflow — pushing a `vX.Y.Z` tag publishes
  `@konsulto/mcp@X.Y.Z` to npm with Sigstore provenance. Refuses to
  publish if the tag doesn't match `package.json` version.

## [0.1.0] - 2026-05-08

Initial release.

### Added

- **Stdio MCP server** that exposes the Konsulto cybersecurity audit platform
  to MCP-capable clients (Claude Code, etc.) via per-user personal access
  tokens (`kon_mcp_*`).
- **17 tools** organized into six domains:
  - Identity & context: `konsulto_whoami`, `konsulto_list_my_audits`,
    `konsulto_set_active_audit`, `konsulto_get_audit_context`.
  - Templates: `konsulto_search_templates` (slim shape — id, title,
    severity, summary, slot names, taxonomy).
  - Findings — read: `konsulto_search_findings`, `konsulto_get_finding`
    (returns body as markdown), `konsulto_read_section` (single section
    as markdown).
  - Findings — write: `konsulto_compose_finding` (structured fields →
    backend builds Tiptap body), `konsulto_update_finding` (scalar fields
    only), `konsulto_bulk_update_status` (with `dryRun` preview),
    `konsulto_append_to_section`, `konsulto_replace_section` (markdown
    in, Tiptap out, server-side conversion).
  - Evidence: `konsulto_attach_evidence` (file path / inline content /
    base64), `konsulto_add_evidence_to_finding`.
  - Scope & assets: `konsulto_list_scope`, `konsulto_list_assets`,
    `konsulto_create_asset`, `konsulto_link_asset` (match-or-create).
- **Section name aliases** — natural-language section names normalize to
  canonical keys server-side. "Recommendations" / "mitigation" / "fix" all
  map to `remediation`; "summary" maps to `description`; "steps to
  reproduce" maps to `poc`.
- **Helper CLI** (`konsulto`) with three subcommands:
  - `konsulto init` — interactive `.konsulto.yml` writer that pins a
    folder to one audit (sharable with the team, no secrets).
  - `konsulto whoami` — verify token, show identity + permissions +
    pinned audit.
  - `konsulto doctor` — sanity-check credentials file mode, token
    validity, tenant MCP-enabled flag, role-has-`mcp:use` permission.
- **Three workflow patterns** for activating an audit:
  - Folder-pinned via `.konsulto.yml` (recommended for repeat work).
  - Set per session via `konsulto_set_active_audit`.
  - Explicit per-call via the `audit` argument on each tool.
- **Multi-engagement support** via `KONSULTO_PROFILE=<name>` env var, which
  reads `~/.konsulto/credentials.<name>` instead of the default file.
- **Agent-actionable error messages** — HTTP failures map to specific
  next-step text the LLM can read and react to (revoke token, ask admin
  for permission, retry after rate-limit, etc.) rather than raw status
  codes.
- **429 backoff with single retry** in the API client; surfaces a clear
  rate-limited message when the retry also fails so the LLM stops
  hammering.
- **Deep-link `webUrl`** in every write response so a pentester can click
  through to refine in the web UI when needed.

### Security

- Token storage defaults to `~/.konsulto/credentials` with a chmod 600
  check at startup; warns on loose permissions, hard-fails in
  `konsulto doctor`.
- Refuses tenant integration keys (`kon_live_*`) with a specific message —
  only per-user MCP tokens (`kon_mcp_*`) are accepted.
- Three live gates checked on every backend request: tenant feature flag
  enabled, role has `mcp:use`, token not revoked/expired. Disabling any
  gate stops MCP traffic immediately, no token revocation needed.
- First-time-from-new-IP email notifies the token owner so a leaked PAT
  is detectable.
- Default token expiry: 90 days. Maximum 365.

[Unreleased]: https://github.com/konsulto/konsulto-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/konsulto/konsulto-mcp/releases/tag/v0.1.0
