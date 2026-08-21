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

// User allowlist — emails mapped to roles
export const USERS: Record<string, Role> = {
  'user@example.com': 'full',
  'other@example.com': 'readonly',
};

export const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3002;
export const HOST = process.env.HOST || '127.0.0.1';
export const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
export const BUNDLES_FILE = new URL(
  process.env.NOTEBOOK_BUNDLES_FILE ?? './bundles.json',
  import.meta.url,
);

// Determine the base URL for OAuth callback (from request in auth route)
export const OAUTH_CALLBACK_PATH = '/api/notebook/auth/google/callback';

// --- Daily digest configuration ---------------------------------------------
//
// The scheduler scans every bundle once a day at DIGEST_CRON (default 8am in
// DIGEST_TZ, which defaults to Asia/Taipei to match the date convention used
// in the chat system prompt). The LLM runs with read-only tools; if it finds
// anything actionable within the next 24h, an email summary is sent to
// DIGEST_TO via the local Postfix SMTP (server/lib/mailer.ts).
//
// Set DIGEST_DISABLED=1 to turn the scheduler off entirely (e.g. in dev).
// Set DIGEST_TO to enable; if empty, the scheduler starts but no-ops each tick.
export const DIGEST_DISABLED = process.env.DIGEST_DISABLED === '1';
export const DIGEST_TO = process.env.DIGEST_TO || '';
export const DIGEST_CRON = process.env.DIGEST_CRON || '0 8 * * *';
export const DIGEST_TZ = process.env.DIGEST_TZ || 'Asia/Taipei';
