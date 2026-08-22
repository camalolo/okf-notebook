/**
 * Global app settings API: `GET/PUT /api/notebook/settings`.
 *
 * GET is available to any authenticated user (the UI shows the active model);
 * PUT (changing the global LLM model) requires the `full` role.
 */

import { Router } from 'express';
import { requireFull } from '../auth.js';
import { getSettings, saveSettings, DEFAULT_MODEL } from '../settings.js';
import { listModels, contextLimitFor } from '../lib/llm.js';

export const settingsRouter: Router = Router();

settingsRouter.get('/', async (_req, res, next) => {
  try {
    const [settings, models] = await Promise.all([
      getSettings(),
      listModels().catch(() => null),
    ]);
    res.json({
      model: settings.model,
      defaultModel: DEFAULT_MODEL,
      models,
      contextLimit: contextLimitFor(settings.model),
    });
  } catch (err) {
    next(err);
  }
});

settingsRouter.put('/', requireFull, async (req, res, next) => {
  try {
    const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
    if (!model) {
      res.status(400).json({ error: 'A model id is required.' });
      return;
    }

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
    if (!models.includes(model)) {
      res.status(400).json({ error: `Unknown model: ${model}` });
      return;
    }

    const settings = await saveSettings({ model });
    res.json({ model: settings.model, defaultModel: DEFAULT_MODEL, models });
  } catch (err) {
    next(err);
  }
});
