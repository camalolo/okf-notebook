/**
 * OKF cleanup pass — the maintenance phase that runs before a bundle's
 * daily digest (opt-in via `digest.cleanup` in the bundle settings).
 *
 * Flow:
 *   0. Fast skip: if the working tree is clean AND the last commit already
 *      is a completed OKF cleanup commit (`chore(okf):` …, but not the
 *      pre-run snapshot — see below), the pass is skipped entirely: the
 *      exact content it would target has already been through one.
 *   1. Pre-cleanup snapshot commit: any uncommitted WIP is committed first
 *      ("chore(okf): snapshot working tree before cleanup"), so the pass
 *      always starts from a committed state and everything the agent does
 *      afterwards can be undone with `git reset --hard <restorePoint>`.
 *      (This snapshot message deliberately does NOT satisfy the skip check:
 *      it is written *before* the agent runs, so a crash right after it
 *      must not block future passes.)
 *   2. `lintBundle()` computes a deterministic list of OKF conformance
 *      issues (missing `type`, missing title/description, empty bodies,
 *      duplicate titles) to ground the model.
 *   3. The agent (bundle-agent loop with WRITE_TOOLS: edit_file /
 *      create_file / delete_file / git_commit) organizes, deduplicates,
 *      validates, and fixes the .md files against the bundle's OKF.md spec
 *      (the full spec is already part of its system prompt), then commits.
 *   4. The runner verifies: if the working tree is still dirty after the
 *      agent finishes, it performs a safety commit itself so the digest
 *      phase always starts from a committed state.
 *
 * The run never throws — failures are captured in the returned record and
 * the caller (digest.ts) proceeds with the digest anyway.
 */

import { chatLogger, newTraceId } from './logger.js';
import { ensureGitRepo, openGit } from './git-repo.js';
import { runReadOnlyTask, type ToolCallRecord } from './bundle-agent.js';
import { lintBundle, formatOkfReport } from './okf-lint.js';
import { WRITE_TOOLS } from '../routes/chat.js';
import { fromAddress } from './mailer.js';
import type { BundleConfig } from '../config.js';

/** Identity used for commits made by background maintenance runs. */
const CLEANUP_AUTHOR = {
  name: 'Notebook Maintenance',
  email: fromAddress(),
  // Role is required by the User type but unused here — this identity only
  // feeds git_commit authorship inside the already-authorized cleanup run.
  role: 'full',
} as const;

const SAFETY_COMMIT_MESSAGE = 'chore(okf): auto-commit leftover cleanup changes';
const PRE_CLEANUP_MESSAGE = 'chore(okf): snapshot working tree before cleanup';

/**
 * Does a commit message mark a *completed* OKF cleanup pass? True for the
 * agent's own commits and the runner's safety commit (both written after
 * the agent finished), false for the pre-run snapshot (written before it —
 * a pass interrupted right after snapshotting must re-run next time).
 */
export function isOkfPassCommit(message: string): boolean {
  const msg = message.trim();
  return msg.startsWith('chore(okf):') && !msg.startsWith(PRE_CLEANUP_MESSAGE);
}

// --- Task prompt ------------------------------------------------------------

export function buildCleanupPrompt(lintMarkdown: string): string {
  return [
    'You are doing the OKF maintenance pass on this notebook, which runs right',
    'before the daily digest. Your job: organize, deduplicate, validate, and',
    'clean up the markdown files so the bundle conforms to the OKF spec',
    '(included in full in your system prompt).',
    '',
    '## Lint findings (deterministic, computed before your run)',
    lintMarkdown,
    '',
    '## What to do',
    '1. Fix every lint finding: add/repair frontmatter so each concept file has',
    '   a non-empty `type` and sensible `title`/`description` (derive them from',
    '   the content — never invent facts). Fill empty bodies or merge/delete',
    '   the file if it is a leftover stub.',
    '2. Deduplicate: when two notes cover the same subject, merge their content',
    '   into the better-named one, delete_file the redundant copy, and fix any',
    '   links pointing to it.',
    '3. Organize: move misplaced files into the right subdirectory when the',
    '   structure calls for it (create_file the new path, delete_file the old',
    '   one, then update links). Prefer few, meaningful directories.',
    '4. Keep every index.md accurate (OKF §6): entries link existing files and',
    '   carry the linked concept\'s description. Regenerate stale listings.',
    '5. If a root log.md exists, append a dated entry (OKF §7) summarizing what',
    '   you changed today.',
    '',
    '## Hard rules',
    '- Never edit or delete OKF.md, AGENTS.md, or any non-.md file.',
    '- This is cleanup, not rewriting: preserve existing prose and unknown',
    '  frontmatter keys (OKF §4.1 extensions).',
    '- Fix links that broke because of your own moves/deletions; leave other',
    '  broken links alone (OKF §5.3 — they may be not-yet-written knowledge).',
    '- Conservative by default: when unsure whether something is a duplicate or',
    '  misplaced, leave it alone.',
    '',
    'When done, stage and commit ALL your changes with git_commit using a',
    'message starting with "chore(okf):" (pass the touched files via `paths`).',
    'Then reply with a short summary of what you changed — or exactly',
    '"no changes needed" if the bundle was already clean.',
  ].join('\n');
}

