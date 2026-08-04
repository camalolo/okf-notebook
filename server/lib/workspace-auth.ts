/**
 * Google Workspace MCP authentication helper.
 *
 * The @alanxchen/google-workspace-mcp package stores its OAuth tokens in
 * `~/.google-workspace-mcp/{token,credentials}.json`. Instead of relying on
 * the MCP's own OAuth flow (which opens a browser on the server), we capture
 * tokens from the Notebook app's Google OAuth login and write them to those
 * files so the MCP picks them up on the next tool call / restart.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from '../config.js';

const TOKEN_DIR = join(homedir(), '.google-workspace-mcp');
const TOKEN_PATH = join(TOKEN_DIR, 'token.json');
const CREDENTIALS_PATH = join(TOKEN_DIR, 'credentials.json');

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
async function writeCredentials(): Promise<void> {
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
  await writeFile(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
}

/**
 * Write the MCP token.json with freshly obtained OAuth tokens.
 * Called from the Passport callback when the user connects Workspace.
 */
export async function writeWorkspaceTokens(
  accessToken: string,
  refreshToken: string,
): Promise<void> {
  await mkdir(TOKEN_DIR, { recursive: true });

  await writeCredentials();

  const token: WorkspaceToken = {
    access_token: accessToken,
    refresh_token: refreshToken,
    scope: WORKSPACE_SCOPES.join(' '),
    token_type: 'Bearer',
    // Access tokens last ~1h; the MCP/google-auth-library will auto-refresh.
    expiry_date: Date.now() + 3600_000,
  };

  await writeFile(TOKEN_PATH, JSON.stringify(token, null, 2));
  console.log('[workspace-auth] Tokens written to', TOKEN_PATH);
}

export interface WorkspaceAuthStatus {
  connected: boolean;
  /** Epoch ms when the access token expires (approx). */
  expiresAt?: number;
}

/**
 * Check whether valid workspace tokens exist on disk.
 * Lightweight check (no network) — used for /me status display.
 */
export async function getWorkspaceAuthStatus(): Promise<WorkspaceAuthStatus> {
  if (!existsSync(TOKEN_PATH)) {
    return { connected: false };
  }
  try {
    const raw = await readFile(TOKEN_PATH, 'utf-8');
    const token = JSON.parse(raw) as Partial<WorkspaceToken>;
    return {
      connected: !!token.refresh_token,
      expiresAt: token.expiry_date,
    };
  } catch {
    return { connected: false };
  }
}

/**
 * Actively validate workspace auth before a gw_ tool call.
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
export async function validateWorkspaceAuth(): Promise<boolean> {
  if (!existsSync(TOKEN_PATH)) return false;

  let token: Partial<WorkspaceToken>;
  try {
    const raw = await readFile(TOKEN_PATH, 'utf-8');
    token = JSON.parse(raw) as Partial<WorkspaceToken>;
  } catch {
    return false;
  }

  if (!token.refresh_token) return false;

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
      console.error('[workspace-auth] Token refresh failed:', res.status, await res.text());
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
    await writeFile(TOKEN_PATH, JSON.stringify(updated, null, 2));
    console.log('[workspace-auth] Token refreshed successfully');
    return true;
  } catch (e) {
    console.error('[workspace-auth] Refresh attempt failed:', e);
    return false;
  }
}
