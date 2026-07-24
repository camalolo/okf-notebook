import { Router } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { getBundle, resolveBundlePath } from '../bundles.js';
import { requireFull } from '../auth.js';

const router = Router();

/** Extract the relative file path from Express 5 splat params. */
function getRelPath(req: { params: Record<string, unknown> }): string {
  const seg = req.params.path;
  return Array.isArray(seg) ? seg.join('/') : String(seg ?? '');
}

/** Validate that a resolved path is a .md file. */
function assertMarkdown(resolved: string): void {
  if (path.extname(resolved).toLowerCase() !== '.md') {
    throw new Error('Only .md files are allowed');
  }
}

/** GET /:bundleId/files/<rel-path> — read a file with parsed frontmatter. */
router.get('/:bundleId/files/*path', async (req, res, next) => {
  try {
    const bundle = await getBundle(req.params.bundleId as string);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const rel = getRelPath(req);
    if (!rel) return res.status(400).json({ error: 'Missing file path' });

    let resolved: string;
    try {
      resolved = resolveBundlePath(bundle.path, rel);
    } catch {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    if (path.extname(resolved).toLowerCase() !== '.md') {
      return res.status(400).json({ error: 'Only .md files are readable' });
    }

    let raw: string;
    try {
      raw = await fs.readFile(resolved, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return res.status(404).json({ error: 'File not found' });
      }
      throw err;
    }

    const parsed = matter(raw);
    const frontmatter = parsed.data ?? {};
    return res.json({
      path: rel,
      raw,
      frontmatter,
      body: parsed.content,
      title: typeof frontmatter.title === 'string' ? frontmatter.title : undefined,
      type: typeof frontmatter.type === 'string' ? frontmatter.type : undefined,
    });
  } catch (err) {
    next(err);
  }
});

/** POST /:bundleId/files — create a new file (full role only). */
router.post('/:bundleId/files', requireFull, async (req, res, next) => {
  try {
    const bundle = await getBundle(req.params.bundleId as string);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const { path: relPath, raw } = req.body ?? {};
    if (!relPath || typeof raw !== 'string') {
      return res.status(400).json({ error: 'path and raw are required' });
    }

    let resolved: string;
    try {
      resolved = resolveBundlePath(bundle.path, relPath);
      assertMarkdown(resolved);
    } catch {
      return res.status(400).json({ error: 'Invalid file path or not a .md file' });
    }

    // Reject if file already exists.
    try {
      await fs.access(resolved);
      return res.status(409).json({ error: 'File already exists' });
    } catch {
      // Good — file doesn't exist, proceed.
    }

    // Create parent directories if needed.
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, raw, 'utf8');

    const parsed = matter(raw);
    return res.status(201).json({
      path: relPath,
      raw,
      frontmatter: parsed.data ?? {},
      body: parsed.content,
    });
  } catch (err) {
    next(err);
  }
});

/** PUT /:bundleId/files/<rel-path> — update an existing file (full role only). */
router.put('/:bundleId/files/*path', requireFull, async (req, res, next) => {
  try {
    const bundle = await getBundle(req.params.bundleId as string);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const rel = getRelPath(req);
    if (!rel) return res.status(400).json({ error: 'Missing file path' });

    let resolved: string;
    try {
      resolved = resolveBundlePath(bundle.path, rel);
      assertMarkdown(resolved);
    } catch {
      return res.status(400).json({ error: 'Invalid file path or not a .md file' });
    }

    const { raw, frontmatter, body } = req.body ?? {};
    let content: string;
    if (typeof raw === 'string') {
      content = raw;
    } else if (frontmatter !== undefined && typeof body === 'string') {
      // Reconstruct from frontmatter + body.
      content = matter.stringify(body, frontmatter);
    } else {
      return res.status(400).json({ error: 'Provide either { raw } or { frontmatter, body }' });
    }

    try {
      await fs.access(resolved);
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }

    await fs.writeFile(resolved, content, 'utf8');

    const parsed = matter(content);
    const fm = parsed.data ?? {};
    return res.json({
      path: rel,
      raw: content,
      frontmatter: fm,
      body: parsed.content,
      title: typeof fm.title === 'string' ? fm.title : undefined,
      type: typeof fm.type === 'string' ? fm.type : undefined,
    });
  } catch (err) {
    next(err);
  }
});

/** DELETE /:bundleId/files/<rel-path> — delete a file (full role only). */
router.delete('/:bundleId/files/*path', requireFull, async (req, res, next) => {
  try {
    const bundle = await getBundle(req.params.bundleId as string);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const rel = getRelPath(req);
    if (!rel) return res.status(400).json({ error: 'Missing file path' });

    let resolved: string;
    try {
      resolved = resolveBundlePath(bundle.path, rel);
      assertMarkdown(resolved);
    } catch {
      return res.status(400).json({ error: 'Invalid file path or not a .md file' });
    }

    try {
      await fs.unlink(resolved);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return res.status(404).json({ error: 'File not found' });
      }
      throw err;
    }

    return res.json({ ok: true, path: rel });
  } catch (err) {
    next(err);
  }
});

export default router;
