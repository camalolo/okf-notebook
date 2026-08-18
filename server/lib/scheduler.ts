/**
 * Daily digest scheduler.
 *
 * Starts a node-cron job that fires DIGEST_CRON (default 8am) in DIGEST_TZ
 * (default Asia/Taipei). Each tick:
 *   1. Loads bundles fresh from disk (so newly-added bundles are picked up).
 *   2. For each bundle, checks the per-bundle lastrun date; skips if it
 *      already ran today (idempotency against restarts / dev hot-reloads).
 *   3. Runs the digest and advances lastrun regardless of outcome (so a
 *      failure doesn't cause a retry storm).
 *
 * Manual trigger:
 *   `node server/index.ts --run-digest [bundleId]`
 * bypasses the lastrun gate and exits when done. See cliDigest().
 */

import cron, { type ScheduledTask } from 'node-cron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadBundles } from '../bundles.js';
import {
  DIGEST_CRON,
  DIGEST_DISABLED,
  DIGEST_TO,
  DIGEST_TZ,
} from '../config.js';
import { runDigestForBundle, type DigestRunRecord } from './digest.js';

const DATA_DIR = path.resolve(import.meta.dirname, '..', '..', 'data', 'digests');
const LASTRUN_FILE = path.join(DATA_DIR, 'lastrun.json');

type LastRunMap = Record<string, string>;

async function readLastRun(): Promise<LastRunMap> {
  try {
    const raw = await fs.readFile(LASTRUN_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed as LastRunMap : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    console.warn('[digest] lastrun.json unreadable, treating as empty:', err);
    return {};
  }
}

async function writeLastRun(map: LastRunMap): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(LASTRUN_FILE, JSON.stringify(map, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error('[digest] failed to persist lastrun.json:', err);
  }
}

function todayStamp(tz: string): string {
  return new Date().toLocaleString('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
}

let scheduledTask: ScheduledTask | null = null;

/**
 * Run today's digest for every registered bundle (or a single bundle if `onlyBundleId`
 * is provided). When `force` is false, bundles already processed today are skipped.
 */
export async function runDigestTick(opts: {
  onlyBundleId?: string;
  force?: boolean;
}): Promise<DigestRunRecord[]> {
  const today = todayStamp(DIGEST_TZ);
  const bundles = await loadBundles();
  const targets = opts.onlyBundleId
    ? bundles.filter((b) => b.id === opts.onlyBundleId)
    : bundles;

  if (opts.onlyBundleId && targets.length === 0) {
    console.error(`[digest] bundle not found: ${opts.onlyBundleId}`);
    return [];
  }

  const lastrun = opts.force ? {} : await readLastRun();
  const updated: LastRunMap = { ...lastrun };
  const records: DigestRunRecord[] = [];

  for (const bundle of targets) {
    if (bundle.digest?.enabled === false) {
      console.log(`[digest] ${bundle.id}: disabled in bundle settings, skipping`);
      continue;
    }

    if (lastrun[bundle.id] === today) {
      console.log(`[digest] ${bundle.id}: already ran today (${today}), skipping`);
      continue;
    }

    const record = await runDigestForBundle(bundle, DIGEST_TZ);
    records.push(record);

    // Advance lastrun regardless of success/failure — a failed run still
    // counts as "tried today" so we don't retry-loop a broken bundle.
    updated[bundle.id] = today;
    await writeLastRun(updated);
  }

  return records;
}

/** Start the daily cron. No-op if DIGEST_DISABLED=1 or DIGEST_TO is unset. */
export function startDigestScheduler(): void {
  if (DIGEST_DISABLED) {
    console.log('[digest] scheduler disabled (DIGEST_DISABLED=1)');
    return;
  }

  if (!DIGEST_TO) {
    console.warn('[digest] DIGEST_TO not set — scheduler running but will not email. Set DIGEST_TO to enable.');
  }

  if (!cron.validate(DIGEST_CRON)) {
    console.error(`[digest] invalid DIGEST_CRON expression "${DIGEST_CRON}" — scheduler not started`);
    return;
  }

  console.log(`[digest] scheduler armed: "${DIGEST_CRON}" tz=${DIGEST_TZ} → ${DIGEST_TO}`);

  scheduledTask = cron.schedule(
    DIGEST_CRON,
    () => {
      console.log(`[digest] tick ${new Date().toISOString()} — running all bundles`);
      runDigestTick({}).catch((err) => {
        console.error('[digest] tick failed:', err);
      });
    },
    { timezone: DIGEST_TZ },
  );
}

/** Stop the scheduled task (for tests / graceful shutdown). */
export function stopDigestScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}
