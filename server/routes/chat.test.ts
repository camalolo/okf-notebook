import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  READONLY_TOOLS,
  WRITE_TOOLS,
  GIT_TOOLS,
  buildSystemPrompt,
} from './chat.js';
import type { ToolDefinition } from '../lib/llm.js';
import type { BundleConfig } from '../config.js';

const names = (ts: ToolDefinition[]): string[] => ts.map((t) => t.function.name);

describe('chat tool lists (regression: git tools silently unplugged in 6cb3ac3)', () => {
  it('readonly tools are exactly the safe baseline', () => {
    expect(names(READONLY_TOOLS)).toEqual([
      'read_file',
      'list_files',
      'eval_maths',
      'web_search',
    ]);
  });

  it('readonly tools expose no git, editing, or mail capabilities', () => {
    const ns = names(READONLY_TOOLS);
    for (const n of ns) {
      expect(n).not.toMatch(/^(git_|edit_|create_|delete_|undo_|send_)/);
    }
  });

  it('git inspection tools exist and are full-role only', () => {
    expect(names(GIT_TOOLS)).toEqual(['git_status', 'git_diff', 'git_log']);
    const readonly = new Set(names(READONLY_TOOLS));
    for (const n of names(GIT_TOOLS)) expect(readonly.has(n)).toBe(false);
  });

  it('write tools carry editing + git_commit, not git inspection', () => {
    const ns = new Set(names(WRITE_TOOLS));
    expect(ns.has('git_commit')).toBe(true);
    expect(ns.has('edit_file')).toBe(true);
    expect(ns.has('git_status')).toBe(false);
    expect(ns.has('git_diff')).toBe(false);
    expect(ns.has('git_log')).toBe(false);
  });

  it('no tool name is duplicated across the lists (full set = union)', () => {
    const all = [...names(READONLY_TOOLS), ...names(GIT_TOOLS), ...names(WRITE_TOOLS)];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('buildSystemPrompt advertises only exposed capabilities', () => {
  let bundle: BundleConfig;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notebook-chat-test-'));
    bundle = {
      id: 'test',
      name: 'Test Bundle',
      path: tmpDir,
      icon: 'book',
      description: 'test bundle',
    };
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('readonly default prompt mentions no git status or editing', async () => {
    const prompt = await buildSystemPrompt(bundle);
    expect(prompt).toContain('read files');
    expect(prompt).not.toContain('check git status');
    expect(prompt).not.toContain('edit_file or create_file');
  });

  it('full-role prompt mentions git and editing', async () => {
    const full = [...names(READONLY_TOOLS), ...names(GIT_TOOLS), ...names(WRITE_TOOLS)];
    const prompt = await buildSystemPrompt(bundle, [], full);
    expect(prompt).toContain('check git status');
    expect(prompt).toContain('edit_file or create_file');
    expect(prompt).toContain('git_commit');
  });
});
