import express from 'express';
import session from 'express-session';
import FileStore from 'session-file-store';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { PORT, HOST, SESSION_SECRET } from './config.js';
import { setupPassport, requireAuth } from './auth.js';
import bundlesRouter from './routes/bundles.js';
import searchRouter from './routes/search.js';
import chatsRouter from './routes/chats.js';
import authRouter from './routes/auth.js';
import { mcpManager } from './lib/mcp-manager.js';
import type { McpServerConfig } from './lib/mcp-manager.js';
import { startDigestScheduler, runDigestTick } from './lib/scheduler.js';

// --- MCP server configuration ------------------------------------------------

const MCP_SERVERS: McpServerConfig[] = [
  {
    name: 'google-workspace',
    command: 'npx',
    args: ['-y', '@alanxchen/google-workspace-mcp'],
    toolPrefix: 'gw',
    allowTools: [
      // Gmail (read-only)
      'search_emails',
      'read_email',
      // Calendar (full management)
      'list_calendars',
      'list_events',
      'get_event',
      'create_event',
      'update_event',
      'delete_event',
      'find_free_time',
      'quick_add_event',
    ],
  },
  {
    name: 'browser',
    command: 'npx',
    args: ['@playwright/mcp', '--browser', 'chromium', '--headless', '--no-sandbox', '--isolated'],
    allowTools: ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press_key'],
  },
];

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
app.use('/api/notebook/bundles', requireAuth, bundlesRouter);
app.use('/api/notebook/bundles', requireAuth, searchRouter);
app.use('/api/notebook/chats', requireAuth, chatsRouter);

// Serve built UI (production only — in dev, Vite serves the UI directly).
// Checks for the built index.html so this is inert during development.
const publicDir = path.join(import.meta.dirname, '..', 'public');
if (existsSync(path.join(publicDir, 'index.html'))) {
  app.use(express.static(publicDir));
  // SPA fallback: any non-API GET → index.html (enables client-side routing)
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) {
      return next();
    }
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}

// Start MCP servers then listen.
async function main() {
  // CLI: `node server/index.ts --run-digest [bundleId]` runs one digest tick
  // (all bundles, or a specific one), prints a short summary, and exits.
  // Bypasses the lastrun idempotency gate so you can iterate on the prompt.
  const digestArgIdx = process.argv.indexOf('--run-digest');
  if (digestArgIdx !== -1) {
    const onlyBundleId = process.argv[digestArgIdx + 1];
    const records = await runDigestTick({ onlyBundleId, force: true });
    if (onlyBundleId && records.length === 0) {
      // eslint-disable-next-line no-console
      console.error(`Bundle not found: ${onlyBundleId}`);
      process.exit(1);
    }
    for (const r of records) {
      const detail = r.subject ? ` subject="${r.subject}"` : '';
      // eslint-disable-next-line no-console
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

  await mcpManager.start(MCP_SERVERS);

  app.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`Notebook API listening on ${HOST}:${PORT}`);
  });

  // Start the daily digest cron (no-op if DIGEST_DISABLED=1).
  startDigestScheduler();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
