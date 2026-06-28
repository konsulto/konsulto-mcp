import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { toMarkdown } from 'tiptap-converter';
import { ApiClient } from './auth/api-client.js';
import { SessionState } from './context/session-state.js';
import { loadWorkspaceConfig, WorkspaceConfig } from './context/workspace-config.js';
import { ToolError } from './errors/agent-actionable.js';

// Canonical section keys + common aliases. Pentesters say "recommendations"
// or "mitigation" naturally; the LLM should be able to pass them through
// without having to know the canonical name. Anything not in this map
// falls through to the backend, which 400s with a clear list of valid
// sections — so unknown inputs get a useful error rather than a silent
// rejection at the zod schema layer.
const SECTION_ALIASES: Record<string, string> = {
  description: 'description',
  summary: 'description',
  details: 'description',
  poc: 'poc',
  'proof of concept': 'poc',
  'steps to reproduce': 'poc',
  steps: 'poc',
  impact: 'impact',
  'business impact': 'impact',
  remediation: 'remediation',
  remediations: 'remediation',
  recommendation: 'remediation',
  recommendations: 'remediation',
  mitigation: 'remediation',
  mitigations: 'remediation',
  solution: 'remediation',
  solutions: 'remediation',
  fix: 'remediation',
  fixes: 'remediation',
  references: 'references',
  links: 'references',
  sources: 'references',
};

function normalizeSection(input: string): string {
  const norm = input.toLowerCase().trim();
  // Canonical aliases win; otherwise return the normalized (lowercased) form so
  // custom layout-section keys match the backend's normalized heading text.
  return SECTION_ALIASES[norm] ?? norm;
}

const SECTION_DESCRIPTION =
  'Section name. Canonical: description, poc, impact, remediation, references. ' +
  'Aliases accepted: summary, recommendations, mitigation, fix, steps to reproduce, etc.';

// Build and configure the MCP server. Tools register here. The transport
// (stdio) is bound in index.ts so this module can be imported and
// inspected by the helper CLI without spawning a server.

