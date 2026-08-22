/**
 * Pure helpers for reconstructing chat state from the persisted
 * `StoredEvent[]` timeline — kept out of ChatPanel.tsx so they can be unit
 * tested without pulling in the component (and so the component file keeps
 * fast-refresh compatibility).
 */

import type { ChatMessage, ProposedChange, StoredEvent, TurnEvent } from '../types.ts';

/**
 * Merge consecutive assistant messages into one. The UI may split a single
 * LLM turn into multiple assistant bubbles (text before/after tool calls),
 * but the LLM API expects alternating user/assistant roles.
 */
export function mergeConsecutiveAssistants(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const m of messages) {
    const last = result[result.length - 1];
    if (last && last.role === 'assistant' && m.role === 'assistant') {
      last.content += (last.content && m.content ? '\n' : '') + m.content;
    } else {
      result.push({ ...m });
    }
  }
  return result;
}

/**
 * Reconstruct in-memory chat state (messages, past turns, proposed changes)
 * from a persisted `StoredEvent[]` timeline.
 */
export function restoreFromEvents(events: StoredEvent[]): {
  messages: ChatMessage[];
  pastTurns: TurnEvent[][];
  proposedChanges: ProposedChange[];
  compactionIndex: number | null;
} {
  const messages: ChatMessage[] = [];
  const pastTurns: TurnEvent[][] = [];
  const proposedChanges: ProposedChange[] = [];
  let currentTurn: TurnEvent[] = [];
  let compactionIndex: number | null = null;

  // Attach pending turn events (tools/edits/errors without a closing
  // assistant message) as a synthetic interrupted turn, anchored to a
  // placeholder assistant message so pastTurns stay 1:1 aligned with
  // assistant messages.
  const flushInterruptedTurn = () => {
    if (currentTurn.length === 0) return;
    pastTurns.push(currentTurn);
    messages.push({
      role: 'assistant',
      content: '⚠️ This response was interrupted.',
    });
    currentTurn = [];
  };

  for (const ev of events) {
    if (ev.kind === 'user') {
      // A user message arriving while turn events are still pending means
      // the previous turn never persisted a closing assistant message
      // (interrupted, aborted, or the user typed while it was running).
      // Flush those events in place — discarding them would drop their
      // proposed changes out of the inline timeline while they stay in
      // `proposedChanges`, making them render out of order at the bottom
      // of the chat.
      flushInterruptedTurn();
      messages.push({ role: 'user', content: ev.content ?? '' });
      currentTurn = [];
    } else if (ev.kind === 'tool') {
      if (ev.toolCall) currentTurn.push({ kind: 'tool', toolCall: ev.toolCall });
    } else if (ev.kind === 'proposed') {
      if (ev.change) {
        proposedChanges.push(ev.change);
        currentTurn.push({ kind: 'proposed', change: ev.change });
      }
    } else if (ev.kind === 'error') {
      currentTurn.push({ kind: 'error', text: ev.content ?? 'Unknown error' });
    } else if (ev.kind === 'compaction') {
      // The compaction summary becomes an assistant message. Everything from
      // this point onwards is the active context sent to the LLM.
      pastTurns.push(currentTurn);
      messages.push({ role: 'assistant', content: ev.content ?? '' });
      compactionIndex = messages.length - 1;
      currentTurn = [];
    } else if (ev.kind === 'assistant') {
      // The current turn's events belong to this assistant message.
      pastTurns.push(currentTurn);
      messages.push({ role: 'assistant', content: ev.content ?? '' });
      currentTurn = [];
    }
    // 'turn_end' is a completion marker only — nothing to render.
  }

  // If there are orphaned events at the end of the timeline (incomplete
  // turn — e.g. interrupted by error), attach them as a synthetic turn
  // with a placeholder assistant message so they're visible.
  flushInterruptedTurn();

  return { messages, pastTurns, proposedChanges, compactionIndex };
}

/**
 * Check whether a turn has completed in the stored event timeline.
 * Returns true if the turn opened by the last user message matching
 * `userContent` has a `turn_end` marker after it.
 *
 * Timelines recorded before `turn_end` existed fall back to "an assistant
 * message follows the user message". New timelines always record `turn_end`
 * (including on error/abort), which avoids finalizing early on intermediate
 * assistant content that precedes further tool calls.
 */
export function isTurnComplete(events: StoredEvent[], userContent: string): boolean {
  let lastUserIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === 'user' && events[i].content === userContent) {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return false;
  return turnEndedAfter(events, lastUserIdx);
}

/**
 * Check whether the LAST turn in a stored timeline has completed — used to
 * detect a turn still running server-side after a reload/reconnect.
 */
export function isLastTurnComplete(events: StoredEvent[]): boolean {
  let lastUserIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return true; // no turn open
  return turnEndedAfter(events, lastUserIdx);
}

/** Shared completion check: does a turn-end marker follow `fromIdx`? */
function turnEndedAfter(events: StoredEvent[], lastUserIdx: number): boolean {
  const after = events.slice(lastUserIdx + 1);
  if (events.some((e) => e.kind === 'turn_end')) {
    // New-format timeline — the definitive marker must follow.
    return after.some((e) => e.kind === 'turn_end');
  }
  // Legacy timeline (no turn_end markers at all).
  return after.some((e) => e.kind === 'assistant');
}
