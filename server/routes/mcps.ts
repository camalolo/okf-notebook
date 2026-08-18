import { Router } from 'express';
import { mcpManager } from '../lib/mcp-manager.js';
import { requireFull } from '../auth.js';

export const mcpsRouter = Router();

/**
 * GET / — status of every configured MCP server (Settings UI).
 * Used to render the per-bundle MCP availability checkboxes.
 */
mcpsRouter.get('/', requireFull, (_req, res) => {
  res.json(mcpManager.listServers());
});
