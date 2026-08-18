/**
 * Global app settings (server-wide, not per bundle/user).
 *
 * Persisted to `server/data/settings.json` — runtime data that survives
 * deploys (the deploy script only replaces code, never `server/data/`).
 * Kept in memory after the first read; every LLM call goes through
 * `getSettings()` in lib/llm.ts, so a settings write takes effect on the
 * next request without a server restart.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Fallback model when nothing has been configured yet. */
export const DEFAULT_MODEL = 'glm-5.2';

export interface AppSettings {
  /** Model id passed to the Z.ai API for every LLM call (chat, digest, uploads). */
  model: string;
}

const SETTINGS_PATH =
  process.env.NOTEBOOK_SETTINGS_FILE ?? path.join(import.meta.dirname, 'data', 'settings.json');

const DEFAULTS: AppSettings = { model: DEFAULT_MODEL };

let cached: AppSettings | null = null;
let loading: Promise<AppSettings> | null = null;

/** Normalize untrusted/persisted JSON into a valid AppSettings object. */
function sanitize(raw: unknown): AppSettings {
  if (raw === null || typeof raw !== 'object') return { ...DEFAULTS };
  const model = (raw as Record<string, unknown>).model;
  return {
    model: typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_MODEL,
  };
}

/** Load settings from disk (seeding the file on first run); caches in memory. */
export async function getSettings(): Promise<AppSettings> {
  if (cached) return cached;
  if (!loading) {
    loading = (async () => {
      let settings: AppSettings;
      try {
        const raw = await fs.readFile(SETTINGS_PATH, 'utf8');
        settings = sanitize(JSON.parse(raw));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          settings = { ...DEFAULTS };
          // Seed the file so the location is discoverable.
          await fs
            .writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf8')
            .catch(() => {});
        } else if (err instanceof SyntaxError) {
          // Corrupt file — fall back to defaults rather than breaking chat.
          settings = { ...DEFAULTS };
        } else {
          throw err;
        }
      }
      cached = settings;
      return settings;
    })();
  }
  return loading;
}

/** Persist new settings to disk and update the in-memory cache. */
export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next = sanitize({ ...current, ...patch });
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  cached = next;
  return next;
}

/** Test-only: drop the in-memory cache. */
export function resetSettingsCache(): void {
  cached = null;
  loading = null;
}
