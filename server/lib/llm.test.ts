import { describe, it, expect, vi, afterEach } from 'vitest';
import { chatCompletionStream } from './llm.js';

// Kill the real fs read in getSettings(): under fake timers the I/O macrotask
// never completes during timer draining, so the chain would stall before the
// first fetch. A resolved mock keeps everything on microtasks.
vi.mock('../settings.js', () => ({
  getSettings: vi.fn().mockResolvedValue({ model: 'test-model' }),
}));

// Mirror the constant used inside llm.ts so our mock fetch can route correctly.
const V1_URL = 'http://127.0.0.1:3003/api/v1/chat/completions';

/**
 * Create a mock fetch that returns a streaming Response for the Z.ai endpoint.
 * Each raw string in `chunks` is written to the stream with `delayMs` between
 * writes. When the AbortSignal fires, the stream is errored immediately.
 */
function createMockFetch(chunks: string[], delayMs: number) {
  return async (url: string | URL | Request, opts?: RequestInit) => {
    // Routed streaming endpoint
    const signal = opts?.signal as AbortSignal | undefined;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let i = 0;
        let timer: ReturnType<typeof setTimeout>;

        const pushNext = () => {
          if (i >= chunks.length) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(chunks[i++]));
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

/** Build a Z.ai SSE data line carrying a content delta. */
function contentDelta(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

describe('chatCompletionStream — retry with backoff', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks(); // restores the Math.random spy
  });

  /** A 429 response in the shape Z.ai actually returns (code 1302). */
  function rateLimitResponse(): Response {
    return new Response(
      JSON.stringify({ error: { code: '1302', message: 'Rate limit reached for requests' } }),
      { status: 429, statusText: 'Too Many Requests' },
    );
  }

  // -------------------------------------------------------------------------
  // Test 4: A 429 is retried with backoff and succeeds once it clears.
  // -------------------------------------------------------------------------
  it('retries a 429 and succeeds once the rate limit clears', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0); // deterministic backoff: 0.7 × 1s

    let zaiCalls = 0;
    const success = createMockFetch([contentDelta('Hello'), 'data: [DONE]\n\n'], 0);
    const fetchMock = vi.fn(async (url: string | URL | Request, opts?: RequestInit) => {
      return ++zaiCalls === 1 ? rateLimitResponse() : success(url, opts);
    });
    vi.stubGlobal('fetch', fetchMock);

    const promise = chatCompletionStream([{ role: 'user', content: 'hi' }], undefined, () => {});
    // Yield until the first 429 lands and the backoff sleep is scheduled…
    await vi.advanceTimersByTimeAsync(0);
    // …then fire the 700ms backoff (Math.random()=0 → 0.7 × 1s) and drain the
    // retry's recursive 0ms stream timers.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.content).toBe('Hello');
    expect(zaiCalls).toBe(2); // initial 429 + one retry
  });

  // -------------------------------------------------------------------------
  // Test 5: Retries are exhausted → original HTTP error surfaces, 4 calls.
  // -------------------------------------------------------------------------
  it('gives up after 3 retries and throws the HTTP error', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const fetchMock = vi.fn(async () => {
      return rateLimitResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    const promise = chatCompletionStream([{ role: 'user', content: 'hi' }], undefined, () => {});
    promise.catch(() => {}); // mark handled — rejection may fire before the await below
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow('Inference request failed (429)');

    expect(fetchMock.mock.calls.filter((c) => c[0] === V1_URL)).toHaveLength(4);
  });

  // -------------------------------------------------------------------------
  // Test 6: Abort during the backoff wait stops retrying immediately.
  // -------------------------------------------------------------------------
  it('stops retrying when the signal aborts during backoff', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const ac = new AbortController();

    const fetchMock = vi.fn(async () => {
      return rateLimitResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    const promise = chatCompletionStream(
      [{ role: 'user', content: 'hi' }],
      undefined,
      () => {},
      ac.signal,
    );
    promise.catch(() => {}); // mark handled — rejection may fire before the await below
    // Let the first 429 land and the backoff sleep get scheduled.
    await vi.advanceTimersByTimeAsync(0);
    ac.abort();
    await vi.runAllTimersAsync();

    let err: unknown;
    try {
      await promise;
    } catch (e) {
      err = e;
    }
    expect((err as { name?: string }).name).toBe('AbortError');
    expect(fetchMock.mock.calls.filter((c) => c[0] === V1_URL)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Test 7: Non-transient errors (4xx other than 429) fail immediately.
  // -------------------------------------------------------------------------
  it('does not retry a 400', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr !== V1_URL) return new Response('{}', { status: 200 });
      return new Response('{"error":{"message":"bad request"}}', { status: 400 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chatCompletionStream([{ role: 'user', content: 'hi' }], undefined, () => {}),
    ).rejects.toThrow('Inference request failed (400)');

    expect(fetchMock.mock.calls.filter((c) => c[0] === V1_URL)).toHaveLength(1);
  });
});

describe('chatCompletionStream — abort behavior', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Test 1: AbortSignal is forwarded to the upstream Z.ai fetch.
  // -------------------------------------------------------------------------
  it('passes AbortSignal to the upstream fetch call', async () => {
    const ac = new AbortController();
    const fetchMock = vi.fn(createMockFetch(['data: [DONE]\n\n'], 0));

    vi.stubGlobal('fetch', fetchMock);

    await chatCompletionStream(
      [{ role: 'user', content: 'test' }],
      undefined,
      () => {},
      ac.signal,
    );

    const v1Call = fetchMock.mock.calls.find((c) => c[0] === V1_URL);
    expect(v1Call).toBeDefined();
    expect((v1Call![1] as RequestInit).signal).toBe(ac.signal);
    // The dispatcher (undici Agent with bodyTimeout disabled) must be forwarded
    // — without it, undici's default 300s idle timeout kills long thinking pauses.
    expect((v1Call![1] as RequestInit & { dispatcher?: unknown }).dispatcher).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test 2: Content received before abort is preserved via onDelta; the
  // function throws after abort (no content lost).
  // -------------------------------------------------------------------------
  it('stops streaming when signal aborts and preserves content received so far', async () => {
    const ac = new AbortController();
    const receivedDeltas: string[] = [];

    const chunks = [
      contentDelta('Hello'),
      contentDelta(' world'),
      contentDelta(' preserved'),
      contentDelta(' lost'),
      contentDelta(' also lost'),
      'data: [DONE]\n\n',
    ];

    vi.stubGlobal('fetch', vi.fn(createMockFetch(chunks, 100)));

    let threw = false;
    try {
      await chatCompletionStream(
        [{ role: 'user', content: 'test' }],
        undefined,
        (delta) => {
          receivedDeltas.push(delta);
          // After 2nd delta, abort. The 3rd chunk arrives 100ms later — long
          // after the abort has errored the stream.
          if (receivedDeltas.length === 2) {
            setTimeout(() => ac.abort(), 0);
          }
        },
        ac.signal,
      );
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    // The 2 deltas received before abort are preserved.
    expect(receivedDeltas).toHaveLength(2);
    expect(receivedDeltas[0]).toBe('Hello');
    expect(receivedDeltas[1]).toBe(' world');
  });

  // -------------------------------------------------------------------------
  // Test 3: Normal completion (no abort) returns full content.
  // -------------------------------------------------------------------------
  it('completes normally and returns full content when not aborted', async () => {
    const chunks = [
      contentDelta('Hello'),
      contentDelta(' world'),
      contentDelta('!'),
      'data: [DONE]\n\n',
    ];

    vi.stubGlobal('fetch', vi.fn(createMockFetch(chunks, 10)));

    const result = await chatCompletionStream(
      [{ role: 'user', content: 'hi' }],
      undefined,
      () => {},
    );

    expect(result.content).toBe('Hello world!');
    expect(result.tool_calls).toBeUndefined();
  });
});
