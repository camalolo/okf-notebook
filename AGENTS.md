# Notebook — OKF Knowledge Browser

A web app for browsing/editing OKF (Open Knowledge Format) markdown bundles,
chatting with an LLM that can read files and edit them directly, and managing
git commits — all through an agentic chat interface.

## Commands

```bash
npm install
npm run dev:all    # Vite (5173) + Express (3002) concurrently, both hot-reloading
npm run dev        # frontend only
npm run dev:server # backend only (tsx watch)
npm run build      # typecheck → build UI → compile server (→ dist/, no deploy)
npm run build:server # compile just the server to dist/server/
npm run deploy     # build everything, then deploy to $DEPLOY_DIR
npm run deploy:server # deploy just the server (skip UI rebuild, faster)
npm run lint       # eslint
npm test           # vitest run (one-shot)
npm run test:watch # vitest watch mode
npm start          # production: tsx server/index.ts
```

**Runtime**: Node 20.11+ (server uses `import.meta.dirname`). Requires the bundle
directories referenced in `server/bundles.json` to exist on the local filesystem.

**Build output**: `vite.config.ts` builds the UI to `dist/public/`, and
`tsc -p tsconfig.server.json` compiles the server to `dist/server/`.
`scripts/deploy.mjs` deploys the `dist/` tree to the directory named by
`DEPLOY_DIR` (env var, or a `DEPLOY_DIR=` line in `.env`); it exits with an
error when neither is set.

## Deployment & Service Management

Both the UI and the compiled server are deployed to the same directory
(`DEPLOY_DIR`, e.g. `/srv/notebook`). Express serves both the API and the
static UI from a single process. The production layout is:

```
{DEPLOY_DIR}/
  public/            ← Vite build output (served by Express)
    index.html
    assets/          ← Vite hashed bundles
  server/            ← Compiled backend (plain JS, not TS)
    index.js
    routes/
    lib/
    node_modules/    ← production deps (npm install --omit=dev)
    package.json
    bundles.json     ← runtime (seeded on first start)
    data/            ← runtime (session store)
  data/
    chats/           ← runtime (chat persistence, one level above server/)
  .env               ← copied from Sources/Notebook/.env during deploy
```

The backend runs as a **user systemd service** — not a system-level service.

```bash
# Service file (user-level)
# ~/.config/systemd/user/notebook.service

# Deploy everything (UI + server)
npm run deploy         # build + deploy both
npm run deploy:server  # deploy just the server (skip UI rebuild, faster)

# Then restart the service to pick up new server code
systemctl --user restart notebook.service

# Check status / view logs
systemctl --user status notebook.service
journalctl --user -u notebook.service -f
journalctl --user -u notebook.service --since "5 min ago"
```

**How `npm run deploy` works** (in order):
1. `tsc -b` — typecheck frontend
2. `vite build` — build UI to `dist/public/` (`emptyOutDir: true`)
3. `tsc -p tsconfig.server.json` — compile server TS → `dist/server/`
4. `scripts/deploy.mjs` — copy `dist/public/` → `{DEPLOY_DIR}/public/`,
   copy `dist/server/` → `{DEPLOY_DIR}/server/`, `npm install --omit=dev`,
   copy `.env`

**The systemd service runs compiled JS** (`node server/index.js`), not `tsx` on
source files. The service `WorkingDirectory` is `{DEPLOY_DIR}`.

**Runtime data is preserved across deploys**: `server/bundles.json`, `server/data/`,
and `data/chats/` are not wiped. The deploy script cleans `public/` (stale assets)
but never touches the server runtime data.

**Common mistake**: starting the server manually with `npx tsx server/index.ts &`
or `nohup` — this creates a competing process on port 3002 that shadows the
systemd service, with stdout going nowhere useful. Always use `systemctl --user`.

## Architecture

```
src/     ← React 19 SPA (Vite, React Router)
server/  ← Express 5 API (Passport Google OAuth, simple-git, MCP client)
deploy/  ← example nginx reverse-proxy config
```

### Request flow

- nginx is a pure reverse proxy: all requests (UI, API, SSE) go to Express on
  `localhost:3002` (`proxy_buffering off` for SSE; 180s read timeout). Express
  serves static files from `public/` and provides the SPA fallback for
  client-side routing.
