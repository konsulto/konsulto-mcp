# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`konsulto_list_finding_statuses` tool.** Lists the tenant's finding-status
  catalog (key, label, semantic, isDefault, system; archived omitted) so the
  agent uses real status keys. Statuses are tenant-customizable.
- **`konsulto_list_my_audits` gains a `scope` filter** (`mine` default | `all`).
  `mine` lists audits you are attached to (creator / lead / reviewer /
  contributor); `all` lists every audit in the tenant you can read. Default
  behaviour is unchanged.

### Changed

- **Finding status inputs are no longer a hardcoded enum.** `update_finding`,
  `bulk_update_status`, and `search_findings` now take a free-form status
  **key** (validated server-side against the tenant's catalog), so agents can
  set/filter custom statuses like "Partly Fixed". Built-in keys
  (open/accepted/mitigated/closed/rejected) still work. Pair with
  `konsulto_list_finding_statuses` to discover valid keys.

## [0.3.0] - 2026-06-28

### Fixed

- **`konsulto_attach_evidence` upload rejected with "purpose must be one of
  evidence.attachment, editor.derived".** The presign-upload call sent
  `purpose: kind ?? 'evidence'`, conflating the API's `purpose` enum with the
  `kind` render hint — so any `kind` (e.g. `screenshot`) or the `'evidence'`
  default failed the backend's `@IsIn` validation and no evidence was created.
  Now sends the constant `purpose: 'evidence.attachment'` (this tool is the
  evidence flow); `kind` remains an independent rendering hint. Affects all
  three input modes (filePath / content / contentBase64).

### Added

- **`konsulto_get_finding_format` tool.** Returns the ordered section
  structure + markdown authoring rules for an audit (and an optional
  template "starter" markdown to adapt). Call it before
  `konsulto_compose_finding` so the body matches every other finding.

### Changed

- **`konsulto_compose_finding` now takes per-section markdown.** New
  `sections` map (`description`/`poc`/`impact`/`remediation`/… → GFM
  markdown) + `title`; the backend converts markdown to fully-rich Tiptap
  (code blocks, tables, lists, links) instead of the old flat
  plain-paragraph fields. The legacy `fields` input is still accepted
  (now also markdown-parsed) but deprecated. Section keys accept the same
  aliases as the section-edit tools. Non-breaking: existing `fields`
  callers keep working.

- **Bin renamed `mcp` → `konsulto-mcp`.** The `mcp` name collided with
  Homebrew's `python-mcp` package (`/opt/homebrew/bin/mcp`) on machines
  that have it installed; npx's bin resolution picked the existing PATH
  entry instead of our package's bin. `konsulto-mcp` is namespace-unique
  and — since it's the only bin declared — npm/npx auto-selects it.
  Subcommand dispatch unchanged: `npx @konsulto/mcp <subcommand>` works.

## [0.2.0] - 2026-05-12

### Added

- `konsulto_audit_summary` tool — aggregate finding counts for an audit
  (total, by severity, by status, last 7d / 30d, last-finding timestamp).
  Orientation tool meant to pair with `konsulto_whoami` at session start.
  Backed by a new `GET /audits/:id/summary` endpoint on `konsulto-backend`
  using a single `$facet` aggregation, gated by `findings:read`.

## [0.1.2] - 2026-05-08

### Changed

- **Single bin (`mcp`)** — collapsed `konsulto-mcp` and `konsulto`
  binaries into one `mcp` entrypoint with subcommand dispatch
  (init / whoami / doctor / help). Default invocation runs the stdio
  MCP server.
- **CLI invocation** is now `npx @konsulto/mcp <subcommand>` instead of
  the multi-bin `npx -p @konsulto/mcp konsulto <subcommand>`.

### Fixed

- `npx -y @konsulto/mcp` errored with "could not determine executable to
  run" because npm 10 stopped auto-resolving a bin matching the unscoped
  package name when multiple bins are declared. The 0.1.1 mitigation
  (adding a `mcp` alias alongside the others) wasn't enough — single-bin
  refactor was needed.
- See 0.1.3 for the follow-up `mcp` → `konsulto-mcp` rename to dodge a
  PATH collision with the Python `mcp` CLI from Homebrew.

## [0.1.1] - 2026-05-08

### Added

- GitHub Actions CI workflow — runs `npm ci && npm run typecheck && npm run build`
  on every push to `main`/`dev` and every PR.
- Tag-triggered publish workflow — pushing a `vX.Y.Z` tag publishes
  `@konsulto/mcp@X.Y.Z` to npm with Sigstore provenance. Refuses to
  publish if the tag doesn't match `package.json` version.
- `mcp` bin alias alongside `konsulto-mcp` and `konsulto` (turned out
  not to fully fix `npx @konsulto/mcp`; see 0.1.2 Unreleased fix).

### Security

- Tightened README **Security** and **Troubleshooting** sections to
  remove attacker-recon material (exact auth-gate names, storage paths,
  anomaly-detection heuristics, feature-flag wording). User-facing
  actions remain.

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

[Unreleased]: https://github.com/konsulto/konsulto-mcp/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/konsulto/konsulto-mcp/releases/tag/v0.3.0
[0.1.0]: https://github.com/konsulto/konsulto-mcp/releases/tag/v0.1.0
