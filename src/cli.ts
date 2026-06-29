#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stringify as stringifyYaml } from 'yaml';
import { ApiClient } from './auth/api-client.js';
import { CredentialError, loadCredentials } from './auth/token-loader.js';
import { loadWorkspaceConfig } from './context/workspace-config.js';

// Helper CLI dispatched from the same `mcp` binary as the stdio MCP
// server. Subcommands:
//
//   npx @konsulto/mcp login    — save token to ~/.konsulto/credentials
//   npx @konsulto/mcp init     — interactive .konsulto.yml writer
//   npx @konsulto/mcp whoami   — verify token, show identity + permissions
//   npx @konsulto/mcp doctor   — sanity-check creds, token, reachability
//
// Dispatch happens in index.ts when argv[2] is in CLI_SUBCOMMANDS. When
// these run, stdout is the user's terminal (NOT the MCP transport) so
// console.log is safe.

export const CLI_SUBCOMMANDS = new Set([
  'login',
  'init',
  'whoami',
  'doctor',
  'help',
  '-h',
  '--help',
]);

export async function runCli(): Promise<void> {
  const [, , subcommand, ...args] = process.argv;
  switch (subcommand) {
    case 'login':
      await runLogin(args);
      break;
    case 'init':
      await runInit();
      break;
    case 'whoami':
      await runWhoami();
      break;
    case 'doctor':
      await runDoctor();
      break;
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      printHelp();
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      printHelp();
      process.exit(2);
  }
}

