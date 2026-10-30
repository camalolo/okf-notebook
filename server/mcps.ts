/**
 * MCP server registry — runtime configuration (not code).
 *
 * MCP servers used to be hardcoded in server/index.ts; they are now data,
 * managed from the Settings UI ("MCP servers") and persisted to
 * `server/data/mcps.json` so the set survives deploys. Nothing is shipped by
 * default — a fresh install starts with zero MCP servers.
 *
 * ⚠️ Configs contain arbitrary `command` lines (and optional `env` secrets);
 * they are only editable by `full`-role users (routes/mcps.ts). Remote
 * servers (`url`) use OAuth 2.0 — see lib/mcp-oauth.ts.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { McpServerConfig } from './lib/mcp-manager.js';

const MCPS_PATH = process.env.NOTEBOOK_MCPS_FILE
  ? path.resolve(process.env.NOTEBOOK_MCPS_FILE)
  : path.join(import.meta.dirname, 'data', 'mcps.json');

/** Read the registry from disk, seeding an empty file on first run. */
export async function loadMcpServers(): Promise<McpServerConfig[]> {
  try {
    const raw = await fs.readFile(MCPS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('mcps.json must contain an array of server configs');
    }
    // Re-validate persisted entries defensively (hand-edited file).
    return parsed.map((c) => sanitizeMcpConfig(c));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(
        `[mcp] No ${MCPS_PATH} — starting with no MCP servers. ` +
          'Add one from Settings → MCP servers.',
      );
      await saveMcpServers([]);
      return [];
    }
    throw err;
  }
}

/** Write the registry to disk. */
export async function saveMcpServers(servers: McpServerConfig[]): Promise<void> {
  await fs.mkdir(path.dirname(MCPS_PATH), { recursive: true });
  await fs.writeFile(MCPS_PATH, JSON.stringify(servers, null, 2) + '\n', 'utf8');
}

export type McpErrorCode =
  | 'INVALID_NAME'
  | 'DUPLICATE_NAME'
  | 'INVALID_COMMAND'
  | 'INVALID_ARGS'
  | 'INVALID_ENV'
  | 'INVALID_URL'
  | 'INVALID_SCOPES'
  | 'INVALID_TOOL_PREFIX'
  | 'INVALID_ALLOW_TOOLS'
  | 'NOT_FOUND';

export class McpError extends Error {
  code: McpErrorCode;
  constructor(message: string, code: McpErrorCode) {
    super(message);
    this.name = 'McpError';
    this.code = code;
  }
}

/** Server names are lowercase slugs (used as bundle.mcps ids and log tags). */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** OAuth scope tokens (e.g. `mcp.read`, `gmail.modify`). */
const SCOPE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;

/** Validate a remote MCP endpoint URL (streamable-HTTP transport). */
function sanitizeUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new McpError('url must be a non-empty string', 'INVALID_URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new McpError(`url is not a valid URL: ${raw.trim()}`, 'INVALID_URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new McpError('url must use http or https', 'INVALID_URL');
  }
  if (parsed.username || parsed.password) {
    throw new McpError('url must not embed credentials', 'INVALID_URL');
  }
  return parsed.toString();
}

/**
 * Normalize/validate an MCP server config from untrusted input (Settings UI)
 * or a hand-edited mcps.json. Returns a fresh, clean object.
 *
 * A server is either a child process (`command` [+ `args`/`env`]) or a
 * remote endpoint (`url` [+ `scopes`]) — never both, never neither.
 */
