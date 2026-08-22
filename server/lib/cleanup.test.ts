/**
 * Integration tests for the cleanup runner (real git repos in a temp dir):
 * the pre-cleanup snapshot (uncommitted WIP committed under the maintenance
 * identity, restore point semantics) and the clean-tree skip fast path.
 * The agent loop is mocked — these tests exercise the runner's git logic,
 * not the LLM.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openGit } from './git-repo.js';

vi.mock('./bundle-agent.js', () => ({
  // The mocked agent reports a completed no-op pass (no commits).
  runReadOnlyTask: vi.fn(async () => ({
    content: 'mocked agent summary',
    toolCalls: [],
    iterations: 1,
    capped: false,
  })),
}));

import { snapshotWorkingTree, runCleanupForBundle, isOkfPassCommit } from './cleanup.js';
import { runReadOnlyTask } from './bundle-agent.js';
import { fromAddress } from './mailer.js';
import type { BundleConfig } from '../config.js';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'notebook-cleanup-test-'));

async function freshRepo(name: string): Promise<string> {
  const dir = path.join(tmpRoot, name);
  await fs.mkdir(dir, { recursive: true });
  const git = openGit(dir);
  await git.init();
  // Local identity so commits work regardless of the machine's global config.
  await git.addConfig('user.name', 'Test Committer');
  await git.addConfig('user.email', 'test@example.com');
  return dir;
}

function bundleFor(dir: string): BundleConfig {
  return { id: 'test', name: 'Test', path: dir, icon: '', description: '' };
}

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('snapshotWorkingTree', () => {
  it('returns null restore point for a fresh repo with no commits and a clean tree', async () => {
    const dir = await freshRepo('empty');
    const r = await snapshotWorkingTree(openGit(dir));
    expect(r).toEqual({ dirty: [], preCleanupCommit: null, restorePoint: null });
  });

  it('commits untracked and modified WIP and returns the snapshot as restore point', async () => {
    const dir = await freshRepo('wip');
    const git = openGit(dir);
    await fs.writeFile(path.join(dir, 'a.md'), 'committed base\n');
    await git.add('-A');
    await git.commit('base');

    // User WIP: one modified tracked file, one untracked file.
    await fs.writeFile(path.join(dir, 'a.md'), 'committed base\nplus WIP line\n');
    await fs.writeFile(path.join(dir, 'b.md'), 'untracked WIP\n');

    const r = await snapshotWorkingTree(git);
    expect(new Set(r.dirty)).toEqual(new Set(['a.md', 'b.md']));
    expect(r.preCleanupCommit).toBeTruthy();
    expect(r.restorePoint).toBe(r.preCleanupCommit);

    // Tree is now clean — nothing left to lose.
    const status = await git.status();
    expect(status.isClean()).toBe(true);

    // The snapshot commit carries the expected message and author.
    const log = await git.log({ maxCount: 1 });
    expect(log.latest?.message.trim()).toBe('chore(okf): snapshot working tree before cleanup');
    expect(log.latest?.author_name).toBe('Notebook Maintenance');
    expect(log.latest?.author_email).toBe(fromAddress());

    // WIP content survives in the committed tree.
    await expect(fs.readFile(path.join(dir, 'b.md'), 'utf8')).resolves.toContain('untracked WIP');
  });

  it('uses HEAD as restore point when the tree is already clean', async () => {
    const dir = await freshRepo('clean');
    const git = openGit(dir);
    await fs.writeFile(path.join(dir, 'a.md'), 'committed\n');
    await git.add('-A');
    const base = await git.commit('base');

    const r = await snapshotWorkingTree(git);
    expect(r).toEqual({ dirty: [], preCleanupCommit: null, restorePoint: base.commit });
    // No extra commit was created.
    const log = await git.log({ maxCount: 10 });
    expect(log.total).toBe(1);
  });

  it('makes a later destructive change fully revertable via the restore point', async () => {
    const dir = await freshRepo('revert');
    const git = openGit(dir);
    await fs.writeFile(path.join(dir, 'keep.md'), 'precious WIP\n');
    const { restorePoint } = await snapshotWorkingTree(git);
    expect(restorePoint).toBeTruthy();

    // Simulate a botched cleanup: delete the file and commit the deletion.
    await fs.rm(path.join(dir, 'keep.md'));
    await git.add('-A');
    await git.commit('chore(okf): botched cleanup');

    // Undo the whole pass.
    await git.reset(['--hard', restorePoint!]);
    await fs.readFile(path.join(dir, 'keep.md'), 'utf8');
  });
});

describe('isOkfPassCommit', () => {
  it('accepts agent and safety commit messages, rejects the pre-run snapshot', () => {
    expect(isOkfPassCommit('chore(okf): fix frontmatter, refresh indexes')).toBe(true);
    expect(isOkfPassCommit('chore(okf): auto-commit leftover cleanup changes')).toBe(true);
    expect(isOkfPassCommit('chore(okf): snapshot working tree before cleanup')).toBe(false);
    expect(isOkfPassCommit('feat: something else')).toBe(false);
    expect(isOkfPassCommit('')).toBe(false);
  });
});

describe('runCleanupForBundle — clean-tree skip', () => {
  it('skips without invoking the agent when the last commit is an OKF pass commit and the tree is clean', async () => {
    const dir = await freshRepo('skip');
    const git = openGit(dir);
    await fs.writeFile(path.join(dir, 'a.md'), 'content\n');
    await git.add('-A');
    const base = await git.commit('user work');
    expect(base.commit).toBeTruthy();
    // Change content so the pass commit is real (an empty staged set makes
    // git commit a silent no-op).
    await fs.writeFile(path.join(dir, 'a.md'), 'content\ntidied\n');
    await git.add('-A');
    const pass = await git.commit('chore(okf): tidy up');
    expect(pass.commit).toBeTruthy();

    vi.mocked(runReadOnlyTask).mockClear();
    const r = await runCleanupForBundle(bundleFor(dir));

    expect(r.skipped).toBe(true);
    expect(r.status).toBe('ok');
    expect(r.iterations).toBe(0);
    expect(runReadOnlyTask).not.toHaveBeenCalled();
    expect(r.restorePoint).toBe(pass.commit);
    // No new commits.
    const log = await git.log({ maxCount: 10 });
    expect(log.total).toBe(2);
    expect(log.latest?.hash).toBe(pass.commit);
    expect(r.summary).toContain('Skipped');
  });

  it('runs when the last commit is a user commit (even on a clean tree)', async () => {
    const dir = await freshRepo('noskip-user');
    const git = openGit(dir);
    await fs.writeFile(path.join(dir, 'a.md'), 'content\n');
    await git.add('-A');
    await git.commit('user work');

    vi.mocked(runReadOnlyTask).mockClear();
    const r = await runCleanupForBundle(bundleFor(dir));

    expect(r.skipped).toBe(false);
    expect(runReadOnlyTask).toHaveBeenCalledTimes(1);
    expect(r.iterations).toBe(1);
  });

  it('runs when the tree is dirty, even if the last commit is an OKF pass commit', async () => {
    const dir = await freshRepo('noskip-dirty');
    const git = openGit(dir);
    await fs.writeFile(path.join(dir, 'a.md'), 'content\n');
    await git.add('-A');
    await git.commit('chore(okf): previous pass');
    // New uncommitted user WIP on top of a pass commit.
    await fs.writeFile(path.join(dir, 'b.md'), 'new WIP\n');

    vi.mocked(runReadOnlyTask).mockClear();
    const r = await runCleanupForBundle(bundleFor(dir));

    expect(r.skipped).toBe(false);
    expect(runReadOnlyTask).toHaveBeenCalledTimes(1);
    // The WIP got snapshotted before the agent ran.
    expect(r.preCleanupCommit).toBeTruthy();
    expect(r.preexistingDirty).toEqual(['b.md']);
    expect((await git.status()).isClean()).toBe(true);
  });

  it('runs when the last commit is the pre-run snapshot (interrupted pass gets retried)', async () => {
    const dir = await freshRepo('noskip-snapshot');
    const git = openGit(dir);
    await fs.writeFile(path.join(dir, 'a.md'), 'content\n');
    await git.add('-A');
    await git.commit('chore(okf): snapshot working tree before cleanup');

    vi.mocked(runReadOnlyTask).mockClear();
    const r = await runCleanupForBundle(bundleFor(dir));

    expect(r.skipped).toBe(false);
    expect(runReadOnlyTask).toHaveBeenCalledTimes(1);
  });

  it('runs on a fresh repo with no commits', async () => {
    const dir = await freshRepo('noskip-fresh');
    vi.mocked(runReadOnlyTask).mockClear();
    const r = await runCleanupForBundle(bundleFor(dir));
    expect(r.skipped).toBe(false);
    expect(runReadOnlyTask).toHaveBeenCalledTimes(1);
  });
});
