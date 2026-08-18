import { Router } from 'express';
import { mcpManager } from '../lib/mcp-manager.js';
import { listWorkspaceUsers } from '../lib/workspace-auth.js';
import { requireFull } from '../auth.js';

export const mcpsRouter = Router();

/**
 * GET / — status of every configured MCP server plus the users with Google
 * Workspace tokens on disk. Used by the Settings UI for the per-bundle MCP
 * checkboxes and the per-bundle digest Google-account picker.
 */
mcpsRouter.get('/', requireFull, async (_req, res) => {
  res.json({
    servers: mcpManager.listServers(),
    workspaceUsers: await listWorkspaceUsers(),
  });
});
