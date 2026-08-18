import { Router } from 'express';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const simpleGit = require('simple-git') as (cwd: string) => import('simple-git').SimpleGit;
import { getBundle } from '../bundles.js';
import { requireFull } from '../auth.js';
import { ensureGitRepo, isNoCommitsError } from '../lib/git-repo.js';

const router = Router();

/** Get a simple-git instance for a bundle's directory. */
function git(bundlePath: string) {
  return simpleGit(bundlePath);
}

/** GET /:bundleId/git/status — working tree status. */
router.get('/:bundleId/git/status', async (req, res, next) => {
  try {
    const bundle = await getBundle(req.params.bundleId as string);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    await ensureGitRepo(bundle.path);
    const status = await git(bundle.path).status();
    const files = status.files.map((f) => ({
      path: f.path,
      index: f.index,
      working_dir: f.working_dir,
      staged: f.index !== ' ' && f.index !== '?',
    }));

    // Get line-level insertion/deletion counts for the unstaged diff.
    let insertions = 0;
    let deletions = 0;
    if (!status.isClean()) {
      try {
        const diffSummary = await git(bundle.path).diffSummary();
        insertions = diffSummary.insertions;
        deletions = diffSummary.deletions;
      } catch {
        // best-effort
      }
    }

    return res.json({
      modified: files.filter((f) => f.working_dir !== ' ' || f.index !== ' '),
      staged: files.filter((f) => f.staged),
      not_added: status.not_added,
      created: status.created,
      deleted: status.deleted,
      modified_list: status.modified,
      renamed: status.renamed,
      isClean: status.isClean(),
      insertions,
      deletions,
    });
  } catch (err) {
    next(err);
  }
});

/** GET /:bundleId/git/diff — unstaged diff (optional ?path=). */
router.get('/:bundleId/git/diff', async (req, res, next) => {
  try {
    const bundle = await getBundle(req.params.bundleId as string);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const filePath = req.query.path as string | undefined;
    await ensureGitRepo(bundle.path);
    const diff = filePath
      ? await git(bundle.path).diff(['--', filePath])
      : await git(bundle.path).diff();

    return res.json({ diff });
  } catch (err) {
    next(err);
  }
});

/** GET /:bundleId/git/log — recent commit history (?limit=20). */
router.get('/:bundleId/git/log', async (req, res, next) => {
  try {
    const bundle = await getBundle(req.params.bundleId as string);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const limit = parseInt(req.query.limit as string) || 20;
    await ensureGitRepo(bundle.path);
    try {
      const log = await git(bundle.path).log({ maxCount: limit });
      const commits = log.all.map((c) => ({
        hash: c.hash,
        date: c.date,
        message: c.message,
        author: c.author_name,
      }));

      return res.json({ commits });
    } catch (err) {
      // Freshly-initialized repo — no commits yet.
      if (isNoCommitsError(err)) return res.json({ commits: [] });
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

/** POST /:bundleId/git/stage — stage files (full role only). */
router.post('/:bundleId/git/stage', requireFull, async (req, res, next) => {
  try {
    const bundle = await getBundle(req.params.bundleId as string);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const { paths } = req.body ?? {};
    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'paths (string[]) is required' });
    }

    await ensureGitRepo(bundle.path);
    await git(bundle.path).add(paths);
    return res.json({ ok: true, staged: paths });
  } catch (err) {
    next(err);
  }
});

/** POST /:bundleId/git/commit — stage + commit (full role only). */
router.post('/:bundleId/git/commit', requireFull, async (req, res, next) => {
  try {
    const bundle = await getBundle(req.params.bundleId as string);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const { message, paths } = req.body ?? {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }

    const g = git(bundle.path);
    await ensureGitRepo(bundle.path);
    if (Array.isArray(paths) && paths.length > 0) {
      await g.add(paths);
    } else {
      // Stage all changes if no specific paths given.
      await g.add('-A');
    }

    const author = req.user ? `${req.user.name} <${req.user.email}>` : undefined;
    const commitResult = author
      ? await g.commit(message, undefined, { '--author': author })
      : await g.commit(message);

    return res.json({
      ok: true,
      hash: commitResult.commit,
      summary: commitResult.summary,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
