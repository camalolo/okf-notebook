/**
 * MCP server management routes.
 *
 * GET    /               — status of every configured server (+ configs) and
 *                          the users with Google Workspace tokens on disk
 *                          (per-bundle Tools dialog + management UI).
 * POST   /               — add a server (saved, started immediately).
 * PUT    /:name          — update a server's config (name immutable), restart it.
 * DELETE /:name          — stop and remove a server.
 * POST   /:name/restart  — restart a server (e.g. after external changes).
 * POST   /:name/authorize — start the OAuth sign-in for a remote (url) server;
 *                          returns { authUrl } — the UI opens it, IBKR (or
 *                          whichever provider) redirects back to the callback.
 * GET    /:name/oauth/callback — OAuth redirect target: validates state,
 *                          exchanges the code, stores tokens, restarts the
 *                          server, redirects the browser to /settings.
 * POST   /:name/disconnect — revoke + drop stored tokens (server restarts
 *                          into the "sign-in required" state).
 *
 * All endpoints are `full`-role only: an MCP config is an arbitrary command
 * line run on the host as the Notebook process (and OAuth grants expose the
 * signed-in user's external accounts to the chat).
 */

import { Router } from 'express';
import type { ErrorRequestHandler, Request } from 'express';
import { auth as mcpAuth } from '@modelcontextprotocol/sdk/client/auth.js';
import { mcpManager } from '../lib/mcp-manager.js';
import { FileOAuthProvider } from '../lib/mcp-oauth.js';
import { listWorkspaceUsers } from '../lib/workspace-auth.js';
import { requireFull } from '../auth.js';
import {
  addMcpServer,
  updateMcpServer,
  removeMcpServer,
  loadMcpServers,
  McpError,
} from '../mcps.js';

export const mcpsRouter = Router();

function statusPayload() {
  return { servers: mcpManager.listServers() };
}

/**
 * A failed start is NOT an HTTP error — the config was saved fine; the server
 * just isn't running (bad command, missing binary, …). The client sees
 * running:false + error via listServers().
 */
function startErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Coerce an Express 5 route param (string | string[]) to a plain string. */
function paramName(value: string | string[]): string {
  return Array.isArray(value) ? value.join('/') : value;
}

mcpsRouter.get('/', requireFull, async (_req, res) => {
  res.json({
    servers: mcpManager.listServers(),
    workspaceUsers: await listWorkspaceUsers(),
  });
});

mcpsRouter.post('/', requireFull, async (req, res, next) => {
  try {
    const config = await addMcpServer(req.body);
    try {
      await mcpManager.restartServer(config.name, config);
    } catch (err) {

      console.error(`[mcp] Added "${config.name}" but failed to start: ${startErrorMessage(err)}`);
    }
    res.status(201).json(statusPayload());
  } catch (err) {
    next(err);
  }
});

mcpsRouter.put('/:name', requireFull, async (req, res, next) => {
  try {
    const config = await updateMcpServer(paramName(req.params.name), req.body);
    try {
      await mcpManager.restartServer(config.name, config);
    } catch (err) {

      console.error(`[mcp] Updated "${config.name}" but failed to restart: ${startErrorMessage(err)}`);
    }
    res.json(statusPayload());
  } catch (err) {
    next(err);
  }
});

mcpsRouter.delete('/:name', requireFull, async (req, res, next) => {
  try {
    await removeMcpServer(paramName(req.params.name));
    await mcpManager.stopServer(paramName(req.params.name));
    res.json(statusPayload());
  } catch (err) {
    next(err);
  }
});

mcpsRouter.post('/:name/restart', requireFull, async (req, res, next) => {
  try {
    await mcpManager.restartServer(paramName(req.params.name));
    res.json(statusPayload());
  } catch (err) {
    next(err);
  }
});

/** Build the OAuth redirect URI from the incoming request (nginx-aware via
 *  `trust proxy`, same pattern as the Google OAuth callbackURL). */
function oauthRedirectUri(req: Request, name: string): string {
  return `${req.protocol}://${req.get('host')}/api/notebook/mcps/${encodeURIComponent(name)}/oauth/callback`;
}

