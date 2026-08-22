import { Router } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import {
  addBundle,
  loadBundles,
  removeBundle,
  updateBundle,
  BundleError,
  getBundle,
  canAccessBundle,
  sanitizeAllowedUsers,
  sanitizeMcps,
  sanitizeDigest,
  sanitizeThinking,
} from '../bundles.js';
import { requireFull } from '../auth.js';
import { mcpManager } from '../lib/mcp-manager.js';
import filesRouter from './files.js';
import gitRouter from './git.js';
import chatRouter from './chat.js';
import uploadRouter from './upload.js';

const router = Router();

// Compose the file-reading routes under this router.
router.use(filesRouter);
router.use(gitRouter);
router.use(chatRouter);
router.use(uploadRouter);

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: TreeNode[];
  concept?: { type?: string; title?: string };
}

const SKIP_DIRS = new Set(['node_modules', '.git']);

/** Recursively build a directory tree of `.md` files (skip node_modules/.git). */
async function buildTree(dir: string, prefix: string): Promise<TreeNode[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new BundleError(`Bundle directory does not exist: ${dir}`, 'PATH_NOT_FOUND');
    }
    throw err;
  }

  const nodes: TreeNode[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // hidden files/dirs
    const fullPath = path.join(dir, entry.name);
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const children = await buildTree(fullPath, relPath);
      // Only include directories that contain at least one .md file.
      if (children.length > 0) {
        nodes.push({ name: entry.name, path: relPath, type: 'directory', children });
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      let concept: { type?: string; title?: string } | undefined;
      try {
        const raw = await fs.readFile(fullPath, 'utf8');
        const parsed = matter(raw);
        const fm = parsed.data ?? {};
        const title = typeof fm.title === 'string' ? fm.title : undefined;
        const type = typeof fm.type === 'string' ? fm.type : undefined;
        if (title || type) concept = { title, type };
      } catch {
        // Ignore read/parse errors for a single file — skip metadata.
      }
      nodes.push({ name: entry.name, path: relPath, type: 'file', concept });
    }
  }

  // Sort: directories first, then files, alphabetically.
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return nodes;
}

/** GET / — list bundles the current user can access (readonly: only allowed ones). */
router.get('/', async (req, res, next) => {
  try {
    const user = req.user!;
    const all = await loadBundles();
    res.json(all.filter((b) => canAccessBundle(b, user)));
  } catch (err) {
    next(err);
  }
});

/** GET /:id/tree — directory tree of the bundle (markdown files only). */
router.get('/:id/tree', async (req, res, next) => {
  try {
    const bundle = await getBundle(req.params.id);
    if (!bundle) {
      return res.status(404).json({ error: 'Bundle not found' });
    }
    const tree = await buildTree(bundle.path, '');
    res.json(tree);
  } catch (err) {
    if (err instanceof BundleError) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

/** POST / — register a new bundle directory (full role only). */
router.post('/', requireFull, async (req, res, next) => {
  try {
    const { name, path: bundlePath, icon, description, allowedUsers, mcps, thinking, digest } = req.body ?? {};
    if (!name || !bundlePath) {
      return res.status(400).json({ error: 'name and path are required' });
    }
    const bundle = await addBundle({
      name,
      path: bundlePath,
      icon,
      description,
      allowedUsers: sanitizeAllowedUsers(allowedUsers),
      mcps: sanitizeMcps(mcps, mcpManager.getServerNames()),
      thinking: sanitizeThinking(thinking),
      digest: sanitizeDigest(digest),
    });
    res.status(201).json(bundle);
  } catch (err) {
    if (err instanceof BundleError) {
      const status = err.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

/** PATCH /:id — update bundle metadata (full role only). */
router.patch('/:id', requireFull, async (req, res, next) => {
  try {
    const { name, icon, description, allowedUsers, mcps, thinking, digest } = req.body ?? {};
    const id = req.params.id as string;
    const bundle = await updateBundle(id, {
      name,
      icon,
      description,
      allowedUsers: sanitizeAllowedUsers(allowedUsers),
      mcps: sanitizeMcps(mcps, mcpManager.getServerNames()),
      thinking: sanitizeThinking(thinking),
      digest: sanitizeDigest(digest),
    });
    res.json(bundle);
  } catch (err) {
    if (err instanceof BundleError) {
      const status = err.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

/** DELETE /:id — remove a bundle from config (full role only). */
router.delete('/:id', requireFull, async (req, res, next) => {
  try {
    await removeBundle(req.params.id as string);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof BundleError) {
      const status = err.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

export default router;
