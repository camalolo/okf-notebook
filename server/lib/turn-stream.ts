/**
 * Per-turn SSE event buffer + live subscriber fan-out — enables TRUE stream
 * reconnection. The chat loop records every event it emits (with a
 * monotonic id); a client that drops mid-turn (network blip, page reload)
 * re-attaches via GET /chat/stream?chatId=…&since=N and receives the replay
 * of everything after `since`, then continues receiving live events —
 * identical to having stayed connected.
 *
 * Lifecycle: beginTurn(key) when the POST /chat loop starts; record() on
 * every emit; endTurn(key) at the terminal event (done/error/abort), which
 * flushes subscribers and keeps the buffer for GRACE_MS (a client that
 * reconnects right after the end still receives its `done`); then cleanup.
 *
 * Buffers are in-memory per process — a restart mid-turn still loses the
 * stream (the boot sweep + Resume button cover that case).
 */

export interface BufferedEvent {
  id: number;
  event: string;
  data: unknown;
}

interface TurnStream {
  events: BufferedEvent[];
  nextId: number;
  done: boolean;
  /** Responses currently attached (reconnected clients). */
  subscribers: Set<{
    write: (chunk: string) => void;
    end: () => void;
  }>;
  /** Post-done grace timer. */
  ttl?: ReturnType<typeof setTimeout>;
}

const TURNS = new Map<string, TurnStream>();

/** Grace period after a turn ends before its buffer is dropped (ms). */
const GRACE_MS = 60_000;

export function turnKey(bundleId: string, chatId: string): string {
  return `${bundleId}/${chatId}`;
}

/** Begin buffering a turn. No-op (and returns null) if one is already active. */
export function beginTurn(key: string): boolean {
  const existing = TURNS.get(key);
  if (existing && !existing.done) return false;
  if (existing) {
    clearTimeout(existing.ttl);
    TURNS.delete(key);
  }
  TURNS.set(key, { events: [], nextId: 0, done: false, subscribers: new Set() });
  return true;
}

/** Whether a turn is currently active (streaming) for the key. */
export function hasActiveTurn(key: string): boolean {
  const t = TURNS.get(key);
  return !!t && !t.done;
}

/** Record one event; broadcasts to attached subscribers. Returns its id. */
export function recordEvent(key: string, event: string, data: unknown): number {
  const t = TURNS.get(key);
  if (!t) return -1; // turn not buffered (e.g. no chatId) — fine
  const buffered: BufferedEvent = { id: t.nextId++, event, data };
  t.events.push(buffered);
  const chunk = `id: ${buffered.id}\nevent: ${buffered.event}\ndata: ${JSON.stringify(buffered.data)}\n\n`;
  for (const sub of t.subscribers) {
    try {
      sub.write(chunk);
    } catch {
      t.subscribers.delete(sub);
    }
  }
  return buffered.id;
}

/**
 * Attach a subscriber to a turn: replays every buffered event with
 * id > since (the full turn when since < 0), then live events. Returns a
 * detach function. Throws Error('turn not found') when nothing is buffered.
 */
export function attachSubscriber(
  key: string,
  since: number,
  sub: { write: (chunk: string) => void; end: () => void },
): { detach: () => void; done: boolean } {
  const t = TURNS.get(key);
  if (!t) throw new Error('turn not found');

  for (const ev of t.events) {
    if (ev.id > since) {
      sub.write(`id: ${ev.id}\nevent: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    }
  }
  if (t.done) {
    sub.end();
    return { detach: () => {}, done: true };
  }
  t.subscribers.add(sub);
  return {
    detach: () => t.subscribers.delete(sub),
    done: false,
  };
}

/** Number of buffered events (diagnostics/tests). */
export function bufferedCount(key: string): number {
  return TURNS.get(key)?.events.length ?? 0;
}

/**
 * Mark the turn ended: subscribers were already flushed by the terminal
 * event's recordEvent — close them. The buffer lingers for GRACE_MS so a
 * client reconnecting right after the end still catches the `done`.
 */
export function endTurn(key: string): void {
  const t = TURNS.get(key);
  if (!t) return;
  t.done = true;
  for (const sub of t.subscribers) {
    try {
      sub.end();
    } catch {
      /* already closed */
    }
  }
  t.subscribers.clear();
  t.ttl = setTimeout(() => {
    TURNS.delete(key);
  }, GRACE_MS);
}