- In dev, Vite proxies `/api/notebook` → `localhost:3002` (see `vite.config.ts`).
- All API routes mount under `/api/notebook/` (`server/index.ts`):
  - `/auth/*` — Google OAuth + `/me` + `/logout`
  - `/bundles/*` — bundle CRUD + composed sub-routers (`files`, `git`, `chat`)
  - `/chats/*` — chat session persistence (separate from the chat *agent* route)
  - `/settings/*` — global settings (AI model)
  - `/mcps` — MCP server registry CRUD + status (Settings → "MCP servers" and
    the per-bundle toggles)
  - (full-text search is also mounted under `/bundles` — see `server/routes/search.ts`)

### Agentic chat loop (`server/routes/chat.ts`)

`POST /:bundleId/chat` is the core. It is **not** a single LLM call — it's a
`for(;;)` server-side loop streamed as SSE:

1. Build a system prompt from the bundle's `AGENTS.md`, `OKF.md`, file list, and
   current date (in `TIMEZONE`, default the server's own timezone).
2. Call the LLM via `chatCompletionStream()` with tool definitions, forwarding
   content deltas to the client as they arrive.
3. If the LLM returns `tool_calls`, execute each (built-in bundle tool or MCP),
   append results to the message history, emit `tool_call` SSE events, and loop.
4. When the LLM returns plain content (no tool calls), emit a final `done`
   event and end the stream.

SSE events: `tool_call`, `content`, `edit_applied`, `retry`, `done`, `error`. The
frontend (`src/services/chat.ts`) hand-parses the SSE stream from a
`ReadableStream` (no EventSource — POST is needed).

**Client disconnects do NOT stop a turn.** The loop keeps running and
persisting every event to the chat timeline even after the SSE connection
drops (mobile network blip, tab close, proxy timeout), ending with a
`turn_end` persisted event. A reconnecting client recovers by polling
`loadChat` until `turn_end` appears (ChatPanel's recovery poll / background
watcher) and then rebuilds state from the timeline.

**Retry on transient LLM failures**: `chatCompletionStream` retries
pre-stream HTTP failures (429/5xx) internally; the chat loop adds a
turn-level retry (up to 3 retries, exponential backoff) that also covers
mid-stream drops, API errors inside SSE chunks, and empty responses. On each
retry the server emits a `retry` SSE event `{ attempt, maxAttempts, reason,
waitMs }` and discards the partial content of the failed attempt (the client
drops its trailing content and shows a transient notice); the full answer is
re-streamed, so content is never duplicated.

**Abort / STOP**: because disconnects are tolerated, the STOP button must
call `POST /:bundleId/chat/abort` (`abortChat()` in `src/services/api.ts`)
which aborts the turn's registered `AbortController` (tracked in the
`activeAborts` map keyed by `bundleId/chatId`). The loop then persists
whatever assistant content accumulated, records `turn_end`, and ends without
surfacing an error. The client afterwards syncs from the persisted timeline.

### Direct disk editing (LLM writes immediately)

The LLM **writes to disk directly** — there is no human-in-the-loop accept/reject
gate. For `full`-role users the editing tools are:

- `edit_file` — **search-and-replace** (not full-content). Caller provides
  `old_string` (must match uniquely) + `new_string`. Matching is whitespace-tolerant
  (see `searchReplace()` in `chat.ts`): exact match is tried first, then a
  line-based fallback that collapses leading whitespace runs to a single space
  and strips trailing whitespace. Ambiguous (0 or >1) matches return an error
  telling the LLM to re-read the file. After applying, the old/new content pair
  is pushed onto a per-file edit-history map.
- `create_file` — writes a new file (any type, not just `.md`); creates parent dirs.
- `delete_file` — removes a file (used by dedup/moves; recoverable via git history
  if the file was committed).
- `undo_edit` — pops the most recent `edit_file` from the in-memory edit-history
  map and restores the previous content. **History is session-scoped only** (a
  module-level `Map` in `chat.ts`, not persisted) — restarting the server wipes it.
- `git_commit` — stages and commits (author set from the logged-in user).