export function buildServer(opts: {
  client: ApiClient;
  state: SessionState;
  workspace: WorkspaceConfig | null;
}): McpServer {
  const { client, state, workspace } = opts;

  const server = new McpServer({
    name: 'konsulto',
    version: '0.2.0',
  });

  // ---------------------------------------------------------------------------
  // Identity / context
  // ---------------------------------------------------------------------------

  server.tool(
    'konsulto_whoami',
    'Show who the MCP is acting as, their permissions, the active audit, and ' +
      'how authentication is configured. Call this first in any session to ' +
      'orient yourself before performing actions. Returns user identity, ' +
      'tenant, role permissions, MCP token expiry, and active audit pin.',
    {},
    async () => {
      try {
        const profile = (await client.get<any>('/users/profile')) as any;
        const active = state.getActiveAudit();
        return ok({
          user: {
            id: profile?._id ?? profile?.userId,
            username: profile?.username,
            email: profile?.email,
            name: [profile?.firstName, profile?.lastName].filter(Boolean).join(' ') || profile?.username,
          },
          tenant: {
            features: profile?.tenantFeatures ?? {},
          },
          permissions: profile?.resolvedPermissions ?? [],
          activeAudit: active,
          workspaceConfig: workspace
            ? { configPath: workspace.configPath, pinnedAudit: workspace.audit }
            : null,
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Audits
  // ---------------------------------------------------------------------------

  server.tool(
    'konsulto_list_my_audits',
    'List audits this user is a team member of. Use to find the audit ID ' +
      'you want to work in. Filter by status (active/draft/completed/archived).',
    {
      status: z
        .enum(['active', 'draft', 'completed', 'archived'])
        .optional()
        .describe('Filter to a single status. Omit to return all.'),
      limit: z.number().int().min(1).max(100).default(25).optional(),
    },
    async ({ status, limit }) => {
      try {
        // memberOnly=true asks the backend to restrict to audits where the
        // caller is creator, lead, or on the team. Admins (full-access
        // roles) still see everything they're connected to — they just
        // don't see audits they're not part of, which is what the user
        // expects from a tool literally named "list MY audits".
        const params: Record<string, string> = {
          page: '1',
          limit: String(limit ?? 25),
          memberOnly: 'true',
        };
        if (status) params.status = status;
        const data = (await client.get<any>('/audits', { params })) as any;
        const items = data?.items ?? data?.data ?? data ?? [];
        return ok({
          audits: items.map((a: any) => ({
            id: String(a._id ?? a.id),
            name: a.name,
            status: a.status,
            startDate: a.startDate,
            endDate: a.endDate,
            webUrl: client.webUrl(`/audits/${a._id ?? a.id}`),
          })),
          activeAudit: state.getActiveAudit(),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    'konsulto_set_active_audit',
    'Pin one audit as the session\'s active audit. Subsequent tools that ' +
      'take an optional audit argument will default to this one. Accepts an ' +
      'audit ID OR a substring of the audit name (fuzzy match — exact match ' +
      'wins, then unique substring). Folder-level pinning via .konsulto.yml ' +
      'is the recommended persistent alternative.',
    {
      audit: z.string().min(1).describe('Audit ID or name substring.'),
    },
    async ({ audit }) => {
      try {
        // Try direct ID first.
        if (/^[a-f0-9]{24}$/i.test(audit)) {
          const got = (await client.get<any>(`/audits/${audit}`)) as any;
          if (got) {
            state.setActiveAudit({ id: String(got._id ?? got.id), name: got.name });
            return ok({
              activeAudit: state.getActiveAudit(),
              webUrl: client.webUrl(`/audits/${got._id ?? got.id}`),
            });
          }
        }
        // Fuzzy by name. memberOnly=true so a misspelled name in a busy
        // tenant doesn't match an audit the user isn't on.
        const data = (await client.get<any>('/audits', {
          params: { page: '1', limit: '100', memberOnly: 'true' },
        })) as any;
        const items = (data?.items ?? data?.data ?? data ?? []) as any[];
        const norm = audit.toLowerCase().trim();
        const exact = items.find((a) => String(a.name).toLowerCase() === norm);
        const partial = items.filter((a) =>
          String(a.name).toLowerCase().includes(norm),
        );
        const chosen = exact ?? (partial.length === 1 ? partial[0] : null);
        if (!chosen) {
          if (partial.length === 0) {
            throw new ToolError(
              `No audit found matching "${audit}". Run konsulto_list_my_audits to see what's available.`,
            );
          }
          throw new ToolError(
            `Multiple audits match "${audit}": ${partial
              .map((a) => a.name)
              .join(', ')}. Use a more specific name or pass the audit ID.`,
          );
        }
        state.setActiveAudit({ id: String(chosen._id ?? chosen.id), name: chosen.name });
        return ok({
          activeAudit: state.getActiveAudit(),
          webUrl: client.webUrl(`/audits/${chosen._id ?? chosen.id}`),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    'konsulto_get_audit_context',
    'One-shot orientation tool — returns the active audit\'s name, status, ' +
      'dates, scope element count, asset count, finding severity rollup, and ' +
      'team. Call this at session start (after whoami) to ground yourself ' +
      'before doing work in the audit. Defaults to the active audit; pass ' +
      'audit to override.',
    {
      audit: z.string().optional().describe('Audit ID. Defaults to active audit.'),
    },
    async ({ audit }) => {
      try {
        const auditId = state.resolveAuditId(audit);
        const a = (await client.get<any>(`/audits/${auditId}`)) as any;
        return ok({
          audit: {
            id: String(a._id ?? a.id),
            name: a.name,
            status: a.status,
            startDate: a.startDate,
            endDate: a.endDate,
            description: a.description,
            severitySummary: a.severitySummary ?? null,
            maxSeverityOpen: a.maxSeverityOpen ?? null,
            scopeCount: Array.isArray(a.scopes) ? a.scopes.length : 0,
            assetCount: Array.isArray(a.assets) ? a.assets.length : 0,
            teamMembers: Array.isArray(a.teamMembers) ? a.teamMembers : [],
            tags: a.tags ?? [],
          },
          webUrl: client.webUrl(`/audits/${a._id ?? a.id}`),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    'konsulto_audit_summary',
    'Aggregate finding counts for an audit: total, breakdown by severity ' +
      '(critical/high/medium/low/informative), breakdown by status ' +
      '(open/accepted/mitigated/closed/rejected), recent activity (last 7d ' +
      'and 30d), and last-finding timestamp. Use this for "what is the ' +
      'state of this audit" orientation before search_findings or compose. ' +
      'Prefer over get_audit_context when you want live counts rather than ' +
      'audit metadata. Defaults to the active audit.',
    {
      audit: z.string().optional().describe('Audit ID. Defaults to active audit.'),
    },
    async ({ audit }) => {
      try {
        const auditId = state.resolveAuditId(audit);
        const summary = (await client.get<any>(`/audits/${auditId}/summary`)) as any;
        return ok({
          ...summary,
          webUrl: client.webUrl(`/audits/${auditId}`),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Templates (search-only — descriptions live on the server)
  // ---------------------------------------------------------------------------

  server.tool(
    'konsulto_search_templates',
    'Search the finding-template catalog. Returns a slim shape (id, title, ' +
      'severity, summary, slot names, taxonomy) — NOT the full template body. ' +
      'Use this to pick a template before calling konsulto_compose_finding. ' +
      'When multiple candidates match, prefer the one whose summary best fits ' +
      'the evidence in hand.',
    {
      q: z.string().optional().describe('Free-text search across title and aliases.'),
      severity: z
        .enum(['critical', 'high', 'medium', 'low', 'informative'])
        .optional(),
      limit: z.number().int().min(1).max(50).default(10).optional(),
    },
    async ({ q, severity, limit }) => {
      try {
        const params: Record<string, string> = {
          slim: '1',
          page: '1',
          limit: String(limit ?? 10),
        };
        if (q) params.search = q;
        if (severity) params.severity = severity;
        const data = (await client.get<any>('/finding-templates', { params })) as any;
        const items = data?.items ?? data?.data ?? data ?? [];
        return ok({ templates: items });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Findings — search, compose, update, bulk status
  // ---------------------------------------------------------------------------

  server.tool(
    'konsulto_search_findings',
    'Search findings within an audit. Defaults to the active audit when set. ' +
      'Returns titles, severities, statuses, and IDs — the body field is not ' +
      'included. Use to check for duplicates before creating a new finding ' +
      'and to find a specific finding to update or attach evidence to.',
    {
      audit: z.string().optional().describe('Audit ID. Defaults to active audit.'),
      q: z.string().optional().describe('Search across finding title.'),
      severity: z
        .enum(['critical', 'high', 'medium', 'low', 'informative'])
        .optional(),
      status: z
        .enum(['open', 'accepted', 'mitigated', 'closed', 'rejected'])
        .optional(),
      limit: z.number().int().min(1).max(100).default(25).optional(),
    },
    async ({ audit, q, severity, status, limit }) => {
      try {
        const auditId = state.resolveAuditId(audit);
        const params: Record<string, string> = {
          auditId,
          page: '1',
          limit: String(limit ?? 25),
        };
        if (q) params.search = q;
        if (severity) params.severity = severity;
        if (status) params.status = status;
        const data = (await client.get<any>('/findings', { params })) as any;
        const items = (data?.items ?? data?.data ?? data ?? []) as any[];
        return ok({
          findings: items.map((f) => ({
            id: String(f._id ?? f.id),
            title: f.title,
            severity: f.severity,
            status: f.status,
            createdAt: f.createdAt,
            webUrl: client.webUrl(`/audits/${auditId}/findings/${f._id ?? f.id}`),
          })),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    'konsulto_get_finding',
    'Read a single finding by ID, including its body rendered as markdown ' +
      'so the LLM can reason about the prose. Use when the user asks to ' +
      'review, explain, or summarize a specific finding. The body markdown ' +
      'is alongside the structured fields (severity, status, taxonomy, etc.).',
    {
      findingId: z.string(),
    },
    async ({ findingId }) => {
      try {
        const finding = (await client.get<any>(`/findings/${findingId}`)) as any;
        const bodyMarkdown = renderBodyMarkdownSafe(finding?.body?.blocks);
        return ok({
          finding: {
            id: String(finding._id ?? finding.id),
            title: finding.title,
            severity: finding.severity,
            status: finding.status,
            taxonomy: finding.taxonomy ?? {},
            assets: finding.assets ?? [],
            evidenceCount: Array.isArray(finding.evidenceBundleIds)
              ? finding.evidenceBundleIds.length
              : 0,
            createdAt: finding.createdAt,
            updatedAt: finding.updatedAt,
          },
          bodyMarkdown,
          webUrl: client.webUrl(
            `/audits/${finding.auditId}/findings/${finding._id ?? finding.id}`,
          ),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    'konsulto_read_section',
    'Read just one section of a finding\'s body as markdown. Use for ' +
      '"explain the POC", "summarize the impact", "show me the remediation". ' +
      'Cheaper context-wise than konsulto_get_finding when the user only ' +
      'cares about one section. Section name accepts aliases (recommendations, ' +
      'mitigation, summary, etc.) — they map to canonical names server-side.',
    {
      findingId: z.string(),
      section: z.string().describe(SECTION_DESCRIPTION),
    },
    async ({ findingId, section }) => {
      try {
        const canonical = normalizeSection(section);
        const finding = (await client.get<any>(`/findings/${findingId}`)) as any;
        const body = finding?.body?.blocks;
        if (!body || !Array.isArray(body.content)) {
          throw new ToolError(
            `Finding ${findingId} has no body content to read.`,
          );
        }
        const sectionMarkdown = extractSectionMarkdown(body, canonical);
        if (sectionMarkdown === null) {
          throw new ToolError(
            `No "${canonical}" section found in this finding. ` +
              `Use konsulto_get_finding to see the full body and which sections it has.`,
          );
        }
        return ok({
          findingId,
          section: canonical,
          markdown: sectionMarkdown,
          webUrl: client.webUrl(
            `/audits/${finding.auditId}/findings/${finding._id ?? finding.id}`,
          ),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    'konsulto_compose_finding',
    'Create a brand-new finding with a fully-formatted body. Author each ' +
      'section as Markdown in `sections` — the backend converts it to rich ' +
      'Tiptap (code blocks, tables, lists, links) so the finding looks like ' +
      'every other one on the audit. Call konsulto_get_finding_format FIRST to ' +
      'learn the exact sections + markdown rules for this audit. Do NOT pass ' +
      'Tiptap JSON, and do NOT repeat the section heading inside the markdown ' +
      '(the backend emits it). Evidence is grafted at the requested section ' +
      '("auto" walks poc → description → impact → remediation → end).',
    {
      audit: z.string().optional().describe('Audit ID. Defaults to active audit.'),
      templateId: z
        .string()
        .optional()
        .describe('Template to instantiate. Carries default severity, taxonomy.'),
      severity: z
        .enum(['critical', 'high', 'medium', 'low', 'informative'])
        .optional(),
      title: z.string().optional().describe('Finding title.'),
      sections: z
        .record(z.string())
        .optional()
        .describe(
          'Per-section GFM Markdown. Keys: description, poc, impact, ' +
            'remediation, references (aliases like "recommendation" accepted), ' +
            'plus any custom section from get_finding_format. Each value is ' +
            'markdown WITHOUT its own heading. This is the preferred input.',
        ),
      fields: z
        .object({
          title: z.string().optional(),
          summary: z.string().optional(),
          stepsToReproduce: z.array(z.string()).optional(),
          impact: z.string().optional(),
          remediation: z.string().optional(),
          references: z.array(z.any()).optional(),
        })
        .passthrough()
        .optional()
        .describe('DEPRECATED legacy flat prose. Prefer `sections` markdown.'),
      evidence: z
        .array(
          z.object({
            evidenceId: z.string(),
            caption: z.string().optional(),
            section: z
              .enum(['auto', 'description', 'poc', 'impact', 'remediation', 'references'])
              .optional(),
          }),
        )
        .optional(),
      assets: z.array(z.any()).optional(),
    },
    async ({ audit, templateId, severity, title, sections, fields, evidence, assets }) => {
      try {
        const auditId = state.resolveAuditId(audit);
        // Normalize section keys (recommendation → remediation, etc.) so the
        // LLM can use natural-language section names. Mirrors the backend's
        // alias map; unknown keys fall through for custom layout sections.
        const normSections = sections
          ? Object.fromEntries(
              Object.entries(sections).map(([k, v]) => [normalizeSection(k), v]),
            )
          : undefined;
        const mergedFields: Record<string, any> = { ...(fields ?? {}) };
        if (title) mergedFields.title = title;
        const body = {
          auditId,
          templateId,
          severity,
          sections: normSections,
          fields: mergedFields,
          evidence: evidence ?? [],
          assets: assets ?? [],
        };
        const created = (await client.post<any>('/findings/compose', body)) as any;
        return ok({
          finding: {
            id: String(created._id ?? created.id),
            title: created.title,
            severity: created.severity,
            status: created.status,
          },
          webUrl: client.webUrl(`/audits/${auditId}/findings/${created._id ?? created.id}`),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    'konsulto_get_finding_format',
    'Return the section structure + markdown authoring rules for composing a ' +
      'finding in this audit. Call this BEFORE konsulto_compose_finding so the ' +
      'body you author is fully formatted (code blocks, tables, lists, links) ' +
      'and matches every other finding. Pass templateId to get that ' +
      "template's sections plus a markdown starter to adapt.",
    {
      audit: z.string().optional().describe('Audit ID. Defaults to active audit.'),
      templateId: z
        .string()
        .optional()
        .describe('Template whose sections + markdown starter to return.'),
      layoutId: z.string().optional().describe('Explicit layout override.'),
    },
    async ({ audit, templateId, layoutId }) => {
      try {
        const auditId = state.resolveAuditId(audit);
        const params: Record<string, string> = { auditId };
        if (templateId) params.templateId = templateId;
        if (layoutId) params.layoutId = layoutId;
        const data = (await client.get<any>('/findings/compose-format', {
          params,
        })) as any;
        return ok(data);
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    'konsulto_update_finding',
    'Update scalar fields on an existing finding. Use this for changing ' +
      'title, severity, status, taxonomy, or assets — NOT for editing the ' +
      'prose body (use konsulto_append_to_section / konsulto_replace_section ' +
      'for that). NOT for evidence (use konsulto_add_evidence_to_finding).',
    {
      findingId: z.string(),
      patch: z
        .object({
          title: z.string().optional(),
          severity: z
            .enum(['critical', 'high', 'medium', 'low', 'informative'])
            .optional(),
          status: z
            .enum(['open', 'accepted', 'mitigated', 'closed', 'rejected'])
            .optional(),
          taxonomy: z.any().optional(),
          assets: z.array(z.any()).optional(),
        })
        .passthrough(),
    },
    async ({ findingId, patch }) => {
      try {
        const updated = (await client.put<any>(`/findings/${findingId}`, patch)) as any;
        return ok({
          finding: {
            id: String(updated._id ?? updated.id),
            title: updated.title,
            severity: updated.severity,
            status: updated.status,
          },
          webUrl: client.webUrl(
            `/audits/${updated.auditId}/findings/${updated._id ?? updated.id}`,
          ),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    'konsulto_bulk_update_status',
    'Change the status of many findings at once. Use for "client confirmed ' +
      'the fix on all of these" or "all stale findings should be closed". ' +
      'Set dryRun: true first to preview affected findings before committing.',
    {
      findingIds: z.array(z.string()).min(1),
      status: z.enum(['open', 'accepted', 'mitigated', 'closed', 'rejected']),
      dryRun: z.boolean().optional().default(false),
    },
    async ({ findingIds, status, dryRun }) => {
      try {
        if (dryRun) {
          // Pre-fetch the targets so the agent can show the user what will
          // change before they confirm. Backend has no native dry-run on the
          // bulk endpoint; this simulates it client-side.
          const fetched = await Promise.all(
            findingIds.map((id) => client.get<any>(`/findings/${id}`).catch(() => null)),
          );
          return ok({
            dryRun: true,
            wouldUpdate: fetched
              .filter((f) => f)
              .map((f: any) => ({
                id: String(f._id ?? f.id),
                title: f.title,
                currentStatus: f.status,
                newStatus: status,
              })),
            message:
              'Re-call with dryRun: false to apply. Show this list to the user first.',
          });
        }
        const result = (await client.post<any>('/findings/bulk-update-status', {
          ids: findingIds,
          updates: { status },
        })) as any;
        return ok({ result, count: findingIds.length, newStatus: status });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Evidence — upload + graft
  // ---------------------------------------------------------------------------

  server.tool(
    'konsulto_attach_evidence',
    'Upload a file (or inline content) as an attachment in the active audit. ' +
      'Returns an evidenceId. Pass the evidenceId to konsulto_add_evidence_to_finding ' +
      'or include it in konsulto_compose_finding\'s evidence array to graft it ' +
      'into a finding\'s body. This tool only uploads — it does NOT link to a ' +
      'finding by itself. Exactly one of filePath/content/contentBase64 must be set.',
    {
      audit: z.string().optional(),
      filePath: z
        .string()
        .optional()
        .describe('Local path to a file. The MCP reads it and uploads.'),
      content: z
        .string()
        .optional()
        .describe('Inline text content (e.g. nmap output, curl transcript).'),
      contentBase64: z
        .string()
        .optional()
        .describe('Inline binary as base64. Use for small images/files.'),
      filename: z
        .string()
        .optional()
        .describe('Suggested filename when using content/contentBase64. Defaults to evidence.txt / .bin.'),
      kind: z
        .enum(['transcript', 'command', 'screenshot', 'log', 'json', 'file'])
        .optional()
        .describe('Hint for how Konsulto should render this. Optional.'),
    },
    async ({ audit, filePath, content, contentBase64, filename, kind }) => {
      try {
        const auditId = state.resolveAuditId(audit);
        const provided = [filePath, content, contentBase64].filter(Boolean).length;
        if (provided !== 1) {
          throw new ToolError(
            'Exactly one of filePath, content, contentBase64 must be set.',
          );
        }

        let bytes: Buffer;
        let resolvedName: string;
        let mimeType: string;
        if (filePath) {
          bytes = await readFile(filePath);
          resolvedName = filename ?? basename(filePath);
          mimeType = guessMimeFromName(resolvedName);
        } else if (content !== undefined) {
          bytes = Buffer.from(content, 'utf8');
          resolvedName = filename ?? defaultFilenameForKind(kind, 'txt');
          mimeType = 'text/plain';
        } else {
          bytes = Buffer.from(contentBase64!, 'base64');
          resolvedName = filename ?? defaultFilenameForKind(kind, 'bin');
          mimeType = guessMimeFromName(resolvedName);
        }

        // 1) Get presigned URL.
        // `purpose` is an API enum — must be 'evidence.attachment' or
        // 'editor.derived', NOT the `kind` render hint. This tool is the
        // user-facing "attach a file to a finding" flow, so it always creates
        // an evidence attachment. Hardcoded (not a tool param) on purpose:
        // editor.derived is for AI-editor artifacts, a flow the MCP doesn't
        // expose. `kind` stays a separate rendering hint (filename + echo).
        const presign = (await client.post<any>('/attachments/presign-upload', {
          filename: resolvedName,
          mimeType,
          size: bytes.byteLength,
          auditId,
          purpose: 'evidence.attachment',
        })) as any;

        // 2) PUT to S3
        if (!presign?.uploadUrl) {
          throw new ToolError('Backend did not return a presigned uploadUrl');
        }
        const { default: axios } = await import('axios');
        await axios.put(presign.uploadUrl, bytes, {
          headers: { 'Content-Type': mimeType, ...(presign.requiredHeaders ?? {}) },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        });

        // 3) Register the upload — the backend's presign-upload endpoint
        // creates BOTH an Attachment (raw file metadata) and an
        // EvidenceItem (audit/tenant-scoped wrapper) and returns:
        //   { uploadUrl, requiredHeaders, key, bucket,
        //     attachment: <attachmentId>, evidenceItemId: <wrapperId> }
        //
        // We surface evidenceItemId as the canonical evidenceId because:
        //   - It's tenant- and audit-scoped (the attachment alone isn't).
        //   - It's what the backend's add-evidence-to-finding /
        //     compose-finding flows look up to validate ownership.
        //   - It's the right thing for activity-feed references.
        //
        // The legacy attachmentId/evidenceId/id fields stay as fallbacks
        // so older backends or alternative wirings don't break, but the
        // primary read is evidenceItemId.
        const evidenceId =
          presign.evidenceItemId ??
          presign.attachmentId ??
          presign.evidenceId ??
          presign.id ??
          null;
        if (!evidenceId) {
          throw new ToolError(
            'Upload succeeded but the backend did not return an evidence ID. ' +
              'Expected `evidenceItemId` in the presign-upload response.',
          );
        }

        return ok({
          evidenceId,
          filename: resolvedName,
          size: bytes.byteLength,
          mimeType,
          kind: kind ?? 'evidence',
          message:
            'Upload complete. Pass this evidenceId to konsulto_add_evidence_to_finding ' +
            'or include it in konsulto_compose_finding\'s evidence array.',
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    'konsulto_add_evidence_to_finding',
    'Graft an already-uploaded attachment into an existing finding\'s body ' +
      'at the named section. The "auto" section walks poc → description → ' +
      'impact → remediation → end-of-doc. Use this when adding evidence ' +
      'after the finding was created (e.g. screenshots taken later, additional ' +
      'reproduction logs).',
    {
      findingId: z.string(),
      evidenceId: z.string().describe('Returned by konsulto_attach_evidence.'),
      caption: z.string().optional(),
      section: z
        .string()
        .optional()
        .describe(
          `${SECTION_DESCRIPTION} Or use "auto" (default) to walk poc → description → impact → remediation → end-of-doc.`,
        ),
    },
    async ({ findingId, evidenceId, caption, section }) => {
      try {
        const resolvedSection = section
          ? section.toLowerCase().trim() === 'auto'
            ? 'auto'
            : normalizeSection(section)
          : 'auto';
        const updated = (await client.post<any>(
          `/findings/${findingId}/evidence`,
          { evidenceId, caption, section: resolvedSection },
        )) as any;
        return ok({
          findingId: String(updated._id ?? updated.id),
          webUrl: client.webUrl(
            `/audits/${updated.auditId}/findings/${updated._id ?? updated.id}`,
          ),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Section edits
  // ---------------------------------------------------------------------------

  server.tool(
    'konsulto_append_to_section',
    'Append markdown prose to a named section of a finding. Use this to add ' +
      'a paragraph or two without touching the rest of the finding. Content ' +
      'is markdown — paragraphs, lists, code blocks, links. The backend ' +
      'converts it to the finding\'s rich-text format.',
    {
      findingId: z.string(),
      section: z.string().describe(SECTION_DESCRIPTION),
      content: z.string().min(1).describe('Markdown to append.'),
    },
    async ({ findingId, section, content }) => {
      try {
        const canonical = normalizeSection(section);
        const updated = (await client.patch<any>(
          `/findings/${findingId}/sections/${canonical}`,
          { action: 'append', content },
        )) as any;
        return ok({
          findingId: String(updated._id ?? updated.id),
          section: canonical,
          action: 'append',
          webUrl: client.webUrl(
            `/audits/${updated.auditId}/findings/${updated._id ?? updated.id}`,
          ),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    'konsulto_replace_section',
    'Replace the entire prose under a named section. The previous content ' +
      'is preserved on the audit trail (recoverable). Prefer ' +
      'konsulto_append_to_section unless the user explicitly wants to ' +
      'rewrite the section. Content is markdown.',
    {
      findingId: z.string(),
      section: z.string().describe(SECTION_DESCRIPTION),
      content: z.string().describe('Markdown that replaces the section\'s current prose.'),
    },
    async ({ findingId, section, content }) => {
      try {
        const canonical = normalizeSection(section);
        const updated = (await client.patch<any>(
          `/findings/${findingId}/sections/${canonical}`,
          { action: 'replace', content },
        )) as any;
        return ok({
          findingId: String(updated._id ?? updated.id),
          section: canonical,
          action: 'replace',
          webUrl: client.webUrl(
            `/audits/${updated.auditId}/findings/${updated._id ?? updated.id}`,
          ),
          message:
            'Section replaced. Previous prose is on the finding\'s auditTrail entry for recovery.',
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Scope + assets
  // ---------------------------------------------------------------------------

  server.tool(
    'konsulto_list_scope',
    'List the scope elements for an audit — what\'s authorized to be tested. ' +
      'Use to confirm targets are in-scope before recording findings against ' +
      'them. Defaults to the active audit.',
    {
      audit: z.string().optional().describe('Audit ID. Defaults to active audit.'),
    },
    async ({ audit }) => {
      try {
        const auditId = state.resolveAuditId(audit);
        const scopes = (await client.get<any>(`/audits/${auditId}/scopes`)) as any;
        const items = Array.isArray(scopes) ? scopes : (scopes?.items ?? scopes?.data ?? []);
        return ok({
          auditId,
          scopes: items.map((s: any) => ({
            id: String(s._id ?? s.id),
            name: s.name,
            description: s.description,
            type: s.type ?? s.scopeType,
          })),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    'konsulto_list_assets',
    'List assets in the audit (or tenant-wide if no audit filter). Returns ' +
      'name, type, identifiers (hostname/ip/url/cidr) so you can match ' +
      'evidence to the right asset. Use konsulto_link_asset to attach an ' +
      'asset to a finding.',
    {
      audit: z.string().optional().describe('Audit ID. Omit to list across the tenant.'),
      q: z.string().optional().describe('Search by name.'),
      limit: z.number().int().min(1).max(100).default(25).optional(),
    },
    async ({ audit, q, limit }) => {
      try {
        const params: Record<string, string> = {
          page: '1',
          limit: String(limit ?? 25),
        };
        if (audit) params.auditId = audit;
        else if (state.getActiveAudit()) params.auditId = state.getActiveAudit()!.id;
        if (q) params.search = q;
        const data = (await client.get<any>('/assets', { params })) as any;
        const items = (data?.items ?? data?.data ?? data ?? []) as any[];
        return ok({
          assets: items.map((a) => ({
            id: String(a._id ?? a.id),
            name: a.name,
            type: a.type,
            subtype: a.subtype,
            identifiers: a.identifiers ?? {},
            tags: a.tags ?? [],
          })),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    'konsulto_create_asset',
    'Create a new asset in the active audit. Use when a scan or evidence ' +
      'reveals a host/URL/IP that isn\'t yet tracked. After creating, use ' +
      'konsulto_link_asset to attach it to a finding.',
    {
      audit: z.string().optional().describe('Audit ID. Defaults to active audit.'),
      name: z.string().min(1).describe('Display name (hostname, URL, IAM role name, etc.)'),
      type: z
        .string()
        .describe('Asset type (e.g. "host", "url", "iam-role", "s3-bucket"). Free-form — Konsulto stores it as-is.'),
      identifiers: z
        .object({
          hostname: z.string().optional(),
          ip: z.string().optional(),
          url: z.string().optional(),
          cidr: z.string().optional(),
          cloudResourceId: z.string().optional(),
        })
        .optional()
        .describe('Network/cloud identifiers used for cross-referencing.'),
      tags: z.array(z.string()).optional(),
      description: z.string().optional(),
    },
    async ({ audit, name, type, identifiers, tags, description }) => {
      try {
        const auditId = state.resolveAuditId(audit);
        const created = (await client.post<any>('/assets', {
          auditId,
          name,
          type,
          identifiers,
          tags,
          description,
        })) as any;
        return ok({
          asset: {
            id: String(created._id ?? created.id),
            name: created.name,
            type: created.type,
          },
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    'konsulto_link_asset',
    'Attach an asset to a finding. Tries to match an existing asset by name ' +
      '(case-insensitive substring); creates one if none matches. Then ' +
      'patches the finding\'s assets[] to include the reference. Use this ' +
      'when the user says "this finding affects acme.com:443" — the tool ' +
      'figures out whether to reuse an existing asset or make a new one.',
    {
      findingId: z.string(),
      assetHint: z
        .string()
        .describe('Asset name or identifier (hostname, URL, IP, etc.). Used for match-or-create.'),
      assetType: z
        .string()
        .optional()
        .default('host')
        .describe('Type to use when creating a new asset (host/url/ip/etc.).'),
    },
    async ({ findingId, assetHint, assetType }) => {
      try {
        const finding = (await client.get<any>(`/findings/${findingId}`)) as any;
        const auditId = String(finding?.auditId ?? '');

        // 1) Try to match an existing asset by name. Tenant-scoped via auth;
        // we use ?search= so the backend's text matching does the heavy lift.
        const data = (await client.get<any>('/assets', {
          params: { page: '1', limit: '5', search: assetHint, auditId },
        })) as any;
        const candidates = (data?.items ?? data?.data ?? data ?? []) as any[];
        const norm = assetHint.toLowerCase().trim();
        let asset =
          candidates.find((a) => String(a.name).toLowerCase() === norm) ??
          candidates.find((a) => String(a.name).toLowerCase().includes(norm)) ??
          null;

        // 2) Create if nothing matched.
        let created = false;
        if (!asset) {
          asset = (await client.post<any>('/assets', {
            auditId,
            name: assetHint,
            type: assetType ?? 'host',
          })) as any;
          created = true;
        }

        // 3) Patch the finding's assets[] to include this asset, dedupe by ref.
        const existing = Array.isArray(finding?.assets) ? finding.assets : [];
        const assetId = String(asset._id ?? asset.id);
        const already = existing.some(
          (a: any) => String(a?.ref ?? '') === assetId,
        );
        let updatedFinding = finding;
        if (!already) {
          const newAssets = [
            ...existing,
            { type: asset.type ?? assetType ?? 'host', ref: assetId },
          ];
          updatedFinding = (await client.put<any>(`/findings/${findingId}`, {
            assets: newAssets,
          })) as any;
        }
        return ok({
          findingId: String(updatedFinding._id ?? updatedFinding.id),
          asset: {
            id: assetId,
            name: asset.name,
            type: asset.type,
            created,
            alreadyLinked: already,
          },
          webUrl: client.webUrl(`/audits/${auditId}/findings/${findingId}`),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Helpers — normalize tool result shape
// ---------------------------------------------------------------------------

// Success result. JSON-stringify the payload as the text content because
// MCP tool results are flat content arrays — the LLM parses the JSON
// string back into structure on its side. Keep keys stable.
function ok(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

// Error result. Surface the actionable message, NOT a stack trace. We mark
// isError so MCP-aware clients can distinguish; the LLM still sees the
// text in any case.
function errResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
  };
}

function defaultFilenameForKind(kind: string | undefined, ext: string): string {
  const base = kind ? kind.replace(/[^a-z0-9-]/gi, '-') : 'evidence';
  return `${base}-${Date.now()}.${ext}`;
}

// Render a finding's body.blocks as markdown for the LLM to read.
// Wrapped — tiptap-converter throws on malformed docs and a server returning
// junk shouldn't take down the read tool.
function renderBodyMarkdownSafe(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  try {
    return toMarkdown(body as any);
  } catch {
    return '';
  }
}

// Extract the markdown for a single section of a finding's body. Walks
// the top-level content array, finds a heading whose lowercased text
// matches the requested canonical section (using the same alias logic as
// the backend's section-taxonomy.ts), and slices nodes from the heading
// to the next heading. Returns the markdown, or null when no matching
// heading exists in the doc.
function extractSectionMarkdown(body: any, sectionKey: string): string | null {
  if (!body?.content || !Array.isArray(body.content)) return null;

  const findHeading = (): number => {
    for (let i = 0; i < body.content.length; i++) {
      const node = body.content[i];
      if (node?.type !== 'heading') continue;
      const text = String(node?.content?.[0]?.text ?? '').toLowerCase().trim();
      if (sectionMatches(text, sectionKey)) return i;
    }
    return -1;
  };

  const headingIdx = findHeading();
  if (headingIdx < 0) return null;

  let endIdx = body.content.length;
  for (let i = headingIdx + 1; i < body.content.length; i++) {
    if (body.content[i]?.type === 'heading') {
      endIdx = i;
      break;
    }
  }

  const slice = body.content.slice(headingIdx, endIdx);
  try {
    return toMarkdown({ type: 'doc', content: slice });
  } catch {
    return '';
  }
}

// Mirrors the backend's headingMatchesSection in section-taxonomy.ts.
// Inlined here to keep the MCP free of cross-repo imports.
function sectionMatches(headingText: string, sectionKey: string): boolean {
  const norm = headingText.toLowerCase().trim();
  const exact = SECTION_ALIASES[norm];
  if (exact === sectionKey) return true;

  switch (sectionKey) {
    case 'poc':
      return (
        norm.includes('reproduce') ||
        norm.includes('proof of concept') ||
        norm.includes('poc') ||
        norm.includes('steps')
      );
    case 'description':
      return norm.includes('description') || norm.includes('summary');
    case 'impact':
      return norm.includes('impact');
    case 'remediation':
      return (
        norm.includes('remediation') ||
        norm.includes('recommendation') ||
        norm.includes('mitigation') ||
        norm.includes('solution') ||
        norm.includes('fix')
      );
    case 'references':
      return (
        norm.includes('reference') ||
        norm.includes('link') ||
        norm.includes('source')
      );
    default:
      return false;
  }
}

function guessMimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.log') || lower.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}
