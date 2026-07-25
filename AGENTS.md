# Notebook — OKF Knowledge Browser

A web app for browsing/editing OKF (Open Knowledge Format) markdown bundles,
chatting with an LLM that can read files and propose edits (human-in-the-loop),
and managing git commits — all through an agentic chat interface.

## Commands

```bash
npm install
npm run dev:all    # Vite (5173) + Express (3002) concurrently, both hot-reloading
npm run dev        # frontend only
npm run dev:server # backend only (tsx watch)
npm run build      # tsc -b (typecheck) + vite build
npm run lint       # eslint
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

### Agentic chat loop (`server/routes/chat.ts`)

`POST /:bundleId/chat` is the core. It is **not** a single LLM call — it's a
`for(;;)` server-side loop streamed as SSE:

1. Build a system prompt from the bundle's `AGENTS.md`, `OKF.md`, file list, and
   current date (Asia/Taipei timezone).
2. Call the LLM via `chatCompletion()` with tool definitions.
3. If the LLM returns `tool_calls`, execute each (built-in bundle tool or MCP),
   append results to the message history, emit `tool_call` SSE events, and loop.
4. When the LLM returns plain content (no tool calls), emit `content` + `done`
   and end the stream.

SSE events: `tool_call`, `content`, `proposed_change`, `done`, `error`. The
frontend (`src/services/chat.ts`) hand-parses the SSE stream from a
`ReadableStream` (no EventSource — POST is needed).

### Human-in-the-loop editing

The LLM is **never** allowed to write to disk. The exposed tools for `full`-role
users are `read_file`, `list_files`, `git_status`, `git_diff`, `git_log`,
`propose_edit`, `propose_create`. When the LLM calls a propose tool, the server
emits a `proposed_change` SSE event; the frontend renders an Accept/Reject card
(`ProposedChangeCard`) and, on accept, calls the file write API directly.

`apply_edit`, `apply_create`, and `git_commit` handlers exist in `executeTool()`
but are **intentionally not exposed** in `FULL_TOOLS` — they're vestigial from
before the human-in-the-loop redesign. Do not re-enable them without reason.

### LLM backend (`server/lib/llm.ts`)

Calls the **Z.ai GLM API through a local PHP proxy** at
`https://example.com/api/zai`, authenticated with `X-API-Token`. Tokens are
fetched from `https://example.com/api/token` (IP-bound, 5-min expiry) and
cached until 30s before expiry. Model is hardcoded as `glm-5.2`. The proxy is
external infrastructure — not part of this repo.

### MCP servers (`server/lib/mcp-manager.ts`)

MCP (Model Context Protocol) servers are spawned as child processes (stdio
transport) at startup and their tools are discovered and exposed to the LLM.
Configured **hardcoded** in `MCP_SERVERS` at the top of `server/index.ts` (not
in a config file). Tools are namespaced with a `toolPrefix` to avoid collisions
(`gw_` for Google Workspace, none/`browser_` for Playwright). Add or modify MCP
servers by editing that array. `allowTools` filters which tools each server
exposes.

### Web search (`web_search` built-in tool)

The `web_search` tool is a **built-in** tool (not an MCP server) exposed to all
users (readonly + full). It searches the web via whichever search API key is
configured, trying providers in preference order: **exa → tavily → tinyfish →
serper**. Providers without an env key are skipped; providers that error at
runtime fall through to the next. Set one or more of: `EXA_API_KEY`,
`TAVILY_API_KEY`, `TINYFISH_API_KEY`, `SERPER_API_KEY`. The implementation lives
in `server/lib/web-search.ts`.

### Auth model (`server/auth.ts`, `server/config.ts`)

- Google OAuth 2.0 with an **email allowlist** (`USERS` map in `config.ts`) →
  roles `readonly` or `full`. No self-service registration.
- `requireAuth` middleware guards all API routes; `requireFull` guards writes.
- **Dev bypass**: set `DEV_BYPASS_EMAIL=<email-in-allowlist>` to auto-login
  without OAuth. Essential for local dev without Google credentials.
- `app.set('trust proxy', 1)` is required so the dynamically-built OAuth
  callback URL (`callbackURL(req)`) sees `https` behind nginx.
- OAuth callback URL is built per-request from `req.protocol` + `req.get('host')`,
  not hardcoded — so the same server works on any domain.

### Chat persistence (`server/chats.ts`)

Chat sessions are stored as one JSON file each under
`server/data/chats/{bundleId}/{chatId}.json` (gitignored). The format is a flat
chronological `StoredEvent[]` timeline (not a message array) capturing user
messages, assistant messages, tool calls, proposed changes, and errors. The
frontend reconstructs in-memory state (messages + per-turn events + proposed
changes) from this timeline via `restoreFromEvents` in `ChatPanel.tsx`, and
serializes back via `buildEventsFrom`. Incremental saves happen mid-stream after
each tool call so progress survives disconnects.

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
- `DEV_BYPASS_EMAIL` — skip OAuth in dev.
- `PORT` — defaults to 3002.

`server/bundles.json` (gitignored) holds bundle registrations. On first run it's
seeded with two hardcoded local paths (`/home/user/Sources/Demo`, `Sample`) —
these won't exist elsewhere. Manage bundles through the Settings UI instead.

## OKF Format

Bundles are directories of `.md` files with YAML frontmatter (`title`, `type`).
The file tree, LLM system prompt, and concept labels all read frontmatter via
`gray-matter`. See `OKF.md` in any bundle for the full spec.
