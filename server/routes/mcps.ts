/**
 * MCP server management routes.
 *
 * GET    /           — status of every configured server (+ configs) and the
 *                      users with Google Workspace tokens on disk (per-bundle
 *                      Tools dialog + management UI).
 * POST   /           — add a server (saved, started immediately).
 * PUT    /:name      — update a server's config (name immutable), restart it.
 * DELETE /:name      — stop and remove a server.
 * POST   /:name/restart — restart a server (e.g. after external changes).
 *
 * All endpoints are `full`-role only: an MCP config is an arbitrary command
 * line run on the host as the Notebook process.
 */

import { Router } from 'express';
import type { ErrorRequestHandler } from 'express';
import { mcpManager } from '../lib/mcp-manager.js';
import { listWorkspaceUsers } from '../lib/workspace-auth.js';
import { requireFull } from '../auth.js';
import {
  addMcpServer,
  updateMcpServer,
  removeMcpServer,
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
