export interface BundleConfig {
  id: string;
  name: string;
  path: string;
  icon: string;
  description: string;
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
};

export const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3002;
export const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
export const BUNDLES_FILE = new URL('./bundles.json', import.meta.url);

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
