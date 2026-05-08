import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';
import { parse as parseYaml } from 'yaml';

// Walks UP from cwd (or a provided start path) looking for a .konsulto.yml,
// just like git finds .git. Returns null if not found — the caller falls
// back to env-only config.
//
// Format (no secrets):
//   audit: <auditId or audit slug>
//   endpoint: https://api.konsulto.io  # optional; overrides credentials file
//
// Sharable across a team via git/dropbox — the file pins the folder to
// a specific audit so a pentester running Claude Code in
// ~/audits/acme-q2-pentest/ doesn't have to think about audit IDs.

export type WorkspaceConfig = {
  audit?: string;
  endpoint?: string;
  // Path of the .konsulto.yml that was loaded. Surfaced in `whoami` so the
  // user can see why an audit pin appeared without having to dig.
  configPath: string;
};

const FILENAME = '.konsulto.yml';

export function loadWorkspaceConfig(startDir?: string): WorkspaceConfig | null {
  const start = startDir ?? process.cwd();
  const found = findUpward(start, FILENAME);
  if (!found) return null;

  let raw: string;
  try {
    raw = readFileSync(found, 'utf8');
  } catch {
    // File present but unreadable — silently fall back to no-config rather
    // than failing server start. The user can `konsulto doctor` to see why.
    return null;
  }

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;

  const obj = doc as Record<string, unknown>;
  const audit = typeof obj.audit === 'string' ? obj.audit.trim() : undefined;
  const endpoint =
    typeof obj.endpoint === 'string' ? obj.endpoint.trim() : undefined;

  return {
    audit: audit || undefined,
    endpoint: endpoint || undefined,
    configPath: found,
  };
}

// Walk from `start` upward to the filesystem root, returning the first
// path where `name` exists. Mirrors the lookup loop git uses; safe at root
// because parsePath(root).root === root and we break when we don't make
// progress.
function findUpward(start: string, name: string): string | null {
  let dir = start;
  while (true) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null; // hit filesystem root
    if (parent === parsePath(parent).root && !existsSync(join(parent, name))) {
      return null;
    }
    dir = parent;
  }
}