// --- Types ------------------------------------------------------------------

export type CleanupStatus =
  | 'ok'      // agent completed (changes may or may not have been made)
  | 'error';  // exception during the run

export interface CleanupRunRecord {
  status: CleanupStatus;
  /**
   * True when the pass was skipped without running the agent: the tree was
   * clean and the last commit already was a completed OKF cleanup commit.
   */
  skipped: boolean;
  /** Lint violations found before the agent ran. */
  lintViolations: number;
  /** Duplicate-title groups found before the agent ran. */
  lintDuplicates: number;
  /** Whether the working tree ended up committed (agent or safety commit). */
  committed: boolean;
  /** Commit hashes produced during the run (short). */
  commits: string[];
  /**
   * Snapshot commit of pre-existing uncommitted WIP, made before the agent
   * touched anything. Null when the tree was already clean at start.
   */
  preCleanupCommit: string | null;
  /**
   * Restore point: reset --hard here to undo everything this pass did
   * (snapshot commit + agent commits + safety commit). Equals
   * preCleanupCommit when WIP was snapshotted, otherwise the HEAD commit
   * the run started from. Null only for a fresh repo with no commits.
   */
  restorePoint: string | null;
  /** Paths that were already dirty before the run started (user WIP). */
  preexistingDirty: string[];
  /** Number of LLM round-trips. */
  iterations: number;
  toolCalls: ToolCallRecord[];
  /** Final assistant summary. */
  summary: string;
  error: string | null;
}

// --- Main runner ------------------------------------------------------------

function dirtyPaths(status: import('simple-git').StatusResult): string[] {
  return status.files.filter((f) => f.working_dir !== ' ' || f.index !== ' ').map((f) => f.path);
}

/**
 * Pre-cleanup snapshot: commit any uncommitted WIP under the maintenance
 * identity so the cleanup agent can never destroy uncommitted work. Returns
 * the dirty paths found, the snapshot commit (null if the tree was clean),
 * and the restore point to `git reset --hard` to for undoing the whole pass
 * (the snapshot commit when one was made, otherwise the starting HEAD —
 * null only for a fresh repo with no commits at all).
 */
export async function snapshotWorkingTree(
  git: import('simple-git').SimpleGit,
  log?: ReturnType<typeof chatLogger>,
): Promise<{ dirty: string[]; preCleanupCommit: string | null; restorePoint: string | null }> {
  const dirty = dirtyPaths(await git.status());
  if (dirty.length === 0) {
    // Clean tree — HEAD is the restore point (fresh repo: none yet).
    try {
      return { dirty, preCleanupCommit: null, restorePoint: await git.revparse(['HEAD']) };
    } catch {
      return { dirty, preCleanupCommit: null, restorePoint: null };
    }
  }
  await git.add('-A');
  const snap = await git.commit(PRE_CLEANUP_MESSAGE, undefined, {
    '--author': `${CLEANUP_AUTHOR.name} <${CLEANUP_AUTHOR.email}>`,
  });
  const preCleanupCommit = snap.commit || null;
  log?.info(`Cleanup snapshot: committed ${dirty.length} dirty path(s) as ${preCleanupCommit} before starting`);
  return { dirty, preCleanupCommit, restorePoint: preCleanupCommit };
}

/**
 * Run the OKF cleanup pass for a bundle. Never throws — errors land in the
 * returned record (status: 'error') so the digest can proceed regardless.
 */
