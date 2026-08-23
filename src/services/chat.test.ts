import { describe, it, expect, vi, afterEach } from 'vitest';
import { streamChat } from './chat.ts';
import type { ChatMessage } from '../types.ts';

/** A mock SSE event to feed into the fake server response. */
interface MockSSEEvent {
  event: string;
  data: unknown;
}

/** Build the raw SSE wire bytes for one event block. */
function sseBlock(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Create a mock fetch that returns a Response whose body streams SSE events
 * with a configurable delay between each. When the AbortSignal fires, the
 * stream is errored immediately — mirroring real browser fetch-abort behavior.
 */
function createDelayedSSEFetch(events: MockSSEEvent[], delayMs: number) {
  return async (_url: string, opts: RequestInit) => {
    const signal = opts.signal as AbortSignal | undefined;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let i = 0;
        let timer: ReturnType<typeof setTimeout>;

        const pushNext = () => {
          if (i >= events.length) {
            controller.close();
            return;
          }
          const ev = events[i++];
          controller.enqueue(encoder.encode(sseBlock(ev.event, ev.data)));
          timer = setTimeout(pushNext, delayMs);
        };

        pushNext();

        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          controller.error(new DOMException('Aborted', 'AbortError'));
        });
      },
    });

    return new Response(stream, { status: 200, statusText: 'OK' });
  };
}

describe('streamChat — abort behavior', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Test 1: Core guarantee — events received before abort are preserved.
  // -------------------------------------------------------------------------
  it('preserves events received before abort and discards the rest', async () => {
    const events: MockSSEEvent[] = [
      { event: 'content', data: { text: 'Hello' } },
      { event: 'content', data: { text: ' world' } },
      { event: 'tool_call', data: { name: 'read_file', args: {}, result: 'data' } },
      { event: 'content', data: { text: 'should-not-receive' } },
      { event: 'content', data: { text: 'nor-this' } },
      { event: 'done', data: {} },
    ];

    vi.stubGlobal('fetch', vi.fn(createDelayedSSEFetch(events, 100)));

    const controller = new AbortController();
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    const received: MockSSEEvent[] = [];

    try {
      for await (const ev of streamChat('test-bundle', messages, null, controller.signal)) {
        received.push({ event: ev.event, data: ev.data });
        if (received.length === 3) {
          controller.abort();
        }
      }
    } catch {
      // AbortError — expected
    }

    expect(received).toHaveLength(3);
    expect(received[0].event).toBe('content');
    expect((received[0].data as { text: string }).text).toBe('Hello');
    expect(received[1].event).toBe('content');
    expect((received[1].data as { text: string }).text).toBe(' world');
    expect(received[2].event).toBe('tool_call');
    expect((received[2].data as { name: string }).name).toBe('read_file');
  });

  // -------------------------------------------------------------------------
  // Test 2: The AbortSignal is actually passed through to fetch.
  // -------------------------------------------------------------------------
  it('passes AbortSignal to fetch', async () => {
    const fetchMock = vi.fn(
      createDelayedSSEFetch([{ event: 'done', data: {} }], 0),
    );
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();

    try {
      // Consume just enough of the stream to trigger the fetch, then stop.
      const stream = streamChat('b', [{ role: 'user', content: 'x' }], null, controller.signal);
      await stream.next();
      await stream.return?.(undefined);
    } catch {
      // ignore
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const opts = fetchMock.mock.calls[0][1] as RequestInit;
    expect(opts.signal).toBe(controller.signal);
  });

  // -------------------------------------------------------------------------
  // Test 3: Without abort, all events arrive normally.
  // -------------------------------------------------------------------------
  it('completes normally and yields all events when not aborted', async () => {
    const events: MockSSEEvent[] = [
      { event: 'content', data: { text: 'Hi' } },
      { event: 'tool_call', data: { name: 'list_files', args: {}, result: [] } },
      { event: 'done', data: {} },
    ];

    vi.stubGlobal('fetch', vi.fn(createDelayedSSEFetch(events, 10)));

    const received: MockSSEEvent[] = [];
    for await (const ev of streamChat('b', [{ role: 'user', content: 'x' }])) {
      received.push({ event: ev.event, data: ev.data });
    }

    expect(received).toHaveLength(3);
    expect(received[2].event).toBe('done');
  });

  // -------------------------------------------------------------------------
  // Test 4: The generator terminates promptly after abort (no hang).
  // -------------------------------------------------------------------------
  it('terminates within 1 second after abort even with long delays', async () => {
    const events: MockSSEEvent[] = [
      { event: 'content', data: { text: 'first' } },
      { event: 'content', data: { text: 'second' } },
      { event: 'content', data: { text: 'third' } },
    ];

    // 2-second delay between events — if abort doesn't work, the test
    // would need 4+ seconds to complete (or hang until timeout).
    vi.stubGlobal('fetch', vi.fn(createDelayedSSEFetch(events, 2000)));

    const controller = new AbortController();
    const start = Date.now();

    try {
      for await (const ev of streamChat('b', [{ role: 'user', content: 'x' }], null, controller.signal)) {
        if ((ev.data as { text?: string }).text === 'first') {
          controller.abort();
        }
      }
    } catch {
      // expected
    }

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });

  // -------------------------------------------------------------------------
  // Test 5: `retry` events (server retrying a transient upstream failure)
  // are yielded like any other event so the UI can show an indication.
  // -------------------------------------------------------------------------
  it('yields retry events with their payload', async () => {
    const events: MockSSEEvent[] = [
      { event: 'content', data: { text: 'partial answer…' } },
      { event: 'retry', data: { attempt: 1, maxAttempts: 4, reason: 'TypeError: terminated', waitMs: 2000 } },
      { event: 'content', data: { text: 'full answer' } },
      { event: 'done', data: {} },
    ];

    vi.stubGlobal('fetch', vi.fn(createDelayedSSEFetch(events, 5)));

    const received: MockSSEEvent[] = [];
    for await (const ev of streamChat('b', [{ role: 'user', content: 'x' }])) {
      received.push({ event: ev.event, data: ev.data });
    }

    expect(received).toHaveLength(4);
    const retry = received[1];
    expect(retry.event).toBe('retry');
    expect(retry.data).toEqual({
      attempt: 1,
      maxAttempts: 4,
      reason: 'TypeError: terminated',
      waitMs: 2000,
    });
    expect(received[3].event).toBe('done');
  });
});

describe('parseEvent — SSE id field (reconnect cursor)', () => {
  // parseEvent is module-private; verify ids surface through streamChat's
  // yielded events by feeding id-annotated blocks through the mock stream.
  it('yields the numeric id from id: lines', async () => {
    const wire =
      `id: 7\nevent: content\ndata: ${JSON.stringify({ text: 'hi' })}\n\n` +
      `event: done\ndata: {}\n\n`;
    const fetchMock = vi.fn(async () => new Response(wire, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const seen: Array<number | undefined> = [];
    for await (const ev of streamChat('b', [{ role: 'user', content: 'x' }], null)) {
      seen.push(ev.id);
    }
    expect(seen[0]).toBe(7);
    expect(seen[1]).toBeUndefined(); // events without id: carry none
  });
});