function printHelp(): void {
  console.log(
    [
      '@konsulto/mcp — Konsulto MCP server + helper CLI',
      '',
      'Default (no args): runs the stdio MCP server (spawned by Claude Code).',
      '',
      'Helper subcommands:',
      '  npx @konsulto/mcp login <token> [--endpoint <url>]',
      '                             Save your MCP token to ~/.konsulto/credentials',
      '  npx @konsulto/mcp init     Pin the current folder to a Konsulto audit',
      '  npx @konsulto/mcp whoami   Show identity, permissions, active audit',
      '  npx @konsulto/mcp doctor   Verify credentials, token, MCP feature, network',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

// Non-interactive credentials writer so users connect with one copy-pasted
// line on any OS — no shell-specific mkdir/here-doc/chmod. Mirrors the token
// rules and 0600/0700 modes that token-loader/doctor expect.
const MCP_PREFIX = 'kon_mcp_';
const TENANT_PREFIX = 'kon_live_';
const DEFAULT_ENDPOINT = 'https://api.konsulto.io';

async function runLogin(args: string[]): Promise<void> {
  let token: string | undefined;
  let endpoint: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--endpoint' || a === '-e') {
      endpoint = args[++i];
    } else if (a.startsWith('--endpoint=')) {
      endpoint = a.slice('--endpoint='.length);
    } else if (a === '--force' || a === '-f') {
      force = true;
    } else if (!a.startsWith('-') && token === undefined) {
      token = a;
    }
  }

  token = token?.trim();
  if (!token) {
    console.error(
      'Usage: npx @konsulto/mcp login <kon_mcp_token> [--endpoint <url>] [--force]',
    );
    process.exit(2);
  }

  // Same guardrails as token-loader's assertMcpToken, surfaced before we
  // write so a wrong token never lands on disk.
  if (token.startsWith(TENANT_PREFIX)) {
    console.error(
      `This token (${token.slice(0, 12)}…) is a tenant integration key, not an ` +
        'MCP token. Mint an MCP token under Profile → MCP Tokens in the Konsulto web app.',
    );
    process.exit(1);
  }
  if (!token.startsWith(MCP_PREFIX)) {
    console.error(
      `Token does not look like a Konsulto MCP token (expected prefix ${MCP_PREFIX}). ` +
        'Mint one under Profile → MCP Tokens in the Konsulto web app.',
    );
    process.exit(1);
  }

  const dir = join(homedir(), '.konsulto');
  const filePath = join(dir, 'credentials');

  if (existsSync(filePath) && !force) {
    console.error(
      `${filePath} already exists. Re-run with --force to overwrite it, or edit the file by hand.`,
    );
    process.exit(1);
  }

  // Endpoint is written only when overriding the default, keeping the file
  // minimal for the common shared-API case.
  const doc: Record<string, string> = { token };
  const resolvedEndpoint = endpoint?.trim();
  if (resolvedEndpoint && resolvedEndpoint !== DEFAULT_ENDPOINT) {
    doc.endpoint = resolvedEndpoint;
  }

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(filePath, stringifyYaml(doc), { mode: 0o600 });
    // writeFileSync's mode is masked by umask and only applies on creation,
    // so chmod explicitly — this also tightens an overwritten loose-mode file.
    chmodSync(filePath, 0o600);
  } catch (err) {
    console.error(
      `Could not write ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  console.log(`Saved ${maskToken(token)} to ${filePath}`);
  console.log(`Endpoint: ${resolvedEndpoint ?? `${DEFAULT_ENDPOINT} (default)`}`);
  console.log('\nNext: add the Konsulto MCP server to your AI tool, then run');
  console.log('  npx @konsulto/mcp whoami');
  console.log('to confirm the connection.');
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

async function runInit(): Promise<void> {
  const cwd = process.cwd();
  const target = join(cwd, '.konsulto.yml');

  if (existsSync(target)) {
    console.error(`A .konsulto.yml already exists at ${target}. Edit it manually or delete it first.`);
    process.exit(1);
  }

  let creds;
  try {
    creds = loadCredentials();
  } catch (err) {
    console.error(err instanceof CredentialError ? err.message : String(err));
    process.exit(1);
  }

  const client = new ApiClient(creds);

  console.log('Loading your audits…');
  let audits: any[];
  try {
    const data = (await client.get<any>('/audits', {
      params: { page: '1', limit: '100', memberOnly: 'true' },
    })) as any;
    audits = (data?.items ?? data?.data ?? data ?? []) as any[];
  } catch (err) {
    console.error(`Could not list audits: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (audits.length === 0) {
    console.error(
      'No audits found for this user. Create or join an audit first, then run npx @konsulto/mcp init again.',
    );
    process.exit(1);
  }

  console.log('\nWhich audit should this folder be pinned to?\n');
  audits.forEach((a, i) => {
    console.log(`  [${i + 1}] ${a.name}  (${a.status ?? 'unknown'})`);
  });
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Choose [1-' + audits.length + ']: ')).trim();
  rl.close();

  const idx = parseInt(answer, 10) - 1;
  if (!Number.isFinite(idx) || idx < 0 || idx >= audits.length) {
    console.error('Invalid selection.');
    process.exit(1);
  }
  const chosen = audits[idx];

  // Endpoint: written only when overriding the credentials default. Keeps
  // the file minimal — sharable across the team without leaking custom
  // dev/test endpoints into prod folders.
  const config: Record<string, string> = {
    audit: String(chosen._id ?? chosen.id),
  };

  writeFileSync(target, stringifyYaml(config), { mode: 0o644 });
  console.log(`\nWrote ${target}`);
  console.log(`Pinned to audit "${chosen.name}".`);
  console.log(
    'When you launch Claude Code from this folder (or any subfolder), the MCP server will auto-pin this audit.',
  );
}

// ---------------------------------------------------------------------------
// whoami
// ---------------------------------------------------------------------------

async function runWhoami(): Promise<void> {
  let creds;
  try {
    creds = loadCredentials();
  } catch (err) {
    console.error(err instanceof CredentialError ? err.message : String(err));
    process.exit(1);
  }

  const workspace = loadWorkspaceConfig();
  if (workspace?.endpoint) {
    creds = { ...creds, endpoint: workspace.endpoint };
  }
  const client = new ApiClient(creds);

  console.log(`Endpoint:    ${creds.endpoint}`);
  console.log(`Token:       ${maskToken(creds.token)} (from ${creds.source}${creds.filePath ? `: ${creds.filePath}` : ''})`);

  let profile: any;
  try {
    profile = await client.get<any>('/users/profile');
  } catch (err) {
    console.error(`\nCould not load profile: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(`\nUser:        ${profile?.username ?? '(unknown)'}  <${profile?.email ?? ''}>`);
  console.log(`Tenant:      ${profile?.tenantId ?? ''}`);
  const mcpEnabled = profile?.tenantFeatures?.mcp?.enabled;
  console.log(`Tenant MCP:  ${mcpEnabled ? 'enabled' : 'disabled'}`);

  const perms: string[] = profile?.resolvedPermissions ?? [];
  if (perms.includes('*')) {
    console.log('Permissions: * (full access)');
  } else {
    console.log(`Permissions: ${perms.length} scopes`);
    if (perms.length > 0) {
      const grouped = groupBy(perms, (p) => p.split(':')[0]);
      for (const [resource, list] of Object.entries(grouped)) {
        console.log(`  ${resource}: ${list.map((p) => p.split(':')[1] ?? p).join(', ')}`);
      }
    }
  }

  if (workspace?.audit) {
    console.log(`\nWorkspace:   pinned to audit "${workspace.audit}" (from ${workspace.configPath})`);
  } else {
    console.log('\nWorkspace:   no .konsulto.yml — no folder-level audit pin');
  }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

async function runDoctor(): Promise<void> {
  let failed = 0;

  // 1) Credentials present
  let creds;
  try {
    creds = loadCredentials();
    console.log(`✓ credentials loaded from ${creds.source}${creds.filePath ? `: ${creds.filePath}` : ''}`);
  } catch (err) {
    console.error(`✗ credentials: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // 2) Credentials file mode (only if from file)
  if (creds.source === 'file' && creds.filePath) {
    try {
      const mode = statSync(creds.filePath).mode & 0o777;
      const padded = mode.toString(8).padStart(3, '0');
      if (mode & 0o077) {
        console.error(`✗ credentials file mode is ${padded}; expected 600. Fix: chmod 600 ${creds.filePath}`);
        failed++;
      } else {
        console.log(`✓ credentials file mode is ${padded} (private)`);
      }
    } catch (err) {
      console.error(`✗ could not stat credentials file: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  // 3) ~/.konsulto directory mode
  const konsultoDir = join(homedir(), '.konsulto');
  if (existsSync(konsultoDir)) {
    try {
      const mode = statSync(konsultoDir).mode & 0o777;
      if (mode & 0o077) {
        console.error(`✗ ~/.konsulto directory is mode ${mode.toString(8).padStart(3, '0')}; expected 700. Fix: chmod 700 ${konsultoDir}`);
        failed++;
      } else {
        console.log(`✓ ~/.konsulto directory mode is ${mode.toString(8).padStart(3, '0')} (private)`);
      }
    } catch {
      // non-fatal
    }
  }

  // 4) Token validity (auth/profile)
  const client = new ApiClient(creds);
  try {
    const profile = (await client.get<any>('/users/profile')) as any;
    console.log(`✓ token authenticates as ${profile?.username ?? '(unknown)'}`);
    if (profile?.tenantFeatures?.mcp?.enabled === false) {
      console.error('✗ tenant has MCP integration DISABLED. Ask an admin to enable it under Account → API Access.');
      failed++;
    } else {
      console.log('✓ tenant has MCP integration enabled');
    }
    const perms: string[] = profile?.resolvedPermissions ?? [];
    if (perms.includes('*') || perms.includes('mcp:use')) {
      console.log('✓ user has mcp:use permission');
    } else {
      console.error('✗ user role does not include mcp:use. Ask an admin to grant it.');
      failed++;
    }
  } catch (err) {
    console.error(`✗ profile request failed: ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }

  // 5) Workspace config (informational)
  const ws = loadWorkspaceConfig();
  if (ws) {
    console.log(`✓ workspace pinned via ${ws.configPath}: audit=${ws.audit ?? '(unset)'}`);
  } else {
    console.log('· no .konsulto.yml in cwd or any parent (folder pin disabled — fine if intentional)');
  }

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll checks passed. The MCP server should work in Claude Code.');
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function maskToken(token: string): string {
  if (token.length < 16) return '***';
  return `${token.slice(0, 12)}…${token.slice(-4)}`;
}

function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

// (no top-level invocation — index.ts dispatches to runCli when argv[2]
// is in CLI_SUBCOMMANDS).