Each successful `edit_file`/`create_file`/`delete_file`/`undo_edit` emits an
`edit_applied` SSE
event carrying the diff/contents so the frontend can render a collapsible diff
card. Readonly-role users get only `read_file`, `list_files`, `eval_maths`,
and `web_search`. Git inspection (`git_status`, `git_diff`, `git_log`) is
**full-role only** (`GIT_TOOLS` in `chat.ts`, spread into `FULL_TOOLS`;
also given to the digest agent) — they were removed from `READONLY_TOOLS`
by mistake in 6cb3ac3 and restored 2026-08-21. `buildSystemPrompt` derives
its capability sentences from the actually-exposed tool names so the prompt
never advertises tools the request doesn't have.

### Exact maths (`eval_maths` built-in tool)

`server/lib/maths.ts` evaluates expressions with **exact BigInt rational
arithmetic** — no floating-point error (`0.1 + 0.2` → `0.3`, `9.99 * 100` →
`999`, `2^128 - 1` exact). Available to all roles (part of
`READONLY_TOOLS` in `chat.ts`). Supports `+ - * /` (spaced `%` = modulo,
attached `%` = ÷100), `^`, `!`, implicit multiplication (`2(3+4)`, `2pi`),
scientific notation, constants (`pi`, `e`, `tau`, `phi`), and functions
(`sqrt`, `cbrt`, `gcd`, `lcm`, `mod`, `fact`, `comb`, `round(x, digits)`,
trig in radians or degrees — `sind`/`cosd`/`tand` take degrees directly,
which beats `tan(deg(...))` — plus `ln`/`log` (natural)/`log10`/`log2`,
`exp`). Constants (`pi`, `e`, `tau`, `phi`) are **computed at load to 120
significant digits** (Machin's formula, Taylor series, isqrt — not typed
strings), so rational chains like `phi^2 - phi` render dust-free; approx
values render at ≤ 50 significant digits. Double-based results are
**snapped to 15 significant digits** (`sin(pi/6)` → `0.5`, `sqrt(2)^2` →
`2`) and trig dust at special angles snaps to zero (`sin(pi)` → `0`,
`sind(180)` → `0`), all flagged `approximate`.
Non-terminating fractions render as exact `n/d` plus a 30-significant-digit
decimal; computation is size-capped (factorial ≤ 20000, exponent ≤ 100000,
≤ 100000 digits) and renders past 1000 characters are truncated with a
note so the tool can't flood the chat context. The system prompt tells the
LLM to call it for any non-trivial arithmetic.

### LLM backend (`server/lib/llm.ts`)

