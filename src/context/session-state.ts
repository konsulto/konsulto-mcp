// In-memory session state for the MCP server process. Lives for the
// lifetime of the spawned server (i.e. until Claude Code exits or
// disconnects). NOT persisted across sessions — the .konsulto.yml file is
// the persistence mechanism for "active audit", deliberately, so audit
// state lives next to the engagement folder it belongs to.

export type ActiveAudit = {
  id: string;
  // Cached display name for log output and "current audit" surfacing in
  // whoami. Populated when set_active_audit resolves a fuzzy match.
  name?: string;
};

export class SessionState {
  private activeAudit: ActiveAudit | null = null;

  setActiveAudit(audit: ActiveAudit): void {
    this.activeAudit = audit;
  }

  clearActiveAudit(): void {
    this.activeAudit = null;
  }

  getActiveAudit(): ActiveAudit | null {
    return this.activeAudit;
  }

  // Convenience used by tools that take an optional audit override —
  // returns the resolved audit ID with a clear error path when neither
  // an explicit override nor an active audit is set. The thrown message
  // is agent-actionable.
  resolveAuditId(override?: string): string {
    if (override && override.trim()) return override.trim();
    if (this.activeAudit) return this.activeAudit.id;
    throw new Error(
      'No active audit. Either pass an explicit "audit" argument, ' +
        'call konsulto_set_active_audit({audit: "<name or id>"}) first, ' +
        'or run from a folder with a .konsulto.yml that pins an audit.',
    );
  }
}