async function getUrlServerConfig(name: string) {
  const servers = await loadMcpServers();
  const config = servers.find((s) => s.name === name);
  if (!config) throw new McpError(`MCP server not found: ${name}`, 'NOT_FOUND');
  if (!config.url) {
    throw new McpError(
      `"${name}" is a stdio server — OAuth sign-in applies to remote (url) servers only`,
      'INVALID_COMMAND',
    );
  }
  // Narrowed shape — callers can rely on url being defined.
  return { url: config.url, scopes: config.scopes };
}

/**
 * Start (or restart) the OAuth authorization-code flow for a remote server.
 * Runs RFC 7591 dynamic registration (when needed) + PKCE via the SDK, then
 * returns the IBKR-hosted authorization URL for the UI to open. The code is
 * later delivered to the callback route by the provider's redirect.
 */
mcpsRouter.post('/:name/authorize', requireFull, async (req, res, next) => {
  try {
    const name = paramName(req.params.name);
    const config = await getUrlServerConfig(name);

    const redirectUri = oauthRedirectUri(req, name);
    const provider = await FileOAuthProvider.create(name, {
      redirectUri,
      scopes: config.scopes,
      fresh: true, // Connect always means a fresh sign-in
    });

    await mcpAuth(provider, {
      serverUrl: config.url,
      scope: config.scopes?.join(' '),
    });

    const authUrl = provider.pendingAuthorizationUrl;
    if (!authUrl) {
      throw new McpError('Authorization flow did not produce a URL', 'INVALID_COMMAND');
    }
    res.json({ authUrl });
  } catch (err) {
    next(err);
  }
});

/**
 * OAuth redirect target. The browser arrives here from the provider's login
 * page carrying `?code=…&state=…`. `requireFull` still applies: the person
 * authorizing must be signed into Notebook (and be a full user) — the
 * session cookie rides along on the redirect.
 */
mcpsRouter.get('/:name/oauth/callback', requireFull, async (req, res, next) => {
  const name = paramName(req.params.name);
  const backWithError = (msg: string) =>
    res.redirect(`/settings?mcpAuth=${encodeURIComponent(name)}&mcpAuthError=${encodeURIComponent(msg)}`);
  try {
    const config = await getUrlServerConfig(name);
    const code = req.query.code;
    const oauthState = req.query.state;

    const provider = await FileOAuthProvider.create(name, { scopes: config.scopes });
    if (typeof code !== 'string' || typeof oauthState !== 'string') {
      backWithError('Missing code or state in the OAuth callback');
      return;
    }
    if (!provider.pendingState || provider.pendingState !== oauthState) {
      backWithError('OAuth state mismatch — restart the sign-in from Settings');
      return;
    }

    await mcpAuth(provider, { serverUrl: config.url, authorizationCode: code });

    try {
      await mcpManager.restartServer(name);
    } catch (err) {
      console.error(`[mcp] OAuth completed for "${name}" but restart failed:`, err);
    }
    res.redirect(`/settings?mcpAuth=${encodeURIComponent(name)}`);
  } catch (err) {
    if (res.headersSent) return next(err);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[mcp] OAuth callback for "${name}" failed: ${msg}`);
    backWithError(msg);
  }
});

/** Revoke and forget the stored grant (Settings "Disconnect"). */
mcpsRouter.post('/:name/disconnect', requireFull, async (req, res, next) => {
  try {
    const name = paramName(req.params.name);
    const config = await getUrlServerConfig(name);
    const provider = await FileOAuthProvider.create(name, { scopes: config.scopes });
    await provider.disconnect(config.url);
    try {
      await mcpManager.restartServer(name); // → back to the sign-in state
    } catch {
      // Expected: restart without tokens throws "sign-in required".
    }
    res.json(statusPayload());
  } catch (err) {
    next(err);
  }
});

/** Map McpError codes to HTTP statuses (mirrors the BundleError pattern). */
const mcpErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof McpError) {
    const status =
      err.code === 'NOT_FOUND' ? 404
      : err.code === 'DUPLICATE_NAME' ? 409
      : 400;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  next(err);
};

mcpsRouter.use(mcpErrorHandler);
