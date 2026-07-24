import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLES_FILE } from './config.js';
import type { BundleConfig } from './config.js';

const BUNDLES_PATH = fileURLToPath(BUNDLES_FILE);

const SEED_BUNDLES: BundleConfig[] = [
  {
    id: 'demo',
    name: 'Demo — Graduation',
    path: '/home/user/Sources/Demo',
    icon: '🎓',
    description: 'Credit recovery, university transition, monitoring',
  },
  {
    id: 'sample',
    name: 'Sample — Vehicle',
    path: '/home/user/Sources/Sample',
    icon: '🚗',
    description: 'Hyundai Sample TLG-E maintenance, issues, service history',
  },
];

/** Generate a URL-safe slug from a display name. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Generate a unique slug id, appending `-2`, `-3`, … on collision. */
function uniqueId(name: string, existing: BundleConfig[]): string {
  const base = slugify(name) || 'bundle';
  if (!existing.some((b) => b.id === base)) return base;
  let n = 2;
  while (existing.some((b) => b.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Read bundles from disk, seeding the file on first run. */
export async function loadBundles(): Promise<BundleConfig[]> {
  try {
    const raw = await fs.readFile(BUNDLES_PATH, 'utf8');
    return JSON.parse(raw) as BundleConfig[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await saveBundles(SEED_BUNDLES);
      return SEED_BUNDLES;
    }
    throw err;
  }
}

/** Write bundles to disk. */
export async function saveBundles(bundles: BundleConfig[]): Promise<void> {
  await fs.writeFile(BUNDLES_PATH, JSON.stringify(bundles, null, 2) + '\n', 'utf8');
}

/** Find a single bundle by id. */
export async function getBundle(id: string): Promise<BundleConfig | undefined> {
  const bundles = await loadBundles();
  return bundles.find((b) => b.id === id);
}

export interface NewBundleInput {
  name: string;
  path: string;
  icon?: string;
  description?: string;
}

/** Add a new bundle after validating that the path is an existing directory. */
export async function addBundle(data: NewBundleInput): Promise<BundleConfig> {
  // Validate the path exists and is a directory.
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(data.path);
  } catch {
    throw new BundleError(`Path does not exist: ${data.path}`, 'PATH_NOT_FOUND');
  }
  if (!stat.isDirectory()) {
    throw new BundleError(`Path is not a directory: ${data.path}`, 'PATH_NOT_DIRECTORY');
  }

  const bundles = await loadBundles();
  const bundle: BundleConfig = {
    id: uniqueId(data.name, bundles),
    name: data.name,
    path: data.path,
    icon: data.icon ?? '',
    description: data.description ?? '',
  };
  bundles.push(bundle);
  await saveBundles(bundles);
  return bundle;
}

/** Remove a bundle from config (files on disk are untouched). */
export async function removeBundle(id: string): Promise<void> {
  const bundles = await loadBundles();
  const next = bundles.filter((b) => b.id !== id);
  if (next.length === bundles.length) {
    throw new BundleError(`Bundle not found: ${id}`, 'NOT_FOUND');
  }
  await saveBundles(next);
}

/** Update a bundle's metadata (never the path). */
export async function updateBundle(
  id: string,
  data: Partial<Pick<BundleConfig, 'name' | 'icon' | 'description'>>,
): Promise<BundleConfig> {
  const bundles = await loadBundles();
  const idx = bundles.findIndex((b) => b.id === id);
  if (idx === -1) {
    throw new BundleError(`Bundle not found: ${id}`, 'NOT_FOUND');
  }
  bundles[idx] = {
    ...bundles[idx],
    ...(data.name !== undefined ? { name: data.name } : {}),
    ...(data.icon !== undefined ? { icon: data.icon } : {}),
    ...(data.description !== undefined ? { description: data.description } : {}),
  };
  await saveBundles(bundles);
  return bundles[idx];
}

export type BundleErrorCode = 'PATH_NOT_FOUND' | 'PATH_NOT_DIRECTORY' | 'NOT_FOUND';

export class BundleError extends Error {
  code: BundleErrorCode;
  constructor(message: string, code: BundleErrorCode) {
    super(message);
    this.name = 'BundleError';
    this.code = code;
  }
}

/** Resolve and validate a relative path inside a bundle root (rejects `..`). */
export function resolveBundlePath(bundlePath: string, rel: string): string {
  const root = path.resolve(bundlePath);
  const resolved = path.resolve(root, rel);
  const relFromRoot = path.relative(root, resolved);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    throw new Error(`Path escapes bundle root: ${rel}`);
  }
  return resolved;
}
