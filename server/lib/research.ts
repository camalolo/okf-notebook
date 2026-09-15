/**
 * Knowledge-verification pass — the research phase that runs before a
 * bundle's daily digest (opt-in via `digest.research` in the bundle
 * settings), after the OKF cleanup pass (if enabled) and before the digest
 * review.
 *
 * Where the cleanup pass grounds its edits in a deterministic lint report,
 * this pass grounds its edits in the live web: the agent reads the bundle's
 * factual claims, verifies them against actual source pages (web_search to
 * find candidates + web_fetch to read them; erc20_balances for on-chain
 * holdings), and surgically updates anything stale or wrong, committing as
 * it goes.
 *
 * Flow (mirrors cleanup.ts):
 *   1. Pre-research snapshot commit: any uncommitted WIP is committed first
 *      ("docs(verify): snapshot working tree before research") so the pass
 *      always starts from a committed state and everything afterwards can be
 *      undone with `git reset --hard <restorePoint>`. (When the cleanup pass
 *      runs first it has already left a committed tree, so this is normally
 *      a no-op.)
 *   2. The agent (bundle-agent loop with the default READONLY_TOOLS — which
 *      include web_search — plus WRITE_TOOLS: edit_file / create_file /
 *      delete_file / git_commit) verifies facts online and updates the
 *      .md files, then commits with a `docs(verify):` message.
 *   3. The runner verifies: if the working tree is still dirty after the
 *      agent finishes, it performs a safety commit itself so the digest
 *      phase always starts from a committed state.
 *
 * Unlike the cleanup pass there is no fast-skip: facts drift daily, so every
 * scheduled run gets a fresh verification chance. (The digest-level lastrun
 * gate already limits this to once per day.)
 *
 * The run never throws — failures are captured in the returned record and
 * the caller (digest.ts) proceeds with the digest anyway.
 */

import { chatLogger, newTraceId } from './logger.js';
import { ensureGitRepo, openGit } from './git-repo.js';
import { runReadOnlyTask, type ToolCallRecord } from './bundle-agent.js';
import { WRITE_TOOLS } from '../routes/chat.js';
import { MAINTENANCE_AUTHOR, snapshotWorkingTree } from './cleanup.js';
import type { BundleConfig } from '../config.js';

const SAFETY_COMMIT_MESSAGE = 'docs(verify): auto-commit leftover research changes';
const PRE_RESEARCH_MESSAGE = 'docs(verify): snapshot working tree before research';

/**
 * Does a commit message mark a *completed* research pass? True for the
 * agent's own commits and the runner's safety commit (both written after
 * the agent finished), false for the pre-run snapshot (written before it —
 * a pass interrupted right after snapshotting must re-run next time).
 * (Mirrors isOkfPassCommit in cleanup.ts.)
 */
export function isResearchCommit(message: string): boolean {
  const msg = message.trim();
  return msg.startsWith('docs(verify):') && !msg.startsWith(PRE_RESEARCH_MESSAGE);
}

// --- Task prompt ------------------------------------------------------------

export function buildResearchPrompt(today: string): string {
  return [
    'You are doing the nightly knowledge-verification pass on this notebook,',
    'which runs right before the daily digest. Your job: verify the notebook\'s',
    'factual claims against the live web, and directly update anything stale,',
    'wrong, or outdated — editing the files and committing the changes.',
    '',
    `Today's date: ${today}.`,
    '',
    '## What to do',
    '1. Call list_files, then read_file the concept files that carry factual,',
    '   time-sensitive content — numbers, prices, balances, versions, statuses,',
    '   schedules, deadlines, external references, "as of ..." notes. Skip',
    '   purely personal, historical, or opinion material.',
    '2. Build a short list of checkable claims (about 5-15). Prioritize',
    '   volatile facts first — anything likely to have changed recently.',
    '3. Verify each claim against current, authoritative sources: web_search',
    '   to find candidates, then web_fetch the most authoritative result(s)',
    '   and confirm the claim against the actual page content. For numbers,',
    '   dates, and thresholds never rely on the search snippet alone — read',
    '   the page. For on-chain token holdings you may use erc20_balances.',
    '4. Update what is verifiably stale or wrong: edit_file the specific',
    '   passages (surgical edits — preserve prose style and unrelated',
    '   content), and where it fits naturally add the current value with',
    '   "verified <today>" and cite the page URL you actually fetched with',
    '   web_fetch (not just a search result). When verification surfaces',
    '   important new knowledge that clearly belongs in this notebook,',
    '   create_file a new concept note for it (frontmatter per OKF.md).',
    '5. If a root log.md exists, append a dated entry (OKF §7) summarizing',
    '   what you verified and changed. Keep index.md accurate if you added',
    '   or restructured files.',
    '6. Commit ALL your changes with git_commit, message starting with',
    '   "docs(verify):" (pass the touched files via `paths`).',
    '',
    '## Hard rules',
    '- Never invent facts. If the web cannot confirm or refute a claim (no',
    '  usable source, page unreadable, sources conflict without a clear',
    '  winner), leave the file untouched and report it under "unverifiable"',
    '  or "conflicting" in your summary.',
    '- If sources conflict, prefer the most authoritative and recent, and',
    '  note the conflict in your summary instead of silently choosing.',
    '- Surgical edits only: this is fact maintenance, not rewriting. Never',
    '  edit or delete OKF.md, AGENTS.md, or any non-.md file.',
    '- The digest review runs right after you and plans the user\'s day from',
    '  this content — leave it accurate and trustworthy.',
    '- Conservative scope: if nothing in the bundle is verifiable online,',
    '  commit nothing and reply exactly "nothing to verify".',
    '',
    'When done, reply with a short summary: claims checked, updates made',
    '(file + what changed + source), and any unverifiable or conflicting',
    'items.',
  ].join('\n');
}

