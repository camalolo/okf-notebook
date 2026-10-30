/**
 * Disk-backed OAuth client for remote MCP servers (streamable-HTTP transport).
 *
 * The MCP TypeScript SDK's `auth()` flow drives everything — discovery,
 * RFC 7591 dynamic client registration, PKCE, code exchange and refresh —
 * through the `OAuthClientProvider` interface implemented here. This class
 * persists the flow state (client registration, tokens, PKCE verifier, CSRF
 * state, last authorization URL) as one JSON file per MCP server under
 * `server/data/mcp-oauth/` so grants survive restarts and deploys.
 *
 * The notebook server is headless: `redirectToAuthorization()` cannot point a
 * browser anywhere. Instead the generated authorization URL is stored and
 * surfaced by the manager/routes, and the Settings UI opens it; IBKR then
 * redirects back to `GET /api/notebook/mcps/:name/oauth/callback`, which
 * completes the exchange via `auth(provider, { authorizationCode })`.
 *
 * One grant per server (not per user): whoever signs in exposes *their*
 * brokerage account to every notebook user the server is enabled for —
 * same trust model the old ibkr-flex token had.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

const OAUTH_DIR = process.env.NOTEBOOK_MCPS_OAUTH_DIR
  ? path.resolve(process.env.NOTEBOOK_MCPS_OAUTH_DIR)
  : path.join(import.meta.dirname, '..', 'data', 'mcp-oauth');

/** Everything persisted per MCP server (0600 file). */
interface StoredOAuthState {
  /** RFC 7591 dynamic-registration result, if registered. */
  clientInformation?: OAuthClientInformationMixed;
  /** redirect_uri the registered client is bound to (host-derived). */
  redirectUri?: string;
  /** Latest tokens (access + refresh). */
  tokens?: OAuthTokens;
  /** PKCE verifier awaiting the callback exchange. */
  codeVerifier?: string;
  /** CSRF state awaiting the callback. */
  oauthState?: string;
  /** Authorization URL of the pending (or last) flow — surfaced in the UI. */
  authorizationUrl?: string;
}

export interface FileOAuthProviderOptions {
  /**
   * Redirect URI derived from the current request (authorize flow). When it
   * differs from the one the stored client was registered with, the client
   * registration is dropped and redone for the new URI.
   */
  redirectUri?: string;
  /** OAuth scopes to register and request (e.g. ['mcp.read']). */
  scopes?: string[];
  /** Ignore stored tokens — force a fresh authorization flow. */
  fresh?: boolean;
  /** Override the storage dir (tests). */
  dir?: string;
}

