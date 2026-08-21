/**
 * Git helper for bundles.
 *
 * Bundles are plain directories that may not be git repos yet (e.g. freshly
 * registered). Rather than failing every git call with "fatal: not a git
 * repository", we initialize the repo lazily the first time a git tool or
 * route touches it.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const simpleGit = require('simple-git') as (cwd: string) => import('simple-git').SimpleGit;

/** Open a SimpleGit instance for a bundle directory (does NOT init). */
export function openGit(bundlePath: string): import('simple-git').SimpleGit {
  return simpleGit(bundlePath);
}

/**
 * Ensure the bundle directory is a git repository, running `git init` when it
 * isn't. Returns true when a fresh repo was created (callers may use this to
 * report/short-circuit, e.g. an empty commit log).
 */
export async function ensureGitRepo(bundlePath: string): Promise<boolean> {
  if (existsSync(join(bundlePath, '.git'))) return false;
  await simpleGit(bundlePath).init();
  console.log(`[git] initialized new repository in ${bundlePath}`);
  return true;
}

/** Whether a `git log` failure is just "no commits yet" on a fresh repo. */
export function isNoCommitsError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('does not have any commits yet') || msg.includes('fatal: your current branch');
}
