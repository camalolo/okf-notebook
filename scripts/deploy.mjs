#!/usr/bin/env node
/**
 * Deploy script: copies the dist/ build tree to a production directory.
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
 * DEPLOY_DIR comes from the environment, falling back to a `DEPLOY_DIR=` line
 * in the repo's .env (so the deploy command stays one-liner on machines that
 * keep it there). Exits with an error when neither is set.
 *
 * Runs AFTER `tsc -p tsconfig.server.json` and `vite build`
 * (`npm run deploy` / `npm run deploy:server` do both).
 */
import { cp, mkdir, rm, access, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** Read `DEPLOY_DIR=…` from the repo's .env (deploy runs outside the server,
 *  which is what normally loads that file). Returns '' when absent. */
async function deployDirFromEnvFile() {
  try {
    const raw = await readFile(path.join(ROOT, '.env'), 'utf8');
    const m = raw.match(/^\s*DEPLOY_DIR\s*=\s*(\S+)\s*$/m);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const DEPLOY_DIR = process.env.DEPLOY_DIR || (await deployDirFromEnvFile());
  if (!DEPLOY_DIR) {
    console.error(
      '[deploy] DEPLOY_DIR is not set. Export it (DEPLOY_DIR=/srv/notebook npm run deploy)\n' +
        '         or add a DEPLOY_DIR=… line to .env.',
    );
    process.exit(1);
  }
  console.log('[deploy] Target:', DEPLOY_DIR);
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
  // The filter is the "preserve runtime data" guarantee: anything under
  // dist/server/data/ (mcps.json, sessions, workspace-auth tokens — possibly
  // seeded by a local smoke-test run of the compiled server) and a dist-side
  // bundles.json must NEVER overwrite the live registry in DEPLOY_DIR.
  const serverDst = path.join(DEPLOY_DIR, 'server');
  console.log('[deploy] Copying server code →', serverDst);
  await mkdir(serverDst, { recursive: true });
  const runtimeDataDir = path.join(distServer, 'data');
  const runtimeBundlesJson = path.join(distServer, 'bundles.json');
  await cp(distServer, serverDst, {
    recursive: true,
    force: true,
    filter: (src) => src !== runtimeDataDir && !src.startsWith(runtimeDataDir + path.sep) && src !== runtimeBundlesJson,
  });

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

  console.log('[deploy] Done.  Restart the service, e.g.:');
  console.log('  systemctl --user restart notebook.service');
}

main().catch((err) => {
  console.error('[deploy] Failed:', err);
  process.exit(1);
});
