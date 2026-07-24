# Notebook — OKF Knowledge Browser

## What This Is

A web-based browser/editor for OKF (Open Knowledge Format) bundles.
Browse file trees, read/edit markdown, manage git commits, chat with AI,
and semantic-search across bundles.

## Tech Stack

- **Frontend**: React 19 + Vite + TypeScript, React Router
- **Backend**: Node.js + Express, Passport (Google OAuth), simple-git
- **Data**: bundles persisted in `server/bundles.json`

## Architecture

```
src/     ← Frontend (React SPA)
server/  ← Backend (Express API)
deploy/  ← systemd + nginx configs
```

## Development

```bash
npm install
npm run dev:all    # starts Vite (5173) + Express (3002) concurrently
```

## API

All routes under `/api/notebook/`. See `plan.md` Section 7 for full spec.

## OKF Format

Bundles are directories of `.md` files with YAML frontmatter.
See `OKF.md` in any bundle for the spec.
