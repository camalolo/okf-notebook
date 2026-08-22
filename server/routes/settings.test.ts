import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import http from 'node:http';

// Redirect the settings store to a temp file (must be set before import).
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notebook-settings-test-'));
process.env.NOTEBOOK_SETTINGS_FILE = path.join(tmpDir, 'settings.json');

// Stub the model list from the inference proxy — tests must not hit the network.
const listModelsMock = vi.fn();
vi.mock('../lib/llm.js', () => ({
  listModels: (...args: unknown[]) => listModelsMock(...args),
  // Real implementation is env-dependent and trivial; mirror it.
  contextLimitFor: (model: string) =>
    /^glm-/.test(model) ? 1_000_000 : 128_000,
}));

const { getSettings, saveSettings, resetSettingsCache, DEFAULT_MODEL } = await import('../settings.js');
const { settingsRouter } = await import('./settings.js');

let server: http.Server;
let baseUrl: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Simulate an authenticated session (requireAuth runs at mount time in prod).
  app.use((req, _res, next) => {
    req.user = { email: 'test@example.com', name: 'Test', role: 'full' } as never;
    next();
  });
  app.use(settingsRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as http.AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetSettingsCache();
  listModelsMock.mockReset().mockResolvedValue(['glm-5.2', 'glm-5.3', 'glm-5-turbo']);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('settings store', () => {
  it('returns defaults when no file exists and seeds the file', async () => {
    const settings = await getSettings();
    expect(settings.model).toBe(DEFAULT_MODEL);
    const raw = JSON.parse(await fs.readFile(process.env.NOTEBOOK_SETTINGS_FILE!, 'utf8'));
    expect(raw.model).toBe(DEFAULT_MODEL);
  });

  it('persists updates and serves them from the cache', async () => {
    await saveSettings({ model: 'glm-5.3' });
    expect((await getSettings()).model).toBe('glm-5.3');
    // Cache survives a reset only via disk — verify persistence.
    resetSettingsCache();
    expect((await getSettings()).model).toBe('glm-5.3');
  });

  it('falls back to defaults on corrupt JSON', async () => {
    await fs.writeFile(process.env.NOTEBOOK_SETTINGS_FILE!, '{ not json', 'utf8');
    resetSettingsCache();
    expect((await getSettings()).model).toBe(DEFAULT_MODEL);
  });
});

describe('GET / settings route', () => {
  it('returns the current model and the official list', async () => {
    await saveSettings({ model: 'glm-5-turbo' });
    const res = await realFetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe('glm-5-turbo');
    expect(body.defaultModel).toBe(DEFAULT_MODEL);
    expect(body.models).toEqual(['glm-5.2', 'glm-5.3', 'glm-5-turbo']);
    // Derived from the model family (mock mirrors the real derivation).
    expect(body.contextLimit).toBe(1_000_000);
  });

  it('reports models: null when the proxy list is unavailable', async () => {
    listModelsMock.mockRejectedValue(new Error('proxy down'));
    const res = await realFetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toBeNull();
    expect(body.model).toBe('glm-5-turbo');
  });
});

describe('PUT / settings route', () => {
  function put(model: unknown): Promise<Response> {
    return realFetch(`${baseUrl}/`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
  }

  it('saves a valid model', async () => {
    const res = await put('glm-5.3');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe('glm-5.3');
    expect((await getSettings()).model).toBe('glm-5.3');
  });

  it('rejects a model outside the official list', async () => {
    await saveSettings({ model: 'glm-5.2' });
    const res = await put('gpt-imagineered');
    expect(res.status).toBe(400);
    expect((await getSettings()).model).toBe('glm-5.2');
  });

  it('rejects a missing model', async () => {
    const res = await put('');
    expect(res.status).toBe(400);
  });

  it('returns 503 when the list cannot be fetched', async () => {
    listModelsMock.mockRejectedValue(new Error('proxy down'));
    const res = await put('glm-5.2');
    expect(res.status).toBe(503);
  });
});
