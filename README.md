# Notebook

A self-hosted web app for browsing and editing [OKF](#okf—open-knowledge-format)
markdown knowledge bases, chatting with an LLM that can read *and write* the
files directly, and managing git commits — all through an agentic chat
interface. Think "NotebookLM, but it's your own folders, and it can edit them."

## Features

- **Bundle browser** — register any number of local folders ("bundles") of
  markdown files; navigate the tree, read files rendered as GFM markdown.
- **Agentic chat** — a streaming (SSE) chat loop where the LLM calls tools:
  read/list/edit/create/delete files, run exact rational-arithmetic maths,
  search the web, and drive git (status/diff/log/commit). Edits are applied
  to disk immediately and shown as collapsible diff cards.
- **MCP extensibility** — add any [Model Context Protocol](https://modelcontextprotocol.io)
  server from Settings (Google Workspace, a headless browser, or third-party
  servers like [ibkr-flex-mcp](https://github.com/0xmichalis/ibkr-flex-mcp)
  for read-only Interactive Brokers reports) and toggle them per notebook.
  No MCP servers ship by default — you add the ones you trust.
- **Daily digest** — an optional scheduled LLM pass over each bundle that
  emails you what matters in the next 24h, with an opt-in "cleanup" phase
  that lint-fixes and reorganizes files to OKF conformance before digesting.
- **Roles** — Google OAuth login with an email allowlist; users are `full`
  (edit + git + settings) or `readonly` (read, search, chat without write
  tools), plus per-bundle access lists.
- **Any OpenAI-compatible LLM** — point `LLM_BASE_URL` at OpenAI, OpenRouter,
  Z.ai, Ollama, vLLM, LM Studio, or your own proxy.

## Quickstart

Requirements: Node.js ≥ 20.11, an LLM API (any OpenAI-compatible endpoint).

```bash
git clone <this repo> && cd notebook
npm install
cp .env.example .env   # then edit — at minimum the LLM + auth settings
npm run dev:all        # UI on :5173, API on :3002
```

Minimum viable `.env`:

```ini
SESSION_SECRET=<openssl rand -hex 32>
LLM_BASE_URL=https://api.openai.com/v1   # or your provider / local Ollama
LLM_API_KEY=sk-...
GOOGLE_CLIENT_ID=...                     # OAuth client, see below
GOOGLE_CLIENT_SECRET=...
NOTEBOOK_USERS=you@example.com:full
```

> **Login requires Google OAuth.** Create a client (type *Web application*) at
> [Google Cloud credentials](https://console.cloud.google.com/apis/credentials),
> add `https://<your-host>/api/notebook/auth/google/callback` as an authorized
> redirect URI (`http://localhost:5173/api/notebook/auth/google/callback` for
> dev), and list the allowed emails in `NOTEBOOK_USERS`. Without OAuth creds
> the server starts but nobody can log in.

Then open http://localhost:5173, log in, and add your first bundle from
**Settings → Bundles** (any directory of `.md` files — a git repo is
recommended so edits are versioned).

All configuration variables are documented with comments in
[`.env.example`](.env.example).

## OKF — Open Knowledge Format

Bundles are plain directories of markdown files with YAML frontmatter
(`title`, `type`, …) plus optional `index.md` files that link related notes.
A bundle may carry its own `OKF.md` describing its conventions — the chat's
system prompt reads it so the LLM organizes notes the way you do. The daily
cleanup pass lints bundles against the OKF rules (missing frontmatter, empty
bodies, duplicate titles, stale indexes) and fixes what it finds.

## Production deployment

```bash
npm run build                          # typecheck + build UI + compile server → dist/
DEPLOY_DIR=/srv/notebook npm run deploy  # or put DEPLOY_DIR in .env
```

The deploy script copies `dist/` + production deps + `.env` to `DEPLOY_DIR`,
preserving runtime data (`bundles.json`, `data/`). Run the server with
`node server/index.js` from there (PORT defaults to 3002, bound to 127.0.0.1 —
put nginx in front for TLS; see [`deploy/nginx.example.conf`](deploy/nginx.example.conf)).
A user-level systemd unit works well:

```ini
# ~/.config/systemd/user/notebook.service
[Service]
WorkingDirectory=/srv/notebook
EnvironmentFile=/srv/notebook/.env
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
```

## Security notes

Read these before exposing the app beyond localhost:

- **The LLM writes files directly.** There is no accept/reject gate; `full`
  users' chats can edit, create, and delete files in bundle directories and
  commit to git. Point bundles at folders where that's acceptable, and keep
  them in git so everything is recoverable.
- The allowlist (`NOTEBOOK_USERS`) is the entire auth model — anyone not
  listed cannot log in, and there is no self-service registration.
- Login requests broad Google Workspace scopes (Gmail read, Calendar, Drive)
  to power the optional `gw_` MCP tools. If you don't connect a Google
  account, tokens are never written; if you do, they live under
  `server/data/workspace-auth/` (keep backups/exfiltration in mind).
- Sessions are cookie-based with a 30-day lifetime; set a real
  `SESSION_SECRET`.

## Development

```bash
npm run dev:all   # Vite + Express with hot reload
npm test          # vitest
npm run lint      # eslint
npm run build     # typecheck everything and build
```

[`AGENTS.md`](AGENTS.md) is the deep-dive architecture doc (request flow,
chat loop internals, persistence model, MCP wiring) — it's written for AI
coding agents but is the best reference for humans too.

**License**: [MIT](LICENSE)
