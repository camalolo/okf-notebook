/**
 * Turn resume — reconstruct the LLM message history of a chat whose last
 * turn was interrupted (killed by a server restart/crash, closed by the
 * boot sweep with `turn_end { interrupted: true }`).
 *
 * The persisted timeline contains everything the model had: message text
 * AND tool calls with their results. Reconstruction replays the
 * interrupted turn as proper assistant `tool_calls` + `tool` messages so
 * the model continues from its actual working state — no "please
 * continue", no restarting the reasoning, no redoing tool calls whose
 * results are already on disk.
 *
 * The history may end in one of three shapes (all valid continuation
 * points for an OpenAI-compatible chat API):
 *   - a `tool` message  → the model continues the agentic loop naturally
 *   - an assistant text → prefill-style continuation from that partial answer
 *   - a user message    → the turn died before any output; answered fresh
 */

import type { StoredEvent } from '../chats.js';
import type { ChatMessage, ToolCall } from './llm.js';

/** Ids for reconstructed tool calls — unique within the request. */
function synthId(n: number): string {
  return `call_resume_${n}`;
}

/**
 * Whether the timeline's last turn was closed by the boot sweep as
 * interrupted (the Resume button's visibility condition).
 */
export function isLastTurnInterrupted(events: StoredEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind === 'turn_end') return ev.interrupted === true;
  }
  return false;
}

/**
 * Build the resume history from a chat timeline: everything from the last
 * compaction summary onwards (the active context — same rule the client
 * uses), with the interrupted final turn replayed tool-aware.
 *
 * @throws Error when the last turn is not marked interrupted (nothing to
 *         resume — the caller returns 400).
 */
export function buildResumeMessages(events: StoredEvent[]): ChatMessage[] {
  if (!isLastTurnInterrupted(events)) {
    throw new Error('Last turn is not interrupted — nothing to resume');
  }

  // Active context starts after the last compaction event (its summary is
  // included as the opening assistant message, mirroring restoreFromEvents).
  let start = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i].kind === 'compaction') start = i;
  }

  const messages: ChatMessage[] = [];
  /** Pending reconstructed tool calls of the current round. */
  let pendingRound: { call: ToolCall; result: unknown }[] = [];

  let callCounter = 0;
  const flushRound = () => {
    if (pendingRound.length === 0) return;
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: pendingRound.map((r) => r.call),
    });
    for (const r of pendingRound) {
      messages.push({
        role: 'tool',
        tool_call_id: r.call.id,
        content: JSON.stringify(r.result ?? null),
      });
    }
    pendingRound = [];
  };

  for (let i = start; i < events.length; i++) {
    const ev = events[i];
    if (ev.kind === 'user') {
      flushRound();
      messages.push({ role: 'user', content: ev.content ?? '' });
    } else if (ev.kind === 'assistant') {
      flushRound();
      // Skip empty assistant events (mid-round content flushes with no text)
      // so the history never ends on a contentless assistant message unless
      // it carries tool_calls (flushRound emits those separately).
      if ((ev.content ?? '').trim()) {
        messages.push({ role: 'assistant', content: ev.content ?? '' });
      }
    } else if (ev.kind === 'compaction') {
      flushRound();
      messages.push({ role: 'assistant', content: ev.content ?? '' });
    } else if (ev.kind === 'tool') {
      if (!ev.toolCall) continue;
      const id = synthId(callCounter++);
      pendingRound.push({
        call: {
          id,
          type: 'function',
          function: {
            name: ev.toolCall.name,
            arguments: JSON.stringify(ev.toolCall.args ?? {}),
          },
        },
        result: ev.toolCall.result,
      });
    }
    // 'proposed' / 'error' / 'turn_end' carry no LLM-visible content here:
    // proposed edits are mirrored by the tool results that applied them,
    // errors were transient, and turn_end is a marker.
  }
  flushRound();

  if (messages.length === 0) {
    throw new Error('Nothing to resume — timeline has no active context');
  }
  return messages;
}
