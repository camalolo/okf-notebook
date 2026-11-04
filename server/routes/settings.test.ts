import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import http from 'node:http';

// Redirect the settings store and the bundle store to temp files (must be set
// before import — the settings PUT reports bundles outside the notebooks root).
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notebook-settings-test-'));
process.env.NOTEBOOK_SETTINGS_FILE = path.join(tmpDir, 'settings.json');
process.env.NOTEBOOK_BUNDLES_FILE = path.join(tmpDir, 'bundles.json');

// A fake notebooks root with one registered bundle inside it and one outside.
const rootDir = path.join(tmpDir, 'notebooks');
await fs.mkdir(path.join(rootDir, 'inside'), { recursive: true });
await fs.mkdir(path.join(tmpDir, 'outside'), { recursive: true });

// Stub the model list from the inference proxy — tests must not hit the network.
const listModelsMock = vi.fn();
vi.mock('../lib/llm.js', () => ({
  listModels: (...args: unknown[]) => listModelsMock(...args),
  // Real implementation is env-dependent and trivial; mirror it.
  contextLimitFor: (model: string) =>
    /^glm-/.test(model) ? 1_000_000 : 128_000,
  // Vision metadata comes from the proxy's /models advertisement; in tests
  // nothing advertises image input.
  modelHasImageInput: () => false,
}));

const { getSettings, saveSettings, resetSettingsCache, DEFAULT_MODEL, DEFAULT_NOTEBOOKS_ROOT } = await import('../settings.js');
const { saveBundles } = await import('../bundles.js');
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

beforeEach(async () => {
  resetSettingsCache();
  listModelsMock.mockReset().mockResolvedValue(['glm-5.2', 'glm-5.3', 'glm-5-turbo']);
  // Fresh bundle store per test: one inside the root, one outside.
  await saveBundles([
    {
      id: 'inside',
      name: 'Inside',
      path: path.join(rootDir, 'inside'),
      icon: '',
      description: '',
    },
    {
      id: 'outside',
      name: 'Outside',
      path: path.join(tmpDir, 'outside'),
      icon: '',
      description: '',
    },
  ]);
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
    // No model advertises image input in the stub → empty vision list.
    expect(body.visionModels).toEqual([]);
  });

  it('reports models: null when the proxy list is unavailable', async () => {
    listModelsMock.mockRejectedValue(new Error('proxy down'));
    const res = await realFetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toBeNull();
    expect(body.model).toBe('glm-5-turbo');
  });

  it('returns the notebooks root and flags registered bundles outside it', async () => {
    await saveSettings({ notebooksRoot: rootDir });
    const res = await realFetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notebooksRoot).toBe(path.resolve(rootDir));
    expect(body.defaultNotebooksRoot).toBe(DEFAULT_NOTEBOOKS_ROOT);
    expect(body.outsideBundles).toEqual([
      { id: 'outside', name: 'Outside', path: path.join(tmpDir, 'outside') },
    ]);
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

  it('saves a valid notebooks root, creating the directory', async () => {
    const newRoot = path.join(tmpDir, 'elsewhere', 'notebooks');
    const res = await realFetch(`${baseUrl}/`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notebooksRoot: newRoot }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notebooksRoot).toBe(newRoot);
    expect((await fs.stat(newRoot)).isDirectory()).toBe(true);
    expect((await getSettings()).notebooksRoot).toBe(newRoot);
    // Both fixture bundles live outside the new root.
    expect(body.outsideBundles.map((b: { id: string }) => b.id).sort()).toEqual([
      'inside',
      'outside',
    ]);
  });

  it('expands ~ in the notebooks root', async () => {
    const res = await realFetch(`${baseUrl}/`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notebooksRoot: '~/notebooks-from-test' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notebooksRoot).toBe(path.join(os.homedir(), 'notebooks-from-test'));
    // Clean up the directory the request created in the real home dir.
    await fs.rm(path.join(os.homedir(), 'notebooks-from-test'), { recursive: true, force: true });
  });

  it('rejects a relative notebooks root', async () => {
    const res = await realFetch(`${baseUrl}/`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notebooksRoot: 'relative/path' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects the filesystem root', async () => {
    const res = await realFetch(`${baseUrl}/`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notebooksRoot: '/' }),
    });
    expect(res.status).toBe(400);
  });

  it('updates model and root in one request', async () => {
    const newRoot = path.join(tmpDir, 'combined-root');
    const res = await realFetch(`${baseUrl}/`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.3', notebooksRoot: newRoot }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe('glm-5.3');
    expect(body.notebooksRoot).toBe(newRoot);
    expect((await getSettings()).model).toBe('glm-5.3');
  });

  it('rejects an empty patch', async () => {
    const res = await realFetch(`${baseUrl}/`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
