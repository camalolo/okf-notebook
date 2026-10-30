import { describe, it, expect, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh temp dir per file — provider state is disk-backed.
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notebook-mcp-oauth-test-'));

const { FileOAuthProvider } = await import('./mcp-oauth.js');

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const readStore = async (name: string) =>
  JSON.parse(await fs.readFile(path.join(tmpDir, `${name}.json`), 'utf8'));

describe('FileOAuthProvider', () => {
  it('starts empty and requires a redirect URI for client metadata', async () => {
    const p = await FileOAuthProvider.create('fresh', { dir: tmpDir, scopes: ['mcp.read'] });
    expect(p.hasTokens).toBe(false);
    expect(p.redirectUrl).toBeUndefined();
    expect(() => p.clientMetadata).toThrow(/no redirect URI/);
  });

  it('persists the pending PKCE flow to disk as it progresses', async () => {
    const redirectUri = 'https://nb.example/api/notebook/mcps/pending/oauth/callback';
    const p = await FileOAuthProvider.create('pending', { dir: tmpDir, redirectUri, scopes: ['mcp.read'] });
    expect(p.redirectUrl).toBe(redirectUri);
    expect(p.clientMetadata.redirect_uris).toEqual([redirectUri]);
    expect(p.clientMetadata.scope).toBe('mcp.read');
    expect(p.clientMetadata.token_endpoint_auth_method).toBe('none');

    await p.saveClientInformation({ client_id: 'cid-p' } as never);
    const state = p.state(); // generated + remembered (in-memory immediately)
    await p.saveCodeVerifier('ver-p');
    await p.redirectToAuthorization(new URL('https://as.example/authorize?x=1'));

    expect(p.pendingState).toBe(state);
    expect(p.codeVerifier()).toBe('ver-p');
    expect(p.pendingAuthorizationUrl).toContain('https://as.example/authorize');

    // The awaited writes flush the whole chain (ordered), state included.
    const raw = await readStore('pending');
    expect(raw.clientInformation).toEqual({ client_id: 'cid-p' });
    expect(raw.redirectUri).toBe(redirectUri);
    expect(raw.oauthState).toBe(state);
    expect(raw.codeVerifier).toBe('ver-p');
    expect(raw.authorizationUrl).toContain('https://as.example/authorize');
    expect(raw.tokens).toBeUndefined();
  });

  it('saveTokens completes the flow: keeps client + URL, drops pending state', async () => {
    const p = await FileOAuthProvider.create('pending', { dir: tmpDir });
    await p.saveTokens({ access_token: 'at-p', refresh_token: 'rt-p' } as never);

    const raw = await readStore('pending');
    expect(raw.tokens).toEqual({ access_token: 'at-p', refresh_token: 'rt-p' });
    expect(raw.codeVerifier).toBeUndefined();
    expect(raw.oauthState).toBeUndefined();
    expect(raw.clientInformation).toEqual({ client_id: 'cid-p' });
    expect(raw.authorizationUrl).toContain('https://as.example/authorize');

    // Cross-instance read-back — what the callback route relies on.
    const p2 = await FileOAuthProvider.create('pending', { dir: tmpDir });
    expect(p2.hasTokens).toBe(true);
    expect(p2.tokens()).toEqual({ access_token: 'at-p', refresh_token: 'rt-p' });
    expect(p2.clientInformation()).toEqual({ client_id: 'cid-p' });
    expect(p2.redirectUrl).toBe('https://nb.example/api/notebook/mcps/pending/oauth/callback');
    expect(p2.pendingAuthorizationUrl).toContain('https://as.example/authorize');
  });

  it('fresh: true hides tokens (forces a new authorization)', async () => {
    const p = await FileOAuthProvider.create('pending', { dir: tmpDir, fresh: true });
    expect(p.hasTokens).toBe(false);
    expect(p.tokens()).toBeUndefined();
    // …but registration and the last authorization URL survive.
    expect(p.clientInformation()).toEqual({ client_id: 'cid-p' });
    expect(p.pendingAuthorizationUrl).toContain('https://as.example/authorize');
  });

  it('drops a client registered for a different redirect URI (host change)', async () => {
    const p = await FileOAuthProvider.create('pending', {
      dir: tmpDir,
      redirectUri: 'https://other-host.example/api/notebook/mcps/pending/oauth/callback',
    });
    expect(p.clientInformation()).toBeUndefined();
  });

  it('invalidateCredentials drops only the requested part', async () => {
    const p = await FileOAuthProvider.create('pending', { dir: tmpDir });
    await p.invalidateCredentials('tokens');
    const raw = await readStore('pending');
    expect(raw.tokens).toBeUndefined();
    expect(raw.clientInformation).toEqual({ client_id: 'cid-p' }); // untouched
  });

  it('disconnect clears everything (no tokens → no revoke call)', async () => {
    const p = await FileOAuthProvider.create('pending', { dir: tmpDir });
    await p.disconnect();
    const raw = await readStore('pending');
    expect(raw).toEqual({});
    const p2 = await FileOAuthProvider.create('pending', { dir: tmpDir });
    expect(p2.hasTokens).toBe(false);
    expect(p2.clientInformation()).toBeUndefined();
    expect(p2.pendingAuthorizationUrl).toBeUndefined();
  });
});