Calls **any OpenAI-compatible chat-completions API**. The base URL comes from
`LLM_BASE_URL` (default `http://127.0.0.1:3003/api/v1` — a local inference
proxy; the author's setup routes the Z.ai GLM API through it), the key from
`LLM_API_KEY` (legacy alias `INFERENCE_API_KEY`), sent as
`Authorization: Bearer …`. Works with OpenAI, OpenRouter, Z.ai, Ollama, vLLM,
LM Studio, etc. — see `llm.ts`'s header comment for URL shapes.

**Model selection is a global setting** (Settings page → "AI model"):
persisted in `server/data/settings.json` (`server/settings.ts`), defaults to
`LLM_MODEL` (itself defaulting to `glm-5.2`), applied to every LLM call
(chat, digest, uploads, retitles). The dropdown is populated from the
endpoint's `GET …/models` list (`listModels()` in `llm.ts`, 5-min cache);
PUT validates the id against that list. An optional `LLM_MODELS_FILTER` env
regex curates which ids the dropdown offers (useful behind a routing proxy
with a huge catalog). Changes take effect on the next request — no restart
needed.

Two functions are exported: `chatCompletionStream` (used by the chat route —
streams content deltas via a callback, accumulates tool-call fragments across
chunks, accepts an `AbortSignal`) and `chatCompletion` (non-streaming, used by
compact/retitle and tests).

### Daily digest (`server/lib/digest.ts`, `server/lib/scheduler.ts`)

Per-bundle config lives in `bundles.json` as
`digest?: { enabled?, cleanup?, googleUser? }`
(Settings → "Digest…" per bundle; `GET /api/notebook/mcps` feeds the Google
account dropdown from `listWorkspaceUsers()`). `enabled: false` skips the
bundle in the scheduler. `cleanup: true` runs the OKF maintenance pass
first (see below). `googleUser` (an email with Workspace tokens on disk)
gives the digest read-only `gw_` tools (calendar + mail subset) routed to that
user's MCP instance via `runReadOnlyTask({ mcpTools, mcpUserEmail })` — one
notebook can digest one person's calendar, another's. Global knobs remain
env-based: `DIGEST_CRON`, `DIGEST_TZ`, `DIGEST_TO`, `DIGEST_DISABLED`.

**OKF cleanup pass** (`server/lib/cleanup.ts`, `server/lib/okf-lint.ts`):
opt-in pre-digest maintenance phase. In order: (0) **fast skip** — if the
working tree is clean and the last commit already is a completed OKF
cleanup commit (`chore(okf):` …, but not the pre-run snapshot message),
the pass is skipped entirely (record `skipped: true`); (1) **pre-cleanup
snapshot commit** — any uncommitted WIP is committed first (message
`chore(okf): snapshot working tree before cleanup`, author "Notebook
Maintenance") so nothing can be lost by mistake; the record's `restorePoint`
is the commit to `git reset --hard` to for undoing the whole pass; (2)
`lintBundle()` computes deterministic OKF conformance issues (missing
`type`/`title`/`description`, unparseable frontmatter, empty bodies,
duplicate titles) to ground the model; (3) an agent loop
(`runReadOnlyTask` + `WRITE_TOOLS` from `chat.ts`: `edit_file`,
`create_file`, `delete_file`, `git_commit` — note `delete_file` is also new
in the chat toolset) fixes the files against the bundle's OKF.md spec and
commits with a `chore(okf):` message; (4) if the tree is still dirty
afterwards, the runner makes a safety commit itself so the digest phase
always starts from a committed state. Cleanup failures are recorded in the
digest record (`cleanup` field) and do NOT abort the digest. Preview a run
manually with `node server/index.ts --run-cleanup [bundleId]` (runs
regardless of the per-bundle setting).

### MCP servers (`server/lib/mcp-manager.ts`, `server/mcps.ts`)

MCP (Model Context Protocol) servers are spawned as child processes (stdio
transport) and their tools are discovered and exposed to the LLM. The server
set is **runtime data**, not code: persisted in `server/data/mcps.json`
(`server/mcps.ts` — load/save/sanitize, seeded empty on first run) and managed
from **Settings → "MCP servers"** (add/edit/remove/restart; nothing is shipped
by default). Tools are namespaced with a `toolPrefix` to avoid collisions
(`gw_` for Google Workspace). `allowTools` filters which tools each server
exposes. The management routes (`server/routes/mcps.ts`, `full`-role only —
an MCP config is an arbitrary command line on the host) start/restart the
server immediately; a failed start is recorded per-server and surfaced in the
UI (`running: false` + error) rather than rejected.

**Per-user MCP instances (`perUser: true`)**: the `google-workspace` server runs
one child process per workspace-connected user. (The name `google-workspace`
is the convention — `auth.ts`, `workspace-auth.ts`, and `digest.ts`
special-case it; per-user token isolation only applies to a server with that
exact name.) The MCP package resolves its
tokens from `$HOME/.google-workspace-mcp`, so each user's instance is spawned
with `HOME=server/data/workspace-auth/<email>/` (and a shared `npm_config_cache`
so npx doesn't re-download the package per user). Chat `gw_*` calls route to the
**logged-in user's** instance (`callTool(name, args, { userEmail })`), started
lazily if they have tokens on disk. At startup one instance is started per user
in `listWorkspaceUsers()`; if none, a tokenless instance runs for tool discovery.
`restartUserServer(name, email)` is called from the login callback after tokens
are written.

**Per-bundle MCP availability**: each bundle may carry `mcps?: string[]` in
`server/bundles.json` — the MCP server names enabled for that notebook
(`undefined` = all servers, `[]` = none). Edited from Settings → "Tools…"
per bundle (checkboxes fed by `GET /api/notebook/mcps`). Values are validated
against the configured servers at save time (`sanitizeMcps()` in `bundles.ts`).
The chat route filters MCP tools through `getToolDefinitions(bundle.mcps)`,
refuses calls to hidden-but-known MCP tools, and the system prompt only
advertises the exposed tools.

**ibkr-flex** (`bin/ibkr-flex-mcp`, static-musl Rust binary): read-only IBKR
account reporting via the Flex Web Service (`flex_positions`, `flex_trades`,
`flex_cash`, `flex_run_query`). Third-party (MIT):
https://github.com/0xmichalis/ibkr-flex-mcp — the binary is **not committed**
(gitignored, platform-specific); it must be downloaded from upstream releases
into `bin/`. Started only when both `IBKR_FLEX_TOKEN` and `IBKR_FLEX_QUERY_ID`
are set in `.env` **and** the binary exists (clear warning otherwise); the Flex
Query must be configured in Client Portal (Reports → Flex Queries) to emit the
desired sections. Resolved as `../bin` relative to the server directory —
deploy.mjs ships `bin/` to `{DEPLOY_DIR}/bin/` when present.

**Google Workspace auth short-circuit**: before any `gw_*` tool call, the chat
loop calls `validateWorkspaceAuth(email)` (`server/lib/workspace-auth.ts`) for
the logged-in user. If the access token is stale it attempts a silent refresh
via Google's token API; if that fails (e.g. 7-day test refresh token expired) it
returns the sentinel `{ error: '__WORKSPACE_AUTH_REQUIRED__' }` instead of
calling the MCP — this prevents the MCP from hanging on its own browser-based
OAuth flow when running headless.

### Web search (`web_search` built-in tool)

The `web_search` tool is a **built-in** tool (not an MCP server) exposed to all
users (readonly + full). It searches the web via whichever search API key is
configured, trying providers in preference order: **exa → tavily → tinyfish →
serper**. Providers without an env key are skipped; providers that error at
runtime fall through to the next. Set one or more of: `EXA_API_KEY`,
`TAVILY_API_KEY`, `TINYFISH_API_KEY`, `SERPER_API_KEY`. The implementation lives
in `server/lib/web-search.ts`.

### Auth model (`server/auth.ts`, `server/config.ts`, `server/lib/workspace-auth.ts`)

- Google OAuth 2.0 with an **email allowlist** (the `NOTEBOOK_USERS` env var —
  `email:full`/`email:readonly` pairs; parsed into the `USERS` map in
  `config.ts`) →
  roles `readonly` or `full`. No self-service registration.
- `requireAuth` middleware guards all API routes; `requireFull` guards writes.
- **Unified OAuth**: *every* login requests Google profile/email **plus** the
  full Workspace scopes (`gmail.modify`, `calendar`, `drive`, `documents`,
  `spreadsheets`, `presentations`, `contacts`) with `accessType: 'offline'`. When
  Google returns a `refresh_token` (first authorization, or when `?reconnect=1`
  is passed to `/auth/google` to force `prompt: 'consent'`), the tokens are
  written **per user** to
  `server/data/workspace-auth/<email>/.google-workspace-mcp/{token,credentials}.json`
  and that user's `google-workspace` MCP instance is (re)started. Each user's
  Google account is therefore isolated — chats use the tokens of whoever is
  logged in. A user with no tokens yet must log in once with `?reconnect=1`.
- `app.set('trust proxy', 1)` is required so the dynamically-built OAuth
  callback URL (`callbackURL(req)`) sees `https` behind nginx.
- OAuth callback URL is built per-request from `req.protocol` + `req.get('host')`,
  not hardcoded — so the same server works on any domain.

### Chat persistence (`server/chats.ts`)

Chat sessions are stored as one JSON file each under
`server/data/chats/{bundleId}/{chatId}.json` (gitignored). The format is a flat
chronological `StoredEvent[]` timeline (not a message array) capturing user
messages, assistant messages, tool calls, applied edits (stored as `proposed`
events with `status: 'applied'`), and errors. Each event has a monotonic `seq`
number. Every turn's terminal state (completion, error, or abort) is marked by
a `turn_end` event — recovery polling waits for it (timelines recorded before
it existed fall back to "assistant message follows user message").

**The server is the source of truth for persistence.** The agentic chat loop
appends each event to the timeline as it happens via `appendEvent()` — the user
message at the start, tool calls as they execute, and the final assistant message
at completion. Persistence is chained through a single `Promise` per request
(`persistChain`) to avoid read-modify-write races between concurrent appends. The
client only reads back the timeline when loading a past chat; it does not persist.
This means progress survives client disconnects as long as the server loop keeps
running.

**Sessions are scoped per-user** via a `userId` field (the owner's email).
`listChats`/`loadChat`/`deleteChat` all take a `userId` and filter by ownership.
**Legacy chats created before this field existed have no `userId` and are
accessible to all users** — keep this in mind if you see chats you don't expect.

## Testing

Vitest is configured in `vitest.config.ts`, picking up `{src,server}/**/*.test.ts`
with a 10s timeout. Run with `npm test` (or `npm run test:watch`).

The suite focuses on **abort/streaming correctness and event ordering**, not on
the full HTTP route stack — tests stub `globalThis.fetch` with a fake streaming
`Response` and assert behavior:

- `server/lib/llm.test.ts` — `chatCompletionStream`: verifies the `AbortSignal`
  is forwarded to the upstream fetch, that content received before abort is
  preserved via `onDelta`, and that normal completion returns full content.
- `src/services/chat.test.ts` — `streamChat` (client-side SSE parser): verifies
  events received before abort are preserved, the signal reaches fetch, normal
  completion yields all events, and the generator terminates within 1s of abort.

When adding streaming/abort-related behavior, follow this pattern: mock fetch
with a `ReadableStream` that errors on abort (`controller.error(new DOMException(...))`)
and assert the preserved-prefix + prompt-termination invariants.

## Code Conventions

### Import extensions differ between frontend and server

This is a frequent source of confusion:

- **Frontend** (`src/`): imports use `.ts`/`.tsx` extensions
  (`from './types.ts'`) — enabled by `allowImportingTsExtensions` in
  `tsconfig.app.json`.
- **Server** (`server/`): imports use `.js` extensions
  (`from './config.js'`) even though the source files are `.ts` — Node ESM
  resolution requires the emitted extension. `erasableSyntaxOnly` is on.

Two separate ESLint blocks target `src/**` (browser globals) and `server/**`
(node globals) — see `eslint.config.js`.

### Express 5 splat routes

Route patterns like `/:bundleId/files/*path` produce `req.params.path` as an
**array** in Express 5 (not a string). `server/routes/files.ts` has a `getRelName`
helper that joins it. If you add new splat routes, handle the array form.

### Error handling pattern

Async route handlers wrap bodies in `try/catch` and call `next(err)`. The bundle
module throws a typed `BundleError` with a `code` field; routes map codes to
HTTP status. The chat SSE route has special two-phase error handling: if headers
aren't sent, delegate to Express's error handler; if already streaming, emit an
`error` event and close.

### Path safety

`resolveBundlePath()` in `server/bundles.ts` resolves a relative path against the
bundle root and rejects anything escaping it (`..` or absolute). Use it for all
file operations. Chat IDs are validated with `/[^a-z0-9-]/i` to prevent traversal
in the persistence layer.

## Configuration & Environment

`server/config.ts` reads from `process.env` directly — **no dotenv import**.
Production loads env via systemd `EnvironmentFile=.env` (per service file in
`~/.config/systemd/user/notebook.service`); for local dev, export them in your
shell or run with `--env-file=.env`. Variables (see `.env.example` for the full
annotated list):

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — OAuth (omit to disable login).
- `NOTEBOOK_USERS` — login allowlist, `email:role` pairs (`role` = `full` |
  `readonly`). Empty = nobody can log in.
- `SESSION_SECRET` — defaults to `dev-secret-change-me`.
- `PORT` — defaults to 3002.
- `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_MODELS_FILTER` — LLM
  endpoint config (defaults: local proxy at `127.0.0.1:3003/api/v1`,
  `glm-5.2`).
- `TIMEZONE` — IANA tz for the chat date stamp; defaults to the server's own.
- `EXA_API_KEY` / `TAVILY_API_KEY` / `TINYFISH_API_KEY` / `SERPER_API_KEY` —
  optional, for the `web_search` tool (any one enables it).
- `DIGEST_TO` / `DIGEST_FROM` / `DIGEST_SMTP_HOST` / `DIGEST_SMTP_PORT` /
  `DIGEST_CRON` / `DIGEST_TZ` / `DIGEST_DISABLED` — daily digest email.
- `DEPLOY_DIR` — target directory for `scripts/deploy.mjs`.

`server/bundles.json` (gitignored) holds bundle registrations. It starts
empty; bundles are added through the Settings UI (any existing directory of
`.md` files).

## OKF Format

Bundles are directories of `.md` files with YAML frontmatter (`title`, `type`).
The file tree, LLM system prompt, and concept labels all read frontmatter via
`gray-matter`. See `OKF.md` in any bundle for the full spec.
