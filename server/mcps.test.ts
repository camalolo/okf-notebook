import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Redirect the registry to a temp file (must be set before import).
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notebook-mcps-test-'));
process.env.NOTEBOOK_MCPS_FILE = path.join(tmpDir, 'mcps.json');

const {
  sanitizeMcpConfig,
  addMcpServer,
  updateMcpServer,
  removeMcpServer,
  loadMcpServers,
  McpError,
} = await import('./mcps.js');

beforeAll(async () => {
  // Seed one valid server so update/remove have something to act on.
  await addMcpServer({
    name: 'browser',
    command: 'npx',
    args: ['@playwright/mcp', '--headless'],
    toolPrefix: 'bw',
  });
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('sanitizeMcpConfig', () => {
  it('normalizes a full config', () => {
    const cfg = sanitizeMcpConfig({
      name: ' my-server ',
      command: ' npx ',
      args: ['-y', 'pkg'],
      env: { TOKEN: 'abc' },
      toolPrefix: ' gw ',
      allowTools: ['a', 'a', 'b'],
      perUser: true,
    });
    expect(cfg).toEqual({
      name: 'my-server',
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { TOKEN: 'abc' },
      toolPrefix: 'gw',
      allowTools: ['a', 'b'],
      perUser: true,
    });
  });

  it('keeps optional fields absent when not provided', () => {
    const cfg = sanitizeMcpConfig({ name: 'x', command: 'bin' });
    expect(cfg).toEqual({ name: 'x', command: 'bin', args: [] });
    expect('env' in cfg).toBe(false);
    expect('perUser' in cfg).toBe(false);
  });

  it('rejects invalid names', () => {
    expect(() => sanitizeMcpConfig({ name: 'Bad Name', command: 'x' })).toThrow(McpError);
    expect(() => sanitizeMcpConfig({ name: '', command: 'x' })).toThrow(McpError);
    expect(() => sanitizeMcpConfig({ name: 'ok', command: '' })).toThrow(McpError);
    expect(() => sanitizeMcpConfig('nope')).toThrow(McpError);
  });

  it('rejects malformed args/env/allowTools', () => {
    expect(() => sanitizeMcpConfig({ name: 'ok', command: 'x', args: ['-y', 3] })).toThrow(McpError);
    expect(() => sanitizeMcpConfig({ name: 'ok', command: 'x', env: { K: 1 } })).toThrow(McpError);
    expect(() => sanitizeMcpConfig({ name: 'ok', command: 'x', allowTools: ['a', ''] })).toThrow(McpError);
    expect(() => sanitizeMcpConfig({ name: 'ok', command: 'x', perUser: 'yes' })).toThrow(McpError);
  });
});

describe('registry persistence', () => {
  it('rejects duplicate names', async () => {
    await expect(addMcpServer({ name: 'browser', command: 'x' })).rejects.toThrow(McpError);
  });

  it('updates a server while keeping the name immutable', async () => {
    const updated = await updateMcpServer('browser', {
      name: 'renamed-attempt',
      command: 'npx',
      args: ['@playwright/mcp', '--isolated'],
    });
    // The :name route param wins — the stored name is unchanged.
    expect(updated.name).toBe('browser');
    expect(updated.args).toEqual(['@playwright/mcp', '--isolated']);

    const servers = await loadMcpServers();
    expect(servers.find((s) => s.name === 'browser')?.args).toContain('--isolated');
  });

  it('throws NOT_FOUND for unknown servers', async () => {
    await expect(updateMcpServer('nope', { name: 'nope', command: 'x' })).rejects.toThrow(McpError);
    await expect(removeMcpServer('nope')).rejects.toThrow(McpError);
  });

  it('removes a server', async () => {
    await removeMcpServer('browser');
    const servers = await loadMcpServers();
    expect(servers.find((s) => s.name === 'browser')).toBeUndefined();
  });
});
