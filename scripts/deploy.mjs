#!/usr/bin/env node
/**
 * Deploy script: copies the dist/ build tree to production.
 *
 * Build output layout (local):
 *   dist/
 *     server/   ← tsc output (compiled JS)
 *     public/   ← vite output (built UI)
 *
 * What this script does:
 *   1. Clean + copy dist/public/ → {DEPLOY_DIR}/public/   (UI assets)
 *   2. Copy dist/server/ → {DEPLOY_DIR}/server/             (compiled JS)
 *   3. Copy package.json + package-lock.json → server/
 *   4. Run `npm install --omit=dev` in the server dir
 *   5. Copy .env if present
 *
 * Runtime data (server/bundles.json, server/data/, data/chats/) is preserved.
 *
 * Runs AFTER `tsc -p tsconfig.server.json` and `vite build`.
 */
import { cp, mkdir, rm, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DEPLOY_DIR = '/srv/notebook';

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const distServer = path.join(ROOT, 'dist', 'server');
  const distPublic = path.join(ROOT, 'dist', 'public');

  // Verify build outputs exist.
  if (!await exists(distServer)) {
    console.error('[deploy] dist/server/ not found. Run `tsc -p tsconfig.server.json` first.');
    process.exit(1);
  }
  if (!await exists(distPublic)) {
    console.error('[deploy] dist/public/ not found. Run `vite build` first.');
    process.exit(1);
  }

  // 1. Deploy UI: clean + copy public/.
  const publicDst = path.join(DEPLOY_DIR, 'public');
  console.log('[deploy] Copying UI →', publicDst);
  await rm(publicDst, { recursive: true, force: true });
  await cp(distPublic, publicDst, { recursive: true });

  // Migration: remove old root-level UI files from the previous architecture
  // (when nginx served index.html + assets/ directly from DEPLOY_DIR root).
  await rm(path.join(DEPLOY_DIR, 'index.html'), { force: true });
  await rm(path.join(DEPLOY_DIR, 'assets'), { recursive: true, force: true });

  // 2. Deploy server: copy compiled JS (preserve runtime data).
  // Old stale .js files from removed modules are harmless (never imported).
  const serverDst = path.join(DEPLOY_DIR, 'server');
  console.log('[deploy] Copying server code →', serverDst);
  await mkdir(serverDst, { recursive: true });
  await cp(distServer, serverDst, { recursive: true, force: true });

  // 2.5. Ship bundled MCP binaries (bin/ — e.g. ibkr-flex-mcp). Server code
  // resolves them as ../bin relative to the compiled server/ directory.
  const binSrc = path.join(ROOT, 'bin');
  if (existsSync(binSrc)) {
    const binDst = path.join(DEPLOY_DIR, 'bin');
    console.log('[deploy] Copying MCP binaries →', binDst);
    await mkdir(binDst, { recursive: true });
    await cp(binSrc, binDst, { recursive: true, force: true });
    execSync('chmod +x ' + binDst + '/*', { stdio: 'inherit' });
  }

  // 3. Copy package files for dependency resolution.
  console.log('[deploy] Copying package.json + package-lock.json');
  await cp(path.join(ROOT, 'package.json'), path.join(serverDst, 'package.json'), { force: true });
  await cp(
    path.join(ROOT, 'package-lock.json'),
    path.join(serverDst, 'package-lock.json'),
    { force: true },
  );

  // 4. Install production dependencies.
  console.log('[deploy] Installing production dependencies …');
  execSync('npm install --omit=dev --no-fund --no-audit', {
    cwd: serverDst,
    stdio: 'inherit',
  });

  // 5. Copy .env if it exists (for systemd EnvironmentFile).
  const envSrc = path.join(ROOT, '.env');
  if (existsSync(envSrc)) {
    console.log('[deploy] Copying .env');
    await cp(envSrc, path.join(DEPLOY_DIR, '.env'), { force: true });
  }

  console.log('[deploy] Done.  Restart the service:');
  console.log('  systemctl --user restart notebook.service');
}

main().catch((err) => {
  console.error('[deploy] Failed:', err);
  process.exit(1);
});
