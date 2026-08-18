import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Redirect the bundle store to a temp file (must be set before import).
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notebook-bundles-test-'));
process.env.NOTEBOOK_BUNDLES_FILE = path.join(tmpDir, 'bundles.json');

const {
  sanitizeMcps,
  sanitizeDigest,
  updateBundle,
  addBundle,
  loadBundles,
  BundleError,
} = await import('./bundles.js');

const VALID_MCPS = ['google-workspace', 'browser', 'ibkr-flex'];

beforeAll(async () => {
  // Seed with one real directory (the repo itself) so addBundle's path check passes.
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  await addBundle({ name: 'Test Bundle', path: repoRoot, icon: '🧪', description: '' });
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('sanitizeMcps', () => {
  it('passes through undefined (meaning "all servers")', () => {
    expect(sanitizeMcps(undefined, VALID_MCPS)).toBeUndefined();
  });

  it('dedupes and trims valid names', () => {
    expect(sanitizeMcps([' browser ', 'browser', 'ibkr-flex'], VALID_MCPS)).toEqual([
      'browser',
      'ibkr-flex',
    ]);
  });

  it('allows an empty array (meaning "no servers")', () => {
    expect(sanitizeMcps([], VALID_MCPS)).toEqual([]);
  });

  it('drops non-string entries', () => {
    expect(sanitizeMcps([1, null, 'browser'], VALID_MCPS)).toEqual(['browser']);
  });

  it('rejects non-array input', () => {
    expect(() => sanitizeMcps('browser', VALID_MCPS)).toThrow(BundleError);
  });

  it('rejects unknown server names with a helpful message', () => {
    try {
      sanitizeMcps(['browser', 'nope'], VALID_MCPS);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BundleError);
      expect((err as BundleError).code).toBe('INVALID_MCPS');
      expect((err as BundleError).message).toContain('nope');
    }
  });
});

describe('sanitizeDigest', () => {
  it('passes through undefined (meaning defaults)', () => {
    expect(sanitizeDigest(undefined)).toBeUndefined();
    expect(sanitizeDigest(null)).toBeUndefined();
  });

  it('normalizes a google user email and keeps flags', () => {
    expect(sanitizeDigest({ enabled: false, googleUser: ' User@Example.com ' })).toEqual({
      enabled: false,
      googleUser: 'user@example.com',
    });
  });

  it('drops an empty googleUser', () => {
    expect(sanitizeDigest({ enabled: true, googleUser: '' })).toEqual({ enabled: true });
  });

  it('rejects malformed input', () => {
    expect(() => sanitizeDigest('nope')).toThrow(BundleError);
    expect(() => sanitizeDigest({ enabled: 'yes' })).toThrow(BundleError);
    expect(() => sanitizeDigest({ googleUser: 'not-an-email' })).toThrow(BundleError);
  });
});

describe('bundle mcps persistence', () => {
  it('updateBundle saves an explicit mcps list and an empty list', async () => {
    const [b] = await loadBundles();
    const updated = await updateBundle(b.id, { mcps: ['google-workspace'] });
    expect(updated.mcps).toEqual(['google-workspace']);

    const cleared = await updateBundle(b.id, { mcps: [] });
    expect(cleared.mcps).toEqual([]);
  });

  it('updateBundle leaves mcps untouched when the field is absent', async () => {
    const [b] = await loadBundles();
    await updateBundle(b.id, { mcps: ['browser'] });
    const updated = await updateBundle(b.id, { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    expect(updated.mcps).toEqual(['browser']);
  });
});