export class FileOAuthProvider implements OAuthClientProvider {
  private data: StoredOAuthState = {};
  private readonly file: string;
  private readonly scopes?: string[];
  private readonly fresh: boolean;
  /** Request-derived redirect URI — wins over the stored one while set. */
  private readonly preferredRedirectUri?: string;
  /** Serialize disk writes (read-modify-write races). */
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    readonly serverName: string,
    private readonly dir: string,
    opts: FileOAuthProviderOptions,
    stored: StoredOAuthState | null,
  ) {
    this.file = path.join(dir, `${encodeURIComponent(serverName)}.json`);
    this.scopes = opts.scopes;
    this.fresh = opts.fresh === true;
    this.preferredRedirectUri = opts.redirectUri;
    this.data = stored ?? {};
    // Host change since registration → the old client's redirect_uris no
    // longer match; drop it so auth() re-registers for the current host.
    if (
      this.preferredRedirectUri &&
      this.data.redirectUri &&
      this.data.redirectUri !== this.preferredRedirectUri
    ) {
      this.data = { ...this.data, clientInformation: undefined, redirectUri: undefined };
    }
  }

  /** Load any persisted state, then build the provider. */
  static async create(
    serverName: string,
    opts: FileOAuthProviderOptions = {},
  ): Promise<FileOAuthProvider> {
    const dir = opts.dir ?? OAUTH_DIR;
    let stored: StoredOAuthState | null = null;
    try {
      const raw = await fs.readFile(path.join(dir, `${encodeURIComponent(serverName)}.json`), 'utf8');
      stored = JSON.parse(raw) as StoredOAuthState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return new FileOAuthProvider(serverName, dir, opts, stored);
  }

  // ── Redirect / registration identity ────────────────────────────────────

  /** The active redirect URI: request-derived, else the registered one. */
  get redirectUrl(): string | undefined {
    return this.preferredRedirectUri ?? this.data.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    const redirectUri = this.redirectUrl;
    if (!redirectUri) {
      throw new Error(`MCP server "${this.serverName}" has no redirect URI yet — start the sign-in flow from Settings`);
    }
    return {
      client_name: `Notebook (${this.serverName})`,
      client_uri: new URL(redirectUri).origin,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.scopes && this.scopes.length > 0 ? { scope: this.scopes.join(' ') } : {}),
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.data.clientInformation;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.update({ clientInformation: info, redirectUri: this.redirectUrl });
  }

  // ── Tokens ──────────────────────────────────────────────────────────────

  tokens(): OAuthTokens | undefined {
    return this.fresh ? undefined : this.data.tokens;
  }

  get hasTokens(): boolean {
    return !this.fresh && this.data.tokens !== undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // Flow complete — drop the pending-flow leftovers.
    await this.update({ tokens, codeVerifier: undefined, oauthState: undefined });
  }

  // ── Pending authorization flow (PKCE + CSRF state + URL) ───────────────

  /** CSRF state generated for the pending flow (callback validation). */
  get pendingState(): string | undefined {
    return this.data.oauthState;
  }

  /** Authorization URL of the pending (or last) flow — for the Settings UI. */
  get pendingAuthorizationUrl(): string | undefined {
    return this.data.authorizationUrl;
  }

  state(): string {
    const value = randomBytes(16).toString('hex');
    void this.update({ oauthState: value });
    return value;
  }

  redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    return this.update({ authorizationUrl: authorizationUrl.toString() });
  }

  saveCodeVerifier(codeVerifier: string): Promise<void> {
    return this.update({ codeVerifier });
  }

  codeVerifier(): string {
    if (!this.data.codeVerifier) {
      throw new Error(`MCP server "${this.serverName}" has no PKCE verifier — restart the sign-in flow`);
    }
    return this.data.codeVerifier;
  }

  /** SDK recovery hook: drop parts of the stored state after OAuth errors. */
  async invalidateCredentials(kind: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
    if (kind === 'all') {
      this.data = {};
      await this.persist();
    } else if (kind === 'client') {
      await this.update({ clientInformation: undefined, redirectUri: undefined });
    } else if (kind === 'tokens') {
      await this.update({ tokens: undefined });
    } else {
      await this.update({ codeVerifier: undefined });
    }
  }

  /**
   * Drop everything (Settings "disconnect"). Tries the auth server's
   * revocation endpoint first (resolved via RFC 9728/8414 discovery from the
   * MCP server URL) — best effort, never throws.
   */
  async disconnect(mcpServerUrl?: string): Promise<void> {
    const tokens = this.data.tokens;
    if (tokens?.access_token && mcpServerUrl) {
      try {
        const endpoint = await resolveRevocationEndpoint(mcpServerUrl);
        if (endpoint) {
          await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              token: tokens.access_token,
              ...(tokens.refresh_token ? { token_type_hint: 'refresh_token' } : {}),
            }),
            signal: AbortSignal.timeout(10_000),
          });
        }
      } catch (err) {
        console.warn(`[mcp-oauth] revoke for "${this.serverName}" failed (tokens dropped anyway):`, err);
      }
    }
    this.data = {};
    await this.persist();
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  private async update(patch: Partial<StoredOAuthState>): Promise<void> {
    this.data = { ...this.data, ...patch };
    const prev = this.writeChain;
    this.writeChain = prev.then(() => this.persist());
    await this.writeChain;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}

/**
 * Resolve the auth server's revocation endpoint for an MCP server URL:
 * `…/.well-known/oauth-protected-resource` → authorization_servers[0] →
 * `…/.well-known/oauth-authorization-server` → revocation_endpoint.
 * Returns undefined when anything is missing (revocation is optional).
 */
async function resolveRevocationEndpoint(mcpServerUrl: string): Promise<string | undefined> {
  const res = await fetch(
    new URL('.well-known/oauth-protected-resource', mcpServerUrl.endsWith('/') ? mcpServerUrl : mcpServerUrl + '/'),
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) return undefined;
  const prm = (await res.json()) as { authorization_servers?: string[] };
  const issuer = prm.authorization_servers?.[0];
  if (!issuer) return undefined;
  const asRes = await fetch(new URL('.well-known/oauth-authorization-server', issuer), {
    signal: AbortSignal.timeout(10_000),
  });
  if (!asRes.ok) return undefined;
  const asMeta = (await asRes.json()) as { revocation_endpoint?: string };
  return asMeta.revocation_endpoint;
}
