import express from 'express';
import session from 'express-session';
import FileStore from 'session-file-store';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { PORT, HOST, SESSION_SECRET } from './config.js';
import { setupPassport, requireAuth, requireBundleAccess } from './auth.js';
import bundlesRouter from './routes/bundles.js';
import searchRouter from './routes/search.js';
import chatsRouter from './routes/chats.js';
import authRouter from './routes/auth.js';
import { settingsRouter } from './routes/settings.js';
import { mcpsRouter } from './routes/mcps.js';
import { mcpManager } from './lib/mcp-manager.js';
import { listModels } from './lib/llm.js';
import { loadMcpServers } from './mcps.js';
import { finalizeOrphanedTurns } from './chats.js';
import { startDigestScheduler, runDigestTick } from './lib/scheduler.js';
import { runCleanupTick } from './lib/cleanup.js';

const app = express();

// Behind nginx — trust one proxy hop so req.protocol/host reflect the origin
// (required for the dynamic OAuth callback URL to be https://...).
app.set('trust proxy', 1);

app.use(express.json({ limit: '10mb' }));

// File-backed session store so sessions survive server restarts.
// Sessions are stored as JSON files under server/data/sessions/.
const sessionStore = new (FileStore(session))({
  path: path.join(import.meta.dirname, 'data', 'sessions'),
  logFn: () => {}, // silence verbose logging
});

app.use(
  session({
    secret: SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  }),
);
setupPassport(app);

// Routes
app.use('/api/notebook/auth', authRouter);
app.use('/api/notebook/bundles', requireAuth, requireBundleAccess, bundlesRouter);
app.use('/api/notebook/bundles', requireAuth, requireBundleAccess, searchRouter);
app.use('/api/notebook/chats', requireAuth, requireBundleAccess, chatsRouter);
app.use('/api/notebook/settings', requireAuth, settingsRouter);
app.use('/api/notebook/mcps', requireAuth, mcpsRouter);

// Serve built UI (production only — in dev, Vite serves the UI directly).
// Checks for the built index.html so this is inert during development.
const publicDir = path.join(import.meta.dirname, '..', 'public');
if (existsSync(path.join(publicDir, 'index.html'))) {
  // HTML must always be revalidated so deploys (newly hashed assets) are
  // picked up on reload — a stale index.html keeps serving the old bundle
  // after a deploy. Hashed assets under /assets can cache forever.
  app.use(
    express.static(publicDir, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        else if (filePath.startsWith(path.join(publicDir, 'assets'))) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  // SPA fallback: any non-API GET → index.html (enables client-side routing)
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) {
      return next();
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}

// Start MCP servers then listen.
async function main() {
  // CLI: `node server/index.ts --run-cleanup [bundleId]` runs ONLY the OKF
  // cleanup pass (all bundles, or a specific one — regardless of the
  // digest.cleanup setting), prints a summary, and exits. Use it to preview
  // what the maintenance agent would change before enabling it per bundle.
  const cleanupArgIdx = process.argv.indexOf('--run-cleanup');
  if (cleanupArgIdx !== -1) {
    const onlyBundleId = process.argv[cleanupArgIdx + 1];
    const records = await runCleanupTick({ onlyBundleId });
    if (onlyBundleId && records.length === 0) {

      console.error(`Bundle not found: ${onlyBundleId}`);
      process.exit(1);
    }
    for (const r of records) {

      console.log(
        `[cleanup] ${r.status}${r.skipped ? ' (skipped — last commit is an OKF cleanup commit, tree clean)' : ''}: ` +
          `lint=${r.lintViolations} violations / ${r.lintDuplicates} dup-groups, ` +
          `${r.commits.length} commit(s), ${r.iterations} iter` +
          (r.restorePoint ? `, restore=${r.restorePoint.slice(0, 12)}` : '') +
          (r.error ? ` ERROR: ${r.error}` : ` summary="${r.summary.slice(0, 120)}"`),
      );
    }
    process.exit(records.some((r) => r.status === 'error') ? 1 : 0);
  }

  // CLI: `node server/index.ts --run-digest [bundleId]` runs one digest tick
  // (all bundles, or a specific one), prints a short summary, and exits.
  // Bypasses the lastrun idempotency gate so you can iterate on the prompt.
  const digestArgIdx = process.argv.indexOf('--run-digest');
  if (digestArgIdx !== -1) {
    const onlyBundleId = process.argv[digestArgIdx + 1];
    const records = await runDigestTick({ onlyBundleId, force: true });
    if (onlyBundleId && records.length === 0) {

      console.error(`Bundle not found: ${onlyBundleId}`);
      process.exit(1);
    }
    for (const r of records) {
      const detail = r.subject ? ` subject="${r.subject}"` : '';

      console.log(
        `[digest] ${r.bundleId}: ${r.status} (${r.iterations} iter, ${r.durationMs}ms${detail})` +
        (r.error ? ` ERROR: ${r.error}` : ''),
      );
    }
    const anyError = records.some(
      (r) => r.status === 'error' || r.status === 'parse_failed',
    );
    process.exit(anyError ? 1 : 0);
  }

  // MCP servers come from server/data/mcps.json (Settings → MCP servers).
  await mcpManager.start(await loadMcpServers());

  // Close turns orphaned by a previous restart/crash (their loop died before
  // persisting turn_end; reconnecting clients would poll forever otherwise).
  await finalizeOrphanedTurns();

  // Warm the /models cache in the background — it also captures per-model
  // metadata (context_length), so the context indicator is exact from the
  // first chat turn instead of falling back to the family-map guess.
  listModels().catch(() => { /* best-effort — retried on next Settings load */ });

  app.listen(PORT, HOST, () => {

    console.log(`Notebook API listening on ${HOST}:${PORT}`);
  });

  // Start the daily digest cron (no-op if DIGEST_DISABLED=1).
  startDigestScheduler();
}

main().catch((err) => {

  console.error('Fatal startup error:', err);
  process.exit(1);
});
