export interface DigestConfig {
  /** Daily digest for this bundle. `undefined`/`true` = enabled (default). */
  enabled?: boolean;
  /**
   * Run an OKF maintenance pass before the daily digest: the LLM organizes,
   * deduplicates, and validates the .md files against the bundle's OKF.md
   * spec, then commits the changes before the digest review runs.
   * `undefined`/`false` = off (default).
   */
  cleanup?: boolean;
  /**
   * Email of the Google account whose Calendar/Gmail the digest may read
   * via gw_ MCP tools (per-notebook). Empty/undefined = no Google access.
   * The account must have logged in once (Workspace tokens on disk).
   */
  googleUser?: string;
}

export interface BundleConfig {
  id: string;
  name: string;
  path: string;
  icon: string;
  description: string;
  /** Emails of readonly users allowed to see this bundle. `full` users see everything. */
  allowedUsers?: string[];
  /**
   * MCP server names enabled for this bundle. `undefined` = all configured
   * servers (default); `[]` = none. Validated against the configured servers
   * in `MCP_SERVERS` at save time.
   */
  mcps?: string[];
  /** Daily digest settings for this bundle. `undefined` = defaults (enabled, no Google). */
  digest?: DigestConfig;
}

export type Role = 'readonly' | 'full';

export interface User {
  email: string;
  name: string;
  picture?: string;
  role: Role;
}

/**
 * User allowlist — emails mapped to roles — from the `NOTEBOOK_USERS` env var:
 *
 *   NOTEBOOK_USERS=alice@example.com:full,bob@example.com:readonly
 *
 * Entries are `email:role` (or `email=role`), separated by commas, semicolons,
 * or newlines. Emails are lowercased; unknown roles are rejected with a warning
 * at startup. An empty/absent var means nobody can log in (with OAuth
 * credentials set, every login is denied).
 */
export function parseUsers(raw: string | undefined): Record<string, Role> {
  const users: Record<string, Role> = {};
  if (!raw) return users;
  for (const entry of raw.split(/[,;\n]+/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(.+?)\s*[:=]\s*(readonly|full)$/i);
    if (!match) {

      console.warn(`[config] Ignoring malformed NOTEBOOK_USERS entry: ${JSON.stringify(trimmed)}`);
      continue;
    }
    users[match[1]!.trim().toLowerCase()] = match[2]!.toLowerCase() as Role;
  }
  return users;
}

export const USERS: Record<string, Role> = parseUsers(process.env.NOTEBOOK_USERS);

export const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3002;
export const HOST = process.env.HOST || '127.0.0.1';
export const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
export const BUNDLES_FILE = new URL(
  process.env.NOTEBOOK_BUNDLES_FILE ?? './bundles.json',
  import.meta.url,
);

// The timezone used for the chat system prompt's "current date/time" stamp
// and as the default for the digest scheduler. Defaults to the server's own
// timezone; set TIMEZONE (any IANA name, e.g. "Europe/Paris") to override.
export const TIMEZONE =
  process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// Determine the base URL for OAuth callback (from request in auth route)
export const OAUTH_CALLBACK_PATH = '/api/notebook/auth/google/callback';

// --- Daily digest configuration ---------------------------------------------
//
// The scheduler scans every bundle once a day at DIGEST_CRON (default 8am in
// DIGEST_TZ, which defaults to TIMEZONE). The LLM runs with read-only tools;
// if it finds anything actionable within the next 24h, an email summary is
// sent to DIGEST_TO via the local SMTP relay (server/lib/mailer.ts — host and
// port configurable via DIGEST_SMTP_HOST / DIGEST_SMTP_PORT).
//
// Set DIGEST_DISABLED=1 to turn the scheduler off entirely (e.g. in dev).
// Set DIGEST_TO to enable; if empty, the scheduler starts but no-ops each tick.
export const DIGEST_DISABLED = process.env.DIGEST_DISABLED === '1';
export const DIGEST_TO = process.env.DIGEST_TO || '';
/** From address for digest emails. Default: notebook-digest@<hostname>. */
export const DIGEST_FROM = process.env.DIGEST_FROM || '';
export const DIGEST_CRON = process.env.DIGEST_CRON || '0 8 * * *';
export const DIGEST_TZ = process.env.DIGEST_TZ || TIMEZONE;
/** Local SMTP relay for digest emails (unauthenticated submission). */
export const DIGEST_SMTP_HOST = process.env.DIGEST_SMTP_HOST || '127.0.0.1';
export const DIGEST_SMTP_PORT = process.env.DIGEST_SMTP_PORT ? parseInt(process.env.DIGEST_SMTP_PORT) : 25;