export async function runCleanupForBundle(
  bundle: BundleConfig,
  log: ReturnType<typeof chatLogger> = chatLogger(`c-${newTraceId()}`),
): Promise<CleanupRunRecord> {
  const record: CleanupRunRecord = {
    status: 'ok',
    skipped: false,
    lintViolations: 0,
    lintDuplicates: 0,
    committed: false,
    commits: [],
    preCleanupCommit: null,
    restorePoint: null,
    preexistingDirty: [],
    iterations: 0,
    toolCalls: [],
    summary: '',
    error: null,
  };

  try {
    await ensureGitRepo(bundle.path);
    const git = openGit(bundle.path);

    // Fast skip: clean tree + last commit already a completed OKF cleanup
    // commit → the exact content this pass would target has already been
    // through one; re-running would only burn LLM calls. (The pre-run
    // snapshot message intentionally fails isOkfPassCommit so an interrupted
    // pass always gets retried.)
    if ((await git.status()).isClean()) {
      let lastMessage: string | null = null;
      let lastHash: string | null = null;
      try {
        const last = await git.log({ maxCount: 1 });
        lastMessage = last.latest?.message ?? null;
        lastHash = last.latest?.hash ?? null;
      } catch {
        // fresh repo — no commits yet
      }
      if (lastMessage !== null && isOkfPassCommit(lastMessage)) {
        record.skipped = true;
        record.restorePoint = lastHash;
        record.summary =
          'Skipped: the working tree is clean and the last commit is already an OKF cleanup commit.';
        log.info(
          `Cleanup skipped for ${bundle.id}: tree clean and last commit ` +
            `${lastHash?.slice(0, 12)} is an OKF cleanup commit`,
        );
        return record;
      }
    }

    // Pre-cleanup snapshot: commit any uncommitted WIP so nothing can be
    // lost by mistake during the pass — every subsequent change lands on
    // top of a committed state and `git reset --hard <restorePoint>` undoes
    // the whole pass.
    const snap = await snapshotWorkingTree(git, log);
    record.preexistingDirty = snap.dirty;
    record.preCleanupCommit = snap.preCleanupCommit;
    record.restorePoint = snap.restorePoint;

    const lint = await lintBundle(bundle);
    record.lintViolations = lint.violations.length;
    record.lintDuplicates = lint.duplicates.length;
    log.info(
      `Cleanup lint: ${record.lintViolations} violations, ` +
        `${record.lintDuplicates} duplicate-title groups across ${lint.filesChecked} concept files`,
    );

    const result = await runReadOnlyTask(bundle, buildCleanupPrompt(formatOkfReport(lint)), {
      log,
      maxIterations: 40,
      extraTools: WRITE_TOOLS,
      user: CLEANUP_AUTHOR,
    });
    record.toolCalls = result.toolCalls;
    record.iterations = result.iterations;
    record.summary = result.content.trim();

    // Collect commits made by the agent.
    for (const tc of result.toolCalls) {
      if (tc.name === 'git_commit' && tc.result && typeof tc.result === 'object'
        && 'committed' in tc.result && tc.result.committed && typeof tc.result.hash === 'string') {
        record.commits.push(tc.result.hash);
      }
    }

    // Safety net: guarantee a committed tree before the digest phase.
    const after = await git.status();
    if (!after.isClean()) {
      await git.add('-A');
      const res = await git.commit(SAFETY_COMMIT_MESSAGE, undefined, {
        '--author': `${CLEANUP_AUTHOR.name} <${CLEANUP_AUTHOR.email}>`,
      });
      if (res.commit) record.commits.push(res.commit);
      log.warn(`Cleanup safety commit: ${res.commit} (agent left the tree dirty)`);
    }

    record.committed = record.commits.length > 0;
    log.info(
      `Cleanup done for ${bundle.id}: ${record.commits.length} commit(s)` +
        (result.capped ? ' — hit iteration cap!' : '') +
        (record.restorePoint ? ` — restore point: ${record.restorePoint}` : ''),
    );
    return record;
  } catch (err) {
    record.status = 'error';
    record.error = err instanceof Error ? err.message : String(err);
    log.errorTrace(`Cleanup error for ${bundle.id}`, err);
    return record;
  }
}

/** CLI entry: run cleanup for every bundle (or one), print summaries, exit codes handled by caller. */
export async function runCleanupTick(opts: { onlyBundleId?: string }): Promise<CleanupRunRecord[]> {
  const { loadBundles } = await import('../bundles.js');
  const bundles = await loadBundles();
  const targets = opts.onlyBundleId ? bundles.filter((b) => b.id === opts.onlyBundleId) : bundles;
  if (opts.onlyBundleId && targets.length === 0) {
    console.error(`[cleanup] bundle not found: ${opts.onlyBundleId}`);
    return [];
  }
  const records: CleanupRunRecord[] = [];
  for (const bundle of targets) {
    const log = chatLogger(`c-${newTraceId()}`);
    log.info(`Cleanup start: bundle=${bundle.id} (${bundle.name}) (manual)`);
    records.push(await runCleanupForBundle(bundle, log));
  }
  return records;
}
