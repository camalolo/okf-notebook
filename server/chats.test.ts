import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Redirect chat storage to a temp dir (must be set before import).
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notebook-chats-test-'));
process.env.NOTEBOOK_CHATS_DIR = path.join(tmpDir, 'chats');

const { isLastTurnTerminated, finalizeOrphanedTurns, autoTitleCandidate, autoTitleFromFirstMessage } =
  await import('./chats.js');

const ev = (kind: 'user' | 'assistant' | 'tool' | 'turn_end', seq: number, content = '') => ({
  kind,
  seq,
  ts: new Date().toISOString(),
  ...(content ? { content } : {}),
});

async function writeChat(bundleId: string, chatId: string, events: unknown[]) {
  const dir = path.join(tmpDir, 'chats', bundleId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${chatId}.json`),
    JSON.stringify({ id: chatId, bundleId, userId: 'u@x.com', title: 't', createdAt: '', updatedAt: '', events }, null, 2),
    'utf8',
  );
}

beforeAll(async () => {
  // Turn killed mid-flight by a restart: tool calls, no assistant, no turn_end.
  await writeChat('b1', 'orphan', [
    ev('user', 0, 'hi'),
    ev('tool', 1),
    ev('tool', 2),
  ]);
  // Healthy timeline (turn_end present).
  await writeChat('b1', 'healthy', [
    ev('user', 0, 'hi'),
    ev('assistant', 1, 'done'),
    ev('turn_end', 2),
  ]);
  // Legacy timeline: assistant closes the turn, no turn_end anywhere.
  await writeChat('b2', 'legacy', [
    ev('user', 0, 'hi'),
    ev('assistant', 1, 'done'),
  ]);
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('isLastTurnTerminated', () => {
  it('detects an unterminated last turn (tools trailing)', () => {
    expect(isLastTurnTerminated([ev('user', 0), ev('tool', 1)])).toBe(false);
  });

  it('accepts turn_end in new-format timelines', () => {
    expect(isLastTurnTerminated([ev('user', 0), ev('assistant', 1), ev('turn_end', 2)])).toBe(true);
  });

  it('falls back to a closing assistant message in legacy timelines', () => {
    expect(isLastTurnTerminated([ev('user', 0), ev('assistant', 1)])).toBe(true);
  });

  it('treats a timeline without user messages as terminated', () => {
    expect(isLastTurnTerminated([])).toBe(true);
    expect(isLastTurnTerminated([ev('assistant', 0)])).toBe(true);
  });

  it('does not count a turn_end belonging to an EARLIER turn', () => {
    // Turn 1 completed; turn 2 opened by a new user message and killed.
    expect(
      isLastTurnTerminated([ev('user', 0), ev('assistant', 1), ev('turn_end', 2), ev('user', 3), ev('tool', 4)]),
    ).toBe(false);
  });
});

describe('finalizeOrphanedTurns', () => {
  it('appends turn_end only to orphaned chats and assigns the next seq', async () => {
    expect(await finalizeOrphanedTurns()).toBe(1);

    const orphan = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'chats', 'b1', 'orphan.json'), 'utf8'),
    );
    const last = orphan.events[orphan.events.length - 1];
    expect(last.kind).toBe('turn_end');
    expect(last.seq).toBe(3);

    const healthy = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'chats', 'b1', 'healthy.json'), 'utf8'),
    );
    expect(healthy.events).toHaveLength(3); // untouched

    const legacy = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'chats', 'b2', 'legacy.json'), 'utf8'),
    );
    expect(legacy.events).toHaveLength(2); // untouched (assistant closed it)
  });

  it('is idempotent — a second sweep repairs nothing', async () => {
    expect(await finalizeOrphanedTurns()).toBe(0);
  });
});

describe('updateChatMeta', () => {
  it('persists lastUsage without touching events', async () => {
    const { updateChatMeta, loadChat } = await import('./chats.js');
    await writeChat('b1', 'healthy', [ev('user', 0, 'hi')]);
    await updateChatMeta('b1', 'healthy', 'u@x.com', {
      lastUsage: { promptTokens: 11345, completionTokens: 10 },
    });
    const chat = await loadChat('b1', 'healthy', 'u@x.com');
    expect(chat?.lastUsage?.promptTokens).toBe(11345);
    expect(chat?.events).toHaveLength(1);
  });

  it('is a no-op for unknown or unowned chats', async () => {
    const { updateChatMeta } = await import('./chats.js');
    await expect(
      updateChatMeta('b1', 'nope', 'u@x.com', { lastUsage: { promptTokens: 1 } }),
    ).resolves.toBeUndefined();
  });
});

describe('autoTitleFromFirstMessage', () => {
  it('truncates to 60 characters and trims the edges', () => {
    const long = 'x'.repeat(100) + '   ';
    expect(autoTitleFromFirstMessage(long)).toBe('x'.repeat(60));
    expect(autoTitleFromFirstMessage('  hello world  ')).toBe('hello world');
  });

  it('falls back to "New chat" for blank content', () => {
    expect(autoTitleFromFirstMessage('   ')).toBe('New chat');
    expect(autoTitleFromFirstMessage('')).toBe('New chat');
  });
});

describe('autoTitleCandidate', () => {
  const firstMsg = 'Please review the ibkr-flex reporting pipeline for me';
  const autoTitle = firstMsg.slice(0, 60);

  it('is eligible after the first exchange and returns the materials', () => {
    const events = [
      ev('user', 0, firstMsg),
      ev('tool', 1),
      ev('assistant', 2, 'I reviewed the pipeline.'),
      ev('turn_end', 3),
    ];
    expect(autoTitleCandidate(events, autoTitle)).toEqual({
      user: firstMsg,
      assistant: 'I reviewed the pipeline.',
    });
  });

  it('is eligible while the title is still "New chat"', () => {
    const events = [ev('user', 0, '   '), ev('assistant', 1, 'Hi!')];
    expect(autoTitleCandidate(events, 'New chat')).toEqual({
      user: '   ',
      assistant: 'Hi!',
    });
  });

  it('is not eligible once a real title was set (LLM or user rename)', () => {
    const events = [ev('user', 0, firstMsg), ev('assistant', 1, 'Done.')];
    expect(autoTitleCandidate(events, 'Ibkr Flex Pipeline Review')).toBeNull();
  });

  it('is not eligible when the conversation has more than one user message', () => {
    const events = [
      ev('user', 0, firstMsg),
      ev('assistant', 1, 'Done.'),
      ev('turn_end', 2),
      ev('user', 3, 'thanks, one more thing'),
    ];
    expect(autoTitleCandidate(events, autoTitle)).toBeNull();
  });

  it('is not eligible without a non-empty assistant reply', () => {
    expect(autoTitleCandidate([ev('user', 0, firstMsg), ev('turn_end', 1)], autoTitle)).toBeNull();
    expect(
      autoTitleCandidate([ev('user', 0, firstMsg), ev('assistant', 1, '   ')], autoTitle),
    ).toBeNull();
  });

  it('titles from the LAST assistant reply', () => {
    const events = [
      ev('user', 0, firstMsg),
      ev('assistant', 1, 'First attempt.'),
      ev('tool', 2),
      ev('assistant', 3, 'Corrected answer.'),
      ev('turn_end', 4),
    ];
    expect(autoTitleCandidate(events, autoTitle)?.assistant).toBe('Corrected answer.');
  });
});

