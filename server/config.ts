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
