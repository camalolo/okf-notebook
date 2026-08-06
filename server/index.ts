import express from 'express';
import session from 'express-session';
import FileStore from 'session-file-store';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { PORT, SESSION_SECRET, USERS } from './config.js';
import { setupPassport, requireAuth } from './auth.js';
import bundlesRouter from './routes/bundles.js';
import searchRouter from './routes/search.js';
import chatsRouter from './routes/chats.js';
import authRouter from './routes/auth.js';
import { mcpManager } from './lib/mcp-manager.js';
import type { McpServerConfig } from './lib/mcp-manager.js';

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

// Dev bypass: auto-authenticate as a configured user without OAuth.
// Activated by setting DEV_BYPASS_EMAIL in the environment.
// Only applies to requests from the LAN (loopback or 192.168.x.x).
const DEV_BYPASS_EMAIL = process.env.DEV_BYPASS_EMAIL || '';
if (DEV_BYPASS_EMAIL) {
  // eslint-disable-next-line no-console
  console.log(`[auth] DEV_BYPASS_EMAIL set — auto-login from LAN only`);
}
app.use((req, res, next) => {
  if (DEV_BYPASS_EMAIL && !req.isAuthenticated()) {
    const ip = req.socket.remoteAddress || '';
    const isLan = ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.');
    if (isLan) {
      const role = USERS[DEV_BYPASS_EMAIL];
      if (role) {
        req.login({ email: DEV_BYPASS_EMAIL, name: DEV_BYPASS_EMAIL.split('@')[0], role }, () => {
          next();
        });
        return;
      }
    }
  }
  next();
});

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
  await mcpManager.start(MCP_SERVERS);

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Notebook API listening on port ${PORT}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
