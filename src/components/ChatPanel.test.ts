import { describe, it, expect } from 'vitest';
import { restoreFromEvents, mergeConsecutiveAssistants } from '../components/ChatPanel.tsx';
import type { StoredEvent, ChatMessage } from '../types.ts';

describe('restoreFromEvents — ordering after interruption', () => {
  // -------------------------------------------------------------------------
  // Test 1: Content streamed BEFORE tool calls must appear before them
  // in the reconstructed UI state.
  //
  // Server timeline (with the fix that persists content before tools):
  //   user → assistant("Sure! I'll check...") → tool(read_file) → assistant("Done!")
  //
  // Expected UI ordering:
  //   user → "Sure! I'll check..." → [read_file card] → "Done!"
  // -------------------------------------------------------------------------
  it('places content before tool calls when assistant message precedes tools in timeline', () => {
    const events: StoredEvent[] = [
      { ts: '0', seq: 0, kind: 'user', content: 'check the file' },
      { ts: '1', seq: 1, kind: 'assistant', content: 'Sure! I\'ll check...' },
      { ts: '2', seq: 2, kind: 'tool', toolCall: { name: 'read_file', args: {}, result: 'data' } },
      { ts: '3', seq: 3, kind: 'assistant', content: 'Done!' },
    ];

    const { messages, pastTurns } = restoreFromEvents(events);

    // 3 messages: user, assistant1, assistant2
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('user');
    expect(messages[1].content).toBe('Sure! I\'ll check...');
    expect(messages[2].content).toBe('Done!');

    // pastTurns[0] (before first assistant) = []
    // pastTurns[1] (before second assistant) = [read_file]
    expect(pastTurns).toHaveLength(2);
    expect(pastTurns[0]).toHaveLength(0);
    expect(pastTurns[1]).toHaveLength(1);
    expect(pastTurns[1][0].kind).toBe('tool');
  });

  // -------------------------------------------------------------------------
  // Test 2: Interrupted mid-tool-execution — content before tools is
  // preserved, orphaned tool events get a placeholder.
  //
  // Server timeline: user → assistant("text") → tool(nav1) → tool(nav2)
  // (No closing assistant message — interrupted during tool execution.)
  // -------------------------------------------------------------------------
  it('preserves content before orphaned tool events on interruption', () => {
    const events: StoredEvent[] = [
      { ts: '0', seq: 0, kind: 'user', content: 'navigate to 5 sites' },
      { ts: '1', seq: 1, kind: 'assistant', content: 'Sure! I\'ll fire off 5 navigations...' },
      { ts: '2', seq: 2, kind: 'tool', toolCall: { name: 'browser_navigate', args: { url: 'example.com' }, result: 'ok' } },
      { ts: '3', seq: 3, kind: 'tool', toolCall: { name: 'browser_navigate', args: { url: 'wikipedia.org' }, result: 'ok' } },
    ];

    const { messages, pastTurns } = restoreFromEvents(events);

    // user + assistant(text) + orphaned assistant
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('user');
    expect(messages[1].content).toBe('Sure! I\'ll fire off 5 navigations...');

    // The text appears in messages[1], and tools are in pastTurns[1] (after text).
    // pastTurns[0] = [] (before the text)
    // pastTurns[1] = [nav1, nav2] (orphaned, after text)
    expect(pastTurns).toHaveLength(2);
    expect(pastTurns[0]).toHaveLength(0);
    expect(pastTurns[1]).toHaveLength(2);
    expect(pastTurns[1][0].kind).toBe('tool');
    expect(pastTurns[1][1].kind).toBe('tool');
  });

  // -------------------------------------------------------------------------
  // Test 3: Interrupted during LLM streaming (no tool calls at all).
  // Only partial text is preserved.
  // -------------------------------------------------------------------------
  it('preserves partial content when interrupted during streaming', () => {
    const events: StoredEvent[] = [
      { ts: '0', seq: 0, kind: 'user', content: 'hello' },
      { ts: '1', seq: 1, kind: 'assistant', content: 'Hi there! Let me...' },
    ];

    const { messages, pastTurns } = restoreFromEvents(events);

    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe('Hi there! Let me...');
    expect(pastTurns).toHaveLength(1);
    expect(pastTurns[0]).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 4: Multi-step turn with interleaved content and tools.
  // -------------------------------------------------------------------------
  it('correctly interleaves multiple content segments with tool calls', () => {
    const events: StoredEvent[] = [
      { ts: '0', seq: 0, kind: 'user', content: 'do the thing' },
      { ts: '1', seq: 1, kind: 'assistant', content: 'Let me check A.' },
      { ts: '2', seq: 2, kind: 'tool', toolCall: { name: 'read_a', args: {}, result: 'a' } },
      { ts: '3', seq: 3, kind: 'assistant', content: 'Now let me check B.' },
      { ts: '4', seq: 4, kind: 'tool', toolCall: { name: 'read_b', args: {}, result: 'b' } },
      { ts: '5', seq: 5, kind: 'assistant', content: 'Here\'s what I found.' },
    ];

    const { messages, pastTurns } = restoreFromEvents(events);

    // 4 messages: user, asst1, asst2, asst3
    expect(messages).toHaveLength(4);
    // 3 pastTurns entries
    expect(pastTurns).toHaveLength(3);
    // pastTurns[0] = [] (nothing before asst1)
    // pastTurns[1] = [read_a] (before asst2)
    // pastTurns[2] = [read_b] (before asst3)
    expect(pastTurns[0]).toHaveLength(0);
    expect(pastTurns[1]).toHaveLength(1);
    expect(pastTurns[2]).toHaveLength(1);
  });
  // -------------------------------------------------------------------------
  // Test 5: `turn_end` markers are transparent to restoration.
  // -------------------------------------------------------------------------
  it('ignores turn_end markers when restoring a timeline', () => {
    const events: StoredEvent[] = [
      { ts: '0', seq: 0, kind: 'user', content: 'do the thing' },
      { ts: '1', seq: 1, kind: 'assistant', content: 'Let me check A.' },
      { ts: '2', seq: 2, kind: 'tool', toolCall: { name: 'read_a', args: {}, result: 'a' } },
      { ts: '3', seq: 3, kind: 'assistant', content: 'Here\'s what I found.' },
      { ts: '4', seq: 4, kind: 'turn_end' },
    ];

    const { messages, pastTurns } = restoreFromEvents(events);

    expect(messages).toHaveLength(3);
    expect(messages[2].content).toBe('Here\'s what I found.');
    expect(pastTurns).toHaveLength(2);
    expect(pastTurns[1]).toHaveLength(1);
    expect(pastTurns[1][0].kind).toBe('tool');
  });

  // -------------------------------------------------------------------------
  // Test 6: a turn aborted mid-tool (user → tool → turn_end, no closing
  // assistant) still renders its orphaned tool events with a placeholder.
  // -------------------------------------------------------------------------
  it('shows placeholder for a turn ended by abort before any assistant content', () => {
    const events: StoredEvent[] = [
      { ts: '0', seq: 0, kind: 'user', content: 'check things' },
      { ts: '1', seq: 1, kind: 'tool', toolCall: { name: 'list_files', args: {}, result: [] } },
      { ts: '2', seq: 2, kind: 'turn_end' },
    ];

    const { messages, pastTurns } = restoreFromEvents(events);

    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe('assistant');
    expect(pastTurns).toHaveLength(1);
    expect(pastTurns[0]).toHaveLength(1);
    expect(pastTurns[0][0].kind).toBe('tool');
  });

  // -------------------------------------------------------------------------
  // Test 7: regression — a turn interrupted right after applied edits, with
  // the next user message persisted before any closing assistant message.
  // The edits must stay inline in the interrupted turn (rendered in
  // chronological position), NOT fall out of the turn timeline — otherwise
  // they render out of order at the bottom of the chat via the
  // `pastProposed` fallback.
  //
  // Real-world shape (investing bundle, Aug 2026): user → assistant →
  // edit_file ×3 (applied) → user "Resume" → assistant → … → compaction →
  // user "flex your flex" → assistant → tools.
  // -------------------------------------------------------------------------
  it('keeps edits from an interrupted turn inline when a user message follows', () => {
    const change = (id: string, path: string): StoredEvent['change'] => ({
      id,
      type: 'edit',
      path,
      oldContent: 'old',
      newContent: 'new',
      status: 'applied',
    });
    const events: StoredEvent[] = [
      { ts: '0', seq: 0, kind: 'user', content: 'triple-check the exit' },
      { ts: '1', seq: 1, kind: 'assistant', content: 'Triple-check time.' },
      { ts: '2', seq: 2, kind: 'tool', toolCall: { name: 'edit_file', args: {}, result: 'ok' } },
      { ts: '3', seq: 3, kind: 'proposed', change: change('e1', 'strategies/moat-exit.md') },
      { ts: '4', seq: 4, kind: 'tool', toolCall: { name: 'edit_file', args: {}, result: 'ok' } },
      { ts: '5', seq: 5, kind: 'proposed', change: change('e2', 'log.md') },
      // Interrupted here — next event is the user typing again.
      { ts: '6', seq: 6, kind: 'user', content: 'Resume' },
      { ts: '7', seq: 7, kind: 'assistant', content: 'All consolidated.' },
      { ts: '8', seq: 8, kind: 'compaction', content: '# Summary' },
      { ts: '9', seq: 9, kind: 'user', content: 'flex your flex' },
      { ts: '10', seq: 10, kind: 'assistant', content: 'Flexing all three at once.' },
      { ts: '11', seq: 11, kind: 'tool', toolCall: { name: 'flex_positions', args: {}, result: {} } },
    ];

    const { messages, pastTurns, proposedChanges, compactionIndex } = restoreFromEvents(events);

    // Invariant the renderer relies on: every proposed change appears in
    // some pastTurns entry, so it renders inline instead of via the
    // bottom-of-chat `pastProposed` fallback.
    const inlineIds = new Set(
      pastTurns.flat().filter((e) => e.kind === 'proposed').map((e) => (e as { kind: 'proposed'; change: { id: string } }).change.id),
    );
    for (const c of proposedChanges) {
      expect(inlineIds.has(c.id)).toBe(true);
    }

    // pastTurns stay 1:1 aligned with assistant messages.
    const assistantCount = messages.filter((m) => m.role === 'assistant').length;
    expect(pastTurns).toHaveLength(assistantCount);

    // The interrupted turn's edits are anchored BEFORE the "Resume" user
    // message, via a placeholder assistant message.
    const resumeIdx = messages.findIndex((m) => m.role === 'user' && m.content === 'Resume');
    expect(resumeIdx).toBeGreaterThan(0);
    expect(messages[resumeIdx - 1].role).toBe('assistant');
    expect(messages[resumeIdx - 1].content).toContain('interrupted');

    // Compaction still tracks the summary message.
    expect(compactionIndex).toBe(messages.findIndex((m) => m.content === '# Summary'));
  });

  // -------------------------------------------------------------------------
  // Test 8: same interruption shape but with a turn_end marker (new-format
  // timelines where the turn was aborted after edits, then the user sent a
  // new message).
  // -------------------------------------------------------------------------
  it('keeps orphaned edits inline across turn_end followed by a user message', () => {
    const events: StoredEvent[] = [
      { ts: '0', seq: 0, kind: 'user', content: 'do edits' },
      { ts: '1', seq: 1, kind: 'tool', toolCall: { name: 'edit_file', args: {}, result: 'ok' } },
      {
        ts: '2',
        seq: 2,
        kind: 'proposed',
        change: { id: 'e1', type: 'edit', path: 'log.md', newContent: 'x', status: 'applied' },
      },
      { ts: '3', seq: 3, kind: 'turn_end' },
      { ts: '4', seq: 4, kind: 'user', content: 'next request' },
      { ts: '5', seq: 5, kind: 'assistant', content: 'Done.' },
    ];

    const { messages, pastTurns, proposedChanges } = restoreFromEvents(events);

    const inlineIds = new Set(
      pastTurns.flat().filter((e) => e.kind === 'proposed').map((e) => (e as { kind: 'proposed'; change: { id: string } }).change.id),
    );
    expect(inlineIds.has('e1')).toBe(true);
    expect(proposedChanges).toHaveLength(1);

    const nextIdx = messages.findIndex((m) => m.role === 'user' && m.content === 'next request');
    expect(messages[nextIdx - 1].content).toContain('interrupted');
    const assistantCount = messages.filter((m) => m.role === 'assistant').length;
    expect(pastTurns).toHaveLength(assistantCount);
  });
});

describe('mergeConsecutiveAssistants', () => {
  it('merges consecutive assistant messages into one', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Let me check.' },
      { role: 'assistant', content: 'Done!' },
      { role: 'user', content: 'thanks' },
    ];

    const merged = mergeConsecutiveAssistants(messages);

    expect(merged).toHaveLength(3);
    expect(merged[0].role).toBe('user');
    expect(merged[1].role).toBe('assistant');
    expect(merged[1].content).toBe('Let me check.\nDone!');
    expect(merged[2].role).toBe('user');
  });

  it('handles empty assistant messages (from trailing tools)', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'text before tools' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'next' },
    ];

    const merged = mergeConsecutiveAssistants(messages);

    expect(merged).toHaveLength(3);
    expect(merged[1].content).toBe('text before tools');
  });

  it('leaves non-consecutive messages untouched', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'x' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'y' },
    ];

    const merged = mergeConsecutiveAssistants(messages);

    expect(merged).toHaveLength(4);
    expect(merged.map((m) => m.content)).toEqual(['a', 'x', 'b', 'y']);
  });
});
