import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Redirect the bundle store to a temp file (must be set before import).
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notebook-bundles-test-'));
process.env.NOTEBOOK_BUNDLES_FILE = path.join(tmpDir, 'bundles.json');

// A temp directory standing in for a real bundle directory (registering the
// repo root would seed OKF.md/AGENTS.md into the repo itself).
const bundleDir = path.join(tmpDir, 'bundle');
await fs.mkdir(bundleDir, { recursive: true });

const {
  sanitizeMcps,
  sanitizeDigest,
  updateBundle,
  addBundle,
  loadBundles,
  BundleError,
  seedOkfSpec,
} = await import('./bundles.js');
const { OKF_SPEC } = await import('./lib/okf-template.js');
const { agentsTemplate } = await import('./lib/agents-template.js');

const VALID_MCPS = ['google-workspace', 'browser', 'ibkr-flex'];

beforeAll(async () => {
  await addBundle({ name: 'Test Bundle', path: bundleDir, icon: '🧪', description: '' });
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
    expect(sanitizeDigest({ enabled: false, googleUser: ' Alice@Example.com ' })).toEqual({
      enabled: false,
      googleUser: 'alice@example.com',
    });
  });

  it('keeps the cleanup flag and rejects non-boolean values', () => {
    expect(sanitizeDigest({ enabled: true, cleanup: true })).toEqual({
      enabled: true,
      cleanup: true,
    });
    expect(sanitizeDigest({ cleanup: false })).toEqual({ cleanup: false });
    expect(() => sanitizeDigest({ cleanup: 'yes' })).toThrow(BundleError);
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

describe('sanitizeThinking', () => {
  it('passes the literals through', async () => {
    const { sanitizeThinking } = await import('./bundles.js');
    expect(sanitizeThinking('on')).toBe('on');
    expect(sanitizeThinking('off')).toBe('off');
  });

  it('treats absent/null/empty as undefined (the off default)', async () => {
    const { sanitizeThinking } = await import('./bundles.js');
    expect(sanitizeThinking(undefined)).toBeUndefined();
    expect(sanitizeThinking(null)).toBeUndefined();
    expect(sanitizeThinking('')).toBeUndefined();
  });

  it('rejects anything else', async () => {
    const { sanitizeThinking } = await import('./bundles.js');
    expect(() => sanitizeThinking(true)).toThrow(BundleError);
    expect(() => sanitizeThinking('enabled')).toThrow(BundleError);
    expect(() => sanitizeThinking(1)).toThrow(BundleError);
  });
});

describe('addBundle seeding', () => {
  it('seeds OKF.md and a starter AGENTS.md into the registered directory', async () => {
    // Registered in beforeAll — both files must now exist there.
    await expect(fs.readFile(path.join(bundleDir, 'OKF.md'), 'utf8')).resolves.toBe(OKF_SPEC);
    const agents = await fs.readFile(path.join(bundleDir, 'AGENTS.md'), 'utf8');
    expect(agents).toBe(agentsTemplate('Test Bundle', ''));
  });

  it('re-registering the same directory never overwrites existing files', async () => {
    await fs.writeFile(path.join(bundleDir, 'OKF.md'), 'custom spec\n', 'utf8');
    await fs.writeFile(path.join(bundleDir, 'AGENTS.md'), 'hand-written guidance\n', 'utf8');
    await addBundle({ name: 'Second', path: bundleDir });
    await expect(fs.readFile(path.join(bundleDir, 'OKF.md'), 'utf8')).resolves.toBe('custom spec\n');
    await expect(fs.readFile(path.join(bundleDir, 'AGENTS.md'), 'utf8')).resolves.toBe(
      'hand-written guidance\n',
    );
  });
});

describe('seedOkfSpec', () => {
  it('writes OKF.md into a directory that lacks one', async () => {
    const dir = path.join(tmpDir, 'seed-fresh');
    await fs.mkdir(dir, { recursive: true });
    await expect(seedOkfSpec(dir)).resolves.toBe(true);
    const written = await fs.readFile(path.join(dir, 'OKF.md'), 'utf8');
    expect(written).toBe(OKF_SPEC);
    expect(written.startsWith('# Open Knowledge Format (OKF)')).toBe(true);
  });

  it('reports failure (does not throw) when the directory is read-only', async () => {
    const dir = path.join(tmpDir, 'seed-readonly');
    await fs.mkdir(dir, { recursive: true });
    await fs.chmod(dir, 0o500);
    try {
      await expect(seedOkfSpec(dir)).resolves.toBe(false);
    } finally {
      await fs.chmod(dir, 0o700);
    }
  });
});

describe('seedAgentsMd', () => {
  it('interpolates name and description', () => {
    const out = agentsTemplate('Kitchen Renovation', 'Cabinets, contractors, budget');
    expect(out).toContain('# AGENTS.md — Kitchen Renovation');
    expect(out).toContain('Cabinets, contractors, budget');
    expect(out).toContain('TODO');
    // Must not restate the OKF spec (the system prompt embeds OKF.md itself).
    expect(out).not.toContain(OKF_SPEC.slice(0, 40));
  });
});
