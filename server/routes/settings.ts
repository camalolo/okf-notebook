/**
 * Global app settings API: `GET/PUT /api/notebook/settings`.
 *
 * GET is available to any authenticated user (the UI shows the active model
 * and the notebooks root); PUT (changing the global LLM model and/or the
 * notebooks root) requires the `full` role.
 */

import { Router } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { requireFull } from '../auth.js';
import { getSettings, saveSettings, DEFAULT_MODEL, DEFAULT_NOTEBOOKS_ROOT, expandHome } from '../settings.js';
import { getNotebooksRoot, isInsideRoot, loadBundles } from '../bundles.js';
import { listModels, contextLimitFor, modelHasImageInput } from '../lib/llm.js';

export const settingsRouter: Router = Router();

/** Registered bundles whose path falls outside a given root. */
async function bundlesOutsideRoot(root: string): Promise<{ id: string; name: string; path: string }[]> {
  const bundles = await loadBundles();
  return bundles
    .filter((b) => !isInsideRoot(root, b.path))
    .map(({ id, name, path: p }) => ({ id, name, path: p }));
}

settingsRouter.get('/', async (_req, res, next) => {
  try {
    const [settings, models, notebooksRoot] = await Promise.all([
      getSettings(),
      listModels().catch(() => null),
      getNotebooksRoot(),
    ]);
    res.json({
      model: settings.model,
      defaultModel: DEFAULT_MODEL,
      notebooksRoot,
      defaultNotebooksRoot: DEFAULT_NOTEBOOKS_ROOT,
      outsideBundles: await bundlesOutsideRoot(notebooksRoot),
      models,
      // Ids the endpoint advertises image input for (📷 badge in the UI).
      visionModels: (models ?? []).filter(modelHasImageInput),
      contextLimit: contextLimitFor(settings.model),
    });
  } catch (err) {
    next(err);
  }
});

settingsRouter.put('/', requireFull, async (req, res, next) => {
  try {
    const patch: { model?: string; notebooksRoot?: string } = {};

    // --- model (unchanged semantics when present) ---------------------------
    const rawModel = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
    if (rawModel) {
      // Validate against the API's official model list so settings can never
      // hold an id the API would reject.
      let models: string[];
      try {
        models = await listModels();
      } catch {
        res
          .status(503)
          .json({ error: 'Model list is unavailable (inference proxy unreachable). Try again shortly.' });
        return;
      }
      if (!models.includes(rawModel)) {
        res.status(400).json({ error: `Unknown model: ${rawModel}` });
        return;
      }
      patch.model = rawModel;
    }

    // --- notebooks root ------------------------------------------------------
    let models: string[] | null = null;
    const rawRoot = typeof req.body?.notebooksRoot === 'string' ? req.body.notebooksRoot.trim() : '';
    if (rawRoot) {
      const expanded = expandHome(rawRoot);
      if (!path.isAbsolute(expanded)) {
        res.status(400).json({ error: `The notebooks root must be an absolute path: ${rawRoot}` });
        return;
      }
      const root = path.resolve(expanded);
      if (root === path.parse(root).root) {
        res.status(400).json({ error: 'The notebooks root cannot be the filesystem root.' });
        return;
      }
      // The root may not exist yet — create it so the first "Add bundle"
      // inside it just works. An existing non-directory is an error.
      await fs.mkdir(root, { recursive: true });
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) {
        res.status(400).json({ error: `Not a directory: ${root}` });
        return;
      }
      patch.notebooksRoot = root;
    }

    if (!patch.model && !patch.notebooksRoot) {
      res.status(400).json({ error: 'Nothing to update: send a model and/or a notebooksRoot.' });
      return;
    }

    const settings = await saveSettings(patch);
    if (models === null) {
      models = await listModels().catch(() => null);
    }
    const notebooksRoot = await getNotebooksRoot();
    res.json({
      model: settings.model,
      defaultModel: DEFAULT_MODEL,
      notebooksRoot,
      defaultNotebooksRoot: DEFAULT_NOTEBOOKS_ROOT,
      outsideBundles: await bundlesOutsideRoot(notebooksRoot),
      models,
      visionModels: (models ?? []).filter(modelHasImageInput),
      contextLimit: contextLimitFor(settings.model),
    });
  } catch (err) {
    next(err);
  }
});
