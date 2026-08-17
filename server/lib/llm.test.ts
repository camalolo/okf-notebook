import { describe, it, expect, vi, afterEach } from 'vitest';
import { chatCompletionStream } from './llm.js';

// Mirror the constants used inside llm.ts so our mock fetch can route correctly.
const TOKEN_URL = 'http://127.0.0.1:3003/api/token';
const ZAI_URL = 'http://127.0.0.1:3003/api/zai';

/** A valid far-future token response body. */
function tokenBody(): string {
  return JSON.stringify({
    token: 'test-token',
    expires: Math.floor(Date.now() / 1000) + 3600,
  });
}

/**
 * Create a mock fetch that returns a streaming Response for the Z.ai endpoint.
 * Each raw string in `chunks` is written to the stream with `delayMs` between
 * writes. When the AbortSignal fires, the stream is errored immediately.
 */
function createMockFetch(chunks: string[], delayMs: number, ac?: AbortController) {
  return async (url: string | URL | Request, opts?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr === TOKEN_URL) {
      return new Response(tokenBody(), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ZAI streaming endpoint
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

    // Find the ZAI call (not the token call)
    const zaiCall = fetchMock.mock.calls.find((c) => c[0] === ZAI_URL);
    expect(zaiCall).toBeDefined();
    expect((zaiCall![1] as RequestInit).signal).toBe(ac.signal);
    // The dispatcher (undici Agent with bodyTimeout disabled) must be forwarded
    // — without it, undici's default 300s idle timeout kills long thinking pauses.
    expect((zaiCall![1] as RequestInit & { dispatcher?: unknown }).dispatcher).toBeDefined();
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

    vi.stubGlobal('fetch', vi.fn(createMockFetch(chunks, 100, ac)));

    let threw = false;
    let errorMsg = '';
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
    } catch (err) {
      threw = true;
      errorMsg = err instanceof Error ? err.message : String(err);
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
