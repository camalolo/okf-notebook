import { describe, it, expect } from 'vitest';
import { buildResumeMessages, isLastTurnInterrupted } from './resume.js';
import type { StoredEvent } from '../chats.js';

const ev = (
  kind: StoredEvent['kind'],
  seq: number,
  extra: Partial<StoredEvent> = {},
): StoredEvent => ({ kind, seq, ts: '0', ...extra });

const tool = (seq: number, name: string, result: unknown): StoredEvent => ({
  kind: 'tool',
  seq,
  ts: '0',
  toolCall: { name, args: { q: 1 }, result },
});

describe('isLastTurnInterrupted', () => {
  it('true when the last event is an interrupted turn_end', () => {
    const events = [
      ev('user', 0, { content: 'hi' }),
      tool(1, 'web_search', 'r'),
      ev('turn_end', 2, { interrupted: true }),
    ];
    expect(isLastTurnInterrupted(events)).toBe(true);
  });

  it('false for a normal turn_end', () => {
    const events = [
      ev('user', 0, { content: 'hi' }),
      ev('assistant', 1, { content: 'ok' }),
      ev('turn_end', 2),
    ];
    expect(isLastTurnInterrupted(events)).toBe(false);
  });

  it('false when an interrupted turn_end is followed by later events', () => {
    const events = [
      ev('user', 0, { content: 'hi' }),
      ev('turn_end', 1, { interrupted: true }),
      ev('assistant', 2, { content: 'resumed' }),
      ev('turn_end', 3),
    ];
    expect(isLastTurnInterrupted(events)).toBe(false);
  });
});

describe('buildResumeMessages', () => {
  it('replays the interrupted turn tool-aware: assistant tool_calls + tool results', () => {
    const events = [
      ev('user', 0, { content: 'analyze my positions' }),
      ev('assistant', 1, { content: 'Checking…' }),
      tool(2, 'flex_positions', [{ sym: 'SGOV' }]),
      tool(3, 'web_search', 'results'),
      ev('turn_end', 4, { interrupted: true }),
    ];

    const msgs = buildResumeMessages(events);

    expect(msgs.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'tool',
      'tool',
    ]);
    // Reconstructed tool_calls message with synthesized ids and JSON args.
    const callMsg = msgs[2]!;
    expect(callMsg.tool_calls).toHaveLength(2);
    expect(callMsg.tool_calls![0]!.function.name).toBe('flex_positions');
    expect(callMsg.tool_calls![0]!.id).toMatch(/^call_resume_/);
    // Tool results reference the call ids and stringify the results.
    expect(msgs[3]!.tool_call_id).toBe(callMsg.tool_calls![0]!.id);
    expect(JSON.parse(msgs[3]!.content!)).toEqual([{ sym: 'SGOV' }]);
  });

  it('history may end on partial assistant content (prefill continuation)', () => {
    const events = [
      ev('user', 0, { content: 'hi' }),
      ev('assistant', 1, { content: 'The answer is ' }),
      ev('turn_end', 2, { interrupted: true }),
    ];
    const msgs = buildResumeMessages(events);
    expect(msgs[msgs.length - 1]).toEqual({ role: 'assistant', content: 'The answer is ' });
  });

  it('starts from the last compaction summary', () => {
    const events = [
      ev('user', 0, { content: 'old' }),
      ev('assistant', 1, { content: 'old answer' }),
      ev('turn_end', 2),
      ev('compaction', 3, { content: 'SUMMARY' }),
      ev('user', 4, { content: 'new' }),
      ev('turn_end', 5, { interrupted: true }),
    ];
    const msgs = buildResumeMessages(events);
    expect(msgs.map((m) => m.content)).toEqual(['SUMMARY', 'new']);
  });

  it('throws when there is nothing to resume', () => {
    expect(() =>
      buildResumeMessages([ev('user', 0, { content: 'hi' }), ev('turn_end', 1)]),
    ).toThrow(/nothing to resume/i);
  });
});
