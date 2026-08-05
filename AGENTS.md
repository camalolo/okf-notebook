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
npm run build      # tsc -b (typecheck) + vite build
npm run lint       # eslint
npm test           # vitest run (one-shot)
npm run test:watch # vitest watch mode
npm start          # production: tsx server/index.ts
```

**Runtime**: Node 20.11+ (server uses `import.meta.dirname`). Requires the bundle
directories referenced in `server/bundles.json` to exist on the local filesystem.

**Build output is a hardcoded absolute path**: `vite.config.ts` builds to
`/srv/notebook`. Building on another machine requires editing
this path or the deploy will land in the wrong place.

## Architecture

```
src/     ← React 19 SPA (Vite, React Router)
server/  ← Express 5 API (Passport Google OAuth, simple-git, MCP client)
deploy/  ← nginx config for notebook.example.com
```

### Request flow

- nginx serves the built SPA statically and reverse-proxies `/api/notebook/` to
  `localhost:3002` (`proxy_buffering off` for SSE; 180s read timeout).
- In dev, Vite proxies `/api/notebook` → `localhost:3002` (see `vite.config.ts`).
- All API routes mount under `/api/notebook/` (`server/index.ts`):
  - `/auth/*` — Google OAuth + `/me` + `/logout`
  - `/bundles/*` — bundle CRUD + composed sub-routers (`files`, `git`, `chat`)
  - `/chats/*` — chat session persistence (separate from the chat *agent* route)
  - (full-text search is also mounted under `/bundles` — see `server/routes/search.ts`)

### Agentic chat loop (`server/routes/chat.ts`)

`POST /:bundleId/chat` is the core. It is **not** a single LLM call — it's a
`for(;;)` server-side loop streamed as SSE:

1. Build a system prompt from the bundle's `AGENTS.md`, `OKF.md`, file list, and
   current date (Asia/Taipei timezone).
2. Call the LLM via `chatCompletionStream()` with tool definitions, forwarding
   content deltas to the client as they arrive.
3. If the LLM returns `tool_calls`, execute each (built-in bundle tool or MCP),
   append results to the message history, emit `tool_call` SSE events, and loop.
4. When the LLM returns plain content (no tool calls), emit a final `done`
   event and end the stream.

SSE events: `tool_call`, `content`, `edit_applied`, `done`, `error`. The
frontend (`src/services/chat.ts`) hand-parses the SSE stream from a
`ReadableStream` (no EventSource — POST is needed).

**Abort / STOP**: a client disconnect (STOP button or network drop) fires an
`AbortController` whose signal is forwarded into the upstream `chatCompletionStream`
fetch, so the LLM call stops promptly. The loop persists whatever assistant
content accumulated before the abort, then ends without surfacing an error.

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
- `undo_edit` — pops the most recent `edit_file` from the in-memory edit-history
  map and restores the previous content. **History is session-scoped only** (a
  module-level `Map` in `chat.ts`, not persisted) — restarting the server wipes it.
- `git_commit` — stages and commits (author set from the logged-in user).

Each successful `edit_file`/`create_file`/`undo_edit` emits an `edit_applied` SSE
event carrying the diff/contents so the frontend can render a collapsible diff
card. Readonly-role users get only `read_file`, `list_files`, `git_*`, and
`web_search`.

### LLM backend (`server/lib/llm.ts`)

Calls the **Z.ai GLM API through a local PHP proxy** at
`https://example.com/api/zai`, authenticated with `X-API-Token`. Tokens are
fetched from `https://example.com/api/token` (IP-bound, 5-min expiry) and
cached until 30s before expiry. Model is hardcoded as `glm-5.2`. The proxy is
external infrastructure — not part of this repo.

Two functions are exported: `chatCompletionStream` (used by the chat route —
streams content deltas via a callback, accumulates tool-call fragments across
chunks, accepts an `AbortSignal`) and `chatCompletion` (non-streaming, currently
unused by the chat route but kept exported).

### MCP servers (`server/lib/mcp-manager.ts`)

MCP (Model Context Protocol) servers are spawned as child processes (stdio
transport) at startup and their tools are discovered and exposed to the LLM.
Configured **hardcoded** in `MCP_SERVERS` at the top of `server/index.ts` (not
in a config file). Tools are namespaced with a `toolPrefix` to avoid collisions
(`gw_` for Google Workspace). `allowTools` filters which tools each server
exposes. Add or modify MCP servers by editing that array. `mcpManager.restartServer(name)`
hot-restarts a single server (used after writing fresh Workspace tokens).

**Google Workspace auth short-circuit**: before any `gw_*` tool call, the chat
loop calls `validateWorkspaceAuth()` (`server/lib/workspace-auth.ts`). If the
access token is stale it attempts a silent refresh via Google's token API; if
that fails (e.g. 7-day test refresh token expired) it returns the sentinel
`{ error: '__WORKSPACE_AUTH_REQUIRED__' }` instead of calling the MCP — this
prevents the MCP from hanging on its own browser-based OAuth flow when running
headless.

### Web search (`web_search` built-in tool)

The `web_search` tool is a **built-in** tool (not an MCP server) exposed to all
users (readonly + full). It searches the web via whichever search API key is
configured, trying providers in preference order: **exa → tavily → tinyfish →
serper**. Providers without an env key are skipped; providers that error at
runtime fall through to the next. Set one or more of: `EXA_API_KEY`,
`TAVILY_API_KEY`, `TINYFISH_API_KEY`, `SERPER_API_KEY`. The implementation lives
in `server/lib/web-search.ts`.

### Auth model (`server/auth.ts`, `server/config.ts`, `server/lib/workspace-auth.ts`)

- Google OAuth 2.0 with an **email allowlist** (`USERS` map in `config.ts`) →
  roles `readonly` or `full`. No self-service registration.
- `requireAuth` middleware guards all API routes; `requireFull` guards writes.
- **Unified OAuth**: *every* login requests Google profile/email **plus** the
  full Workspace scopes (`gmail.modify`, `calendar`, `drive`, `documents`,
  `spreadsheets`, `presentations`, `contacts`) with `accessType: 'offline'`. When
  Google returns a `refresh_token` (first authorization, or when `?reconnect=1`
  is passed to `/auth/google` to force `prompt: 'consent'`), the tokens are
  written to `~/.google-workspace-mcp/{token,credentials}.json` and the
  `google-workspace` MCP server is restarted so it picks them up. This is how the
  headless MCP gets its credentials without its own browser flow.
- **Dev bypass**: set `DEV_BYPASS_EMAIL=<email-in-allowlist>` to auto-login
  without OAuth. **Restricted to LAN/loopback IPs only** (`127.0.0.1`, `::1`,
  `192.168.x.x`, `10.x`) — requests from other IPs are not auto-authenticated.
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
number.

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
Production loads env via systemd `EnvironmentFile=.env` (per `plan.md`); for local
dev, export them in your shell or run with `--env-file=.env`. Variables:

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — OAuth (omit to disable login).
- `SESSION_SECRET` — defaults to `dev-secret-change-me`.
- `DEV_BYPASS_EMAIL` — skip OAuth in dev (LAN/loopback IPs only).
- `PORT` — defaults to 3002.
- `EXA_API_KEY` / `TAVILY_API_KEY` / `TINYFISH_API_KEY` / `SERPER_API_KEY` —
  optional, for the `web_search` tool (any one enables it).

`server/bundles.json` (gitignored) holds bundle registrations. On first run it's
seeded with two hardcoded local paths (`/home/user/Sources/Demo`, `Sample`) —
these won't exist elsewhere. Manage bundles through the Settings UI instead.

## OKF Format

Bundles are directories of `.md` files with YAML frontmatter (`title`, `type`).
The file tree, LLM system prompt, and concept labels all read frontmatter via
`gray-matter`. See `OKF.md` in any bundle for the full spec.