// --- Types ------------------------------------------------------------------

export type ResearchStatus =
  | 'ok'      // agent completed (changes may or may not have been made)
  | 'error';  // exception during the run

export interface ResearchRunRecord {
  status: ResearchStatus;
  /** Whether the working tree ended up committed (agent or safety commit). */
  committed: boolean;
  /** Commit hashes produced during the run (short). */
  commits: string[];
  /**
   * Snapshot commit of pre-existing uncommitted WIP, made before the agent
   * touched anything. Null when the tree was already clean at start.
   */
  preResearchCommit: string | null;
  /**
   * Restore point: reset --hard here to undo everything this pass did.
   * Equals preResearchCommit when WIP was snapshotted, otherwise the HEAD
   * commit the run started from. Null only for a fresh repo with no commits.
   */
  restorePoint: string | null;
  /** Paths that were already dirty before the run started (user WIP). */
  preexistingDirty: string[];
  /** Number of web_search calls the agent made. */
  webSearches: number;
  /** Number of file writes (edit_file + create_file + delete_file). */
  fileWrites: number;
  /** Number of LLM round-trips. */
  iterations: number;
  toolCalls: ToolCallRecord[];
  /** Final assistant summary. */
  summary: string;
  error: string | null;
}

// --- Main runner ------------------------------------------------------------

/**
 * Run the knowledge-verification pass for a bundle. Never throws — errors
 * land in the returned record (status: 'error') so the digest can proceed
 * regardless.
 *
 * @param today Today's date as YYYY-MM-DD (used for "verified <date>"
 *              annotations in the prompt). Defaults to the server-local date.
 */
export async function runResearchForBundle(
  bundle: BundleConfig,
  log: ReturnType<typeof chatLogger> = chatLogger(`r-${newTraceId()}`),
  today: string = new Date().toISOString().slice(0, 10),
): Promise<ResearchRunRecord> {
  const record: ResearchRunRecord = {
    status: 'ok',
    committed: false,
    commits: [],
    preResearchCommit: null,
    restorePoint: null,
    preexistingDirty: [],
    webSearches: 0,
    fileWrites: 0,
    iterations: 0,
    toolCalls: [],
    summary: '',
    error: null,
  };

  try {
    await ensureGitRepo(bundle.path);
    const git = openGit(bundle.path);

    // Pre-research snapshot: commit any uncommitted WIP so nothing can be
    // lost by mistake during the pass (no-op when cleanup already left a
    // committed tree).
    const snap = await snapshotWorkingTree(git, log, PRE_RESEARCH_MESSAGE);
    record.preexistingDirty = snap.dirty;
    record.preResearchCommit = snap.preCleanupCommit;
    record.restorePoint = snap.restorePoint;
    if (snap.dirty.length > 0) {
      log.info(`Research snapshot: committed ${snap.dirty.length} dirty path(s) as ${snap.preCleanupCommit}`);
    }

    const result = await runReadOnlyTask(bundle, buildResearchPrompt(today), {
      log,
      maxIterations: 40,
      extraTools: WRITE_TOOLS,
      user: MAINTENANCE_AUTHOR,
      // Inherit the bundle's thinking setting — verification is mechanical
      // read/search/edit work; most bundles don't need chain-of-thought.
      thinking: bundle.thinking === 'on' ? undefined : 'off',
    });
    record.toolCalls = result.toolCalls;
    record.iterations = result.iterations;
    record.summary = result.content.trim();
    record.webSearches = result.toolCalls.filter((tc) => tc.name === 'web_search').length;
    record.fileWrites = result.toolCalls.filter(
      (tc) => tc.name === 'edit_file' || tc.name === 'create_file' || tc.name === 'delete_file',
    ).length;

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
        '--author': `${MAINTENANCE_AUTHOR.name} <${MAINTENANCE_AUTHOR.email}>`,
      });
      if (res.commit) record.commits.push(res.commit);
      log.warn(`Research safety commit: ${res.commit} (agent left the tree dirty)`);
    }

    record.committed = record.commits.length > 0;
    log.info(
      `Research done for ${bundle.id}: ${record.webSearches} search(es), ` +
        `${record.fileWrites} file write(s), ${record.commits.length} commit(s)` +
        (result.capped ? ' — hit iteration cap!' : '') +
        (record.restorePoint ? ` — restore point: ${record.restorePoint}` : ''),
    );
    return record;
  } catch (err) {
    record.status = 'error';
    record.error = err instanceof Error ? err.message : String(err);
    log.errorTrace(`Research error for ${bundle.id}`, err);
    return record;
  }
}

/** CLI entry: run research for every bundle (or one), print summaries, exit codes handled by caller. */
export async function runResearchTick(opts: { onlyBundleId?: string }): Promise<ResearchRunRecord[]> {
  const { loadBundles } = await import('../bundles.js');
  const bundles = await loadBundles();
  const targets = opts.onlyBundleId ? bundles.filter((b) => b.id === opts.onlyBundleId) : bundles;
  if (opts.onlyBundleId && targets.length === 0) {
    console.error(`[research] bundle not found: ${opts.onlyBundleId}`);
    return [];
  }
  const records: ResearchRunRecord[] = [];
  for (const bundle of targets) {
    const log = chatLogger(`r-${newTraceId()}`);
    log.info(`Research start: bundle=${bundle.id} (${bundle.name}) (manual)`);
    records.push(await runResearchForBundle(bundle, log));
  }
  return records;
}
