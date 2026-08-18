/**
 * Google Workspace MCP authentication helper — per-user.
 *
 * The @alanxchen/google-workspace-mcp package stores its OAuth tokens in
 * `<homedir>/.google-workspace-mcp/{token,credentials}.json`, where homedir()
 * follows $HOME on Linux. Instead of relying on the MCP's own OAuth flow (which
 * opens a browser on the server), we capture tokens from the Notebook app's
 * Google OAuth login and write them to a per-user directory that also serves
 * as the $HOME of that user's dedicated MCP child process. Each logged-in user
 * therefore gets their own Google account inside the MCP — no more
 * last-user-to-login wins.
 *
 * Layout (runtime data, preserved across deploys):
 *   server/data/workspace-auth/<sanitized-email>/
 *     .google-workspace-mcp/{token,credentials}.json
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from '../config.js';

/** Root dir holding one subdir per user. Sits next to sessions (preserved on deploy). */
export const WORKSPACE_AUTH_ROOT = resolve(import.meta.dirname, '..', 'data', 'workspace-auth');

/**
 * The $HOME dir for a user's MCP instance. Email is sanitized to a safe
 * dirname (local part + domain hash-free suffix keeps it readable).
 */
export function workspaceHomeDir(email: string): string {
  const safe = email.trim().toLowerCase().replace(/[^a-z0-9@._-]+/g, '_');
  return join(WORKSPACE_AUTH_ROOT, safe);
}

function tokenPath(email: string): string {
  return join(workspaceHomeDir(email), '.google-workspace-mcp', 'token.json');
}

/**
 * OAuth scopes matching what the MCP server requests. Must match exactly so
 * that tokens obtained through the Notebook login are compatible.
 */
export const WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/contacts',
];

interface WorkspaceToken {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
  refresh_token_expires_in?: number;
}

/**
 * Write the MCP credentials.json using the Notebook app's OAuth client so the
 * MCP can refresh tokens independently. The `installed` key format matches what
 * google-auth-library expects (it reads `credentials.installed`).
 */
async function writeCredentials(email: string): Promise<void> {
  const credentials = {
    installed: {
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uris: ['http://localhost'],
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    },
  };
  await writeFile(join(workspaceHomeDir(email), '.google-workspace-mcp', 'credentials.json'), JSON.stringify(credentials, null, 2));
}

/**
 * Capture OAuth tokens for a specific user. Called from the Passport callback
 * when the user connects Workspace (refresh_token is only issued by Google on
 * first consent or ?reconnect=1).
 */
export async function writeWorkspaceTokens(
  email: string,
  accessToken: string,
  refreshToken: string,
): Promise<void> {
  const dir = join(workspaceHomeDir(email), '.google-workspace-mcp');
  await mkdir(dir, { recursive: true });

  await writeCredentials(email);

  const token: WorkspaceToken = {
    access_token: accessToken,
    refresh_token: refreshToken,
    scope: WORKSPACE_SCOPES.join(' '),
    token_type: 'Bearer',
    // Access tokens last ~1h; the MCP/google-auth-library will auto-refresh.
    expiry_date: Date.now() + 3600_000,
  };

  await writeFile(tokenPath(email), JSON.stringify(token, null, 2));
  console.log(`[workspace-auth] Tokens written for ${email}`);
}

async function readToken(email: string): Promise<Partial<WorkspaceToken> | null> {
  const p = tokenPath(email);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, 'utf-8')) as Partial<WorkspaceToken>;
  } catch {
    return null;
  }
}

/** Whether a usable refresh token exists on disk for this user. */
export async function hasWorkspaceTokens(email: string): Promise<boolean> {
  const token = await readToken(email);
  return !!token?.refresh_token;
}

/** Emails of every user with workspace tokens on disk (for the UI pickers). */
export async function listWorkspaceUsers(): Promise<string[]> {
  try {
    const entries = await readdir(WORKSPACE_AUTH_ROOT, { withFileTypes: true });
    const users: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      const tokenFile = join(WORKSPACE_AUTH_ROOT, entry.name, '.google-workspace-mcp', 'token.json');
      try {
        const token = JSON.parse(await readFile(tokenFile, 'utf-8')) as Partial<WorkspaceToken>;
        if (token.refresh_token) users.push(entry.name);
      } catch {
        // unreadable token file — skip this user
      }
    }
    return users.sort();
  } catch {
    return [];
  }
}

export interface WorkspaceAuthStatus {
  connected: boolean;
  /** Epoch ms when the access token expires (approx). */
  expiresAt?: number;
}

/**
 * Check whether valid workspace tokens exist on disk for this user.
 * Lightweight check (no network) — used for /me status display.
 */
export async function getWorkspaceAuthStatus(email: string): Promise<WorkspaceAuthStatus> {
  const token = await readToken(email);
  if (!token) return { connected: false };
  return {
    connected: !!token.refresh_token,
    expiresAt: token.expiry_date,
  };
}

/**
 * Actively validate workspace auth for a user before a gw_ tool call.
 *
 * If the access token is still valid (with a 2-min buffer), returns true.
 * If the access token is expired, attempts a refresh via Google's token API.
 * If the refresh succeeds, updates the token file and returns true.
 * If the refresh fails (e.g. refresh token expired after 7 days in test mode),
 * returns false — the caller should short-circuit with the sentinel.
 *
 * This prevents the MCP from hanging on its own browser-based OAuth flow
 * when running headless.
 */
export async function validateWorkspaceAuth(email: string): Promise<boolean> {
  const token = await readToken(email);
  if (!token || !token.refresh_token) return false;

  // Access token still valid (2-min buffer) — no refresh needed.
  if (token.expiry_date && token.expiry_date > Date.now() + 120_000) {
    return true;
  }

  // Access token expired — try to refresh.
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: token.refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    if (!res.ok) {
      console.error(`[workspace-auth] Token refresh failed for ${email}:`, res.status, await res.text());
      return false;
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    // Update the token file with the refreshed access token.
    const updated: WorkspaceToken = {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? token.refresh_token,
      scope: token.scope ?? WORKSPACE_SCOPES.join(' '),
      token_type: 'Bearer',
      expiry_date: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    await writeFile(tokenPath(email), JSON.stringify(updated, null, 2));
    console.log(`[workspace-auth] Token refreshed for ${email}`);
    return true;
  } catch (e) {
    console.error(`[workspace-auth] Refresh attempt failed for ${email}:`, e);
    return false;
  }
}