export function sanitizeMcpConfig(raw: unknown): McpServerConfig {
  if (raw === null || typeof raw !== 'object') {
    throw new McpError('MCP server config must be an object', 'INVALID_COMMAND');
  }
  const { name, command, args, env, url, scopes, toolPrefix, allowTools, perUser } = raw as {
    name?: unknown;
    command?: unknown;
    args?: unknown;
    env?: unknown;
    url?: unknown;
    scopes?: unknown;
    toolPrefix?: unknown;
    allowTools?: unknown;
    perUser?: unknown;
  };

  if (typeof name !== 'string' || !NAME_RE.test(name.trim())) {
    throw new McpError(
      'Name must be a lowercase slug (letters, digits, dashes), e.g. "google-workspace"',
      'INVALID_NAME',
    );
  }

  const hasCommand = typeof command === 'string' && command.trim() !== '';
  const hasUrl = url !== undefined && url !== null && url !== '';
  if (hasCommand === hasUrl) {
    throw new McpError(
      'Provide either a command (stdio server) or a url (remote HTTP server), not both/neither',
      'INVALID_COMMAND',
    );
  }

  let cleanUrl: string | undefined;
  if (hasUrl) cleanUrl = sanitizeUrl(url);

  let cleanArgs: string[] = [];
  if (args !== undefined && args !== null) {
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      throw new McpError('args must be an array of strings (one argument per entry)', 'INVALID_ARGS');
    }
    cleanArgs = args;
  }

  let cleanEnv: Record<string, string> | undefined;
  if (env !== undefined && env !== null) {
    if (
      typeof env !== 'object' ||
      Array.isArray(env) ||
      Object.entries(env).some(
        ([k, v]) => !k.trim() || typeof v !== 'string',
      )
    ) {
      throw new McpError('env must be an object of string → string', 'INVALID_ENV');
    }
    cleanEnv = Object.fromEntries(
      Object.entries(env as Record<string, string>).map(([k, v]) => [k, v]),
    );
  }

  let cleanPrefix: string | undefined;
  if (toolPrefix !== undefined && toolPrefix !== null && toolPrefix !== '') {
    if (typeof toolPrefix !== 'string' || !NAME_RE.test(toolPrefix.trim())) {
      throw new McpError('Tool prefix must be a slug (letters, digits, dashes)', 'INVALID_TOOL_PREFIX');
    }
    cleanPrefix = toolPrefix.trim();
  }

  let cleanAllow: string[] | undefined;
  if (allowTools !== undefined && allowTools !== null) {
    if (!Array.isArray(allowTools) || allowTools.some((t) => typeof t !== 'string' || !t.trim())) {
      throw new McpError(
        'allowTools must be an array of tool names (empty = expose all discovered tools)',
        'INVALID_ALLOW_TOOLS',
      );
    }
    cleanAllow = [...new Set((allowTools as string[]).map((t) => t.trim()))].filter(Boolean);
  }

  if (perUser !== undefined && perUser !== null && typeof perUser !== 'boolean') {
    throw new McpError('perUser must be a boolean', 'INVALID_COMMAND');
  }
  if (perUser === true && cleanUrl) {
    throw new McpError('perUser applies to stdio servers only', 'INVALID_COMMAND');
  }

  let cleanScopes: string[] | undefined;
  if (scopes !== undefined && scopes !== null) {
    if (
      !Array.isArray(scopes) ||
      scopes.some((s) => typeof s !== 'string' || !s.trim() || !SCOPE_RE.test(s.trim()))
    ) {
      throw new McpError(
        'scopes must be an array of scope tokens (e.g. ["mcp.read"])',
        'INVALID_SCOPES',
      );
    }
    const cleaned = [...new Set((scopes as string[]).map((s) => s.trim()))].filter(Boolean);
    if (cleaned.length > 0) cleanScopes = cleaned;
  }

  return {
    name: name.trim(),
    ...(cleanUrl
      ? { url: cleanUrl }
      : { command: (command as string).trim(), args: cleanArgs }),
    ...(cleanEnv ? { env: cleanEnv } : {}),
    ...(cleanScopes ? { scopes: cleanScopes } : {}),
    ...(cleanPrefix ? { toolPrefix: cleanPrefix } : {}),
    ...(cleanAllow ? { allowTools: cleanAllow } : {}),
    ...(perUser === true ? { perUser: true } : {}),
  };
}

/** Add a server after checking name uniqueness; persists the registry. */
export async function addMcpServer(raw: unknown): Promise<McpServerConfig> {
  const config = sanitizeMcpConfig(raw);
  const servers = await loadMcpServers();
  if (servers.some((s) => s.name === config.name)) {
    throw new McpError(`An MCP server named "${config.name}" already exists`, 'DUPLICATE_NAME');
  }
  servers.push(config);
  await saveMcpServers(servers);
  return config;
}

/**
 * Update a server's config (name is immutable — bundles reference servers by
 * name in `bundle.mcps`); persists the registry.
 */
export async function updateMcpServer(
  name: string,
  raw: unknown,
): Promise<McpServerConfig> {
  const next = sanitizeMcpConfig({ ...(raw as object), name }); // force the immutable name
  const servers = await loadMcpServers();
  const idx = servers.findIndex((s) => s.name === name);
  if (idx === -1) {
    throw new McpError(`MCP server not found: ${name}`, 'NOT_FOUND');
  }
  servers[idx] = next;
  await saveMcpServers(servers);
  return next;
}

/** Remove a server from the registry (the running child is stopped by the manager). */
export async function removeMcpServer(name: string): Promise<void> {
  const servers = await loadMcpServers();
  const next = servers.filter((s) => s.name !== name);
  if (next.length === servers.length) {
    throw new McpError(`MCP server not found: ${name}`, 'NOT_FOUND');
  }
  await saveMcpServers(next);
}
