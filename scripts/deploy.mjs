#!/usr/bin/env node
/**
 * Deploy script: copies compiled server JS + production deps to the nginx-served
 * production directory.  Runs AFTER `tsc -p tsconfig.server.json` and `vite build`.
 *
 * What it does:
 *   1. Copies dist-server/ → {DEPLOY_DIR}/server/  (compiled JS)
 *   2. Copies package.json + package-lock.json     (for npm install)
 *   3. Runs `npm install --omit=dev` in the server dir
 *   4. Copies .env if present
 *
 * What it does NOT do:
 *   - Wipe runtime data (server/bundles.json, server/data/) — preserved across deploys
 *   - Build the frontend (vite already ran before this script)
 */
import { cp, mkdir, access, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Same hardcoded path as vite.config.ts build.outDir.
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
  const serverSrc = path.join(ROOT, 'dist-server');
  const serverDst = path.join(DEPLOY_DIR, 'server');

  if (!await exists(serverSrc)) {
    console.error('[deploy] dist-server/ not found. Run `tsc -p tsconfig.server.json` first.');
    process.exit(1);
  }

  // 1. Copy compiled server JS.
  console.log('[deploy] Copying server code →', serverDst);
  await mkdir(serverDst, { recursive: true });

  // Remove old JS files but preserve runtime data (bundles.json, data/).
  // We overwrite all .js files by copying; old stale .js from removed files
  // are harmless (never imported).
  await cp(serverSrc, serverDst, { recursive: true, force: true });

  // 2. Copy package files for dependency resolution.
  console.log('[deploy] Copying package.json + package-lock.json');
  await cp(path.join(ROOT, 'package.json'), path.join(serverDst, 'package.json'), { force: true });
  await cp(
    path.join(ROOT, 'package-lock.json'),
    path.join(serverDst, 'package-lock.json'),
    { force: true },
  );

  // 3. Install production dependencies.
  console.log('[deploy] Installing production dependencies …');
  execSync('npm install --omit=dev --no-fund --no-audit', {
    cwd: serverDst,
    stdio: 'inherit',
  });

  // 4. Copy .env if it exists (for systemd EnvironmentFile).
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
