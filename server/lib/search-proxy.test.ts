/**
 * Tests for the inference proxy's search/scrape client: base-URL derivation
 * from LLM_BASE_URL (or SEARCH_PROXY_URL), request shapes, auth headers, the
 * single bounded 429 retry, and error propagation. No network — fetch is
 * stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { proxyScrape, proxySearch, searchProxyBase } from './search-proxy.js';

const ENV_KEYS = [
  'LLM_BASE_URL',
  'SEARCH_PROXY_URL',
  'SEARCH_API_KEY',
  'LLM_API_KEY',
  'INFERENCE_API_KEY',
] as const;

// Snapshot once at module load — beforeEach must not capture a previous
// test's pollution.
const savedEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((k) => [k, process.env[k]]),
);
beforeEach(() => {
  delete process.env.LLM_BASE_URL;
  delete process.env.SEARCH_PROXY_URL;
  delete process.env.SEARCH_API_KEY;
  delete process.env.LLM_API_KEY;
  delete process.env.INFERENCE_API_KEY;
});
afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('searchProxyBase', () => {
  it('derives the proxy root from the default LLM_BASE_URL', () => {
    delete process.env.LLM_BASE_URL;
    delete process.env.SEARCH_PROXY_URL;
    expect(searchProxyBase()).toBe('http://127.0.0.1:3003');
  });

  it('strips the version segment from various OpenAI-compatible URL shapes', () => {
    delete process.env.SEARCH_PROXY_URL;
    process.env.LLM_BASE_URL = 'http://127.0.0.1:3003/api/v1';
    expect(searchProxyBase()).toBe('http://127.0.0.1:3003');

    process.env.LLM_BASE_URL = 'https://api.openai.com/v1';
    expect(searchProxyBase()).toBe('https://api.openai.com');

    // Best-effort for exotic shapes: only the version segment is stripped;
    // a proxy living under /api/paas needs SEARCH_PROXY_URL.
    process.env.LLM_BASE_URL = 'https://api.z.ai/api/paas/v4';
    expect(searchProxyBase()).toBe('https://api.z.ai/api/paas');
  });

  it('SEARCH_PROXY_URL overrides the derivation verbatim', () => {
    process.env.LLM_BASE_URL = 'https://api.openai.com/v1';
    process.env.SEARCH_PROXY_URL = 'http://10.0.0.7:9950/';
    expect(searchProxyBase()).toBe('http://10.0.0.7:9950');
  });
});

describe('proxySearch', () => {
  it('GETs /api/search with q + limit and maps results (missing fields tolerated)', async () => {
    delete process.env.SEARCH_PROXY_URL;
    process.env.LLM_BASE_URL = 'http://127.0.0.1:3003/api/v1';
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        query: 'prix bitcoin',
        provider: 'tinyfish',
        results: [{ title: 'BTC', url: 'https://x.example/', snippet: 's' }, { title: 'partial' }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await proxySearch('prix bitcoin', 5);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    // URLSearchParams uses form-urlencoded spacing (+).
    expect(url.toString()).toBe('http://127.0.0.1:3003/api/search?q=prix+bitcoin&limit=5');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined(); // no key → none sent
    expect(out.provider).toBe('tinyfish');
    expect(out.results).toEqual([
      { title: 'BTC', url: 'https://x.example/', snippet: 's' },
      { title: 'partial', url: '', snippet: '' },
    ]);
  });

  it('clamps limit to the API range (1–20) and sends the bearer key when set', async () => {
    process.env.SEARCH_API_KEY = 'ik-test';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await proxySearch('q', 50);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.searchParams.get('limit')).toBe('20');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ik-test');
  });

  it('retries once on 429 honoring Retry-After', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'rate limited' }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ title: 'ok' }], provider: 'exa' }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await proxySearch('q', 5);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.results[0]?.title).toBe('ok');
  });

  it('throws on 502 so the caller can fall through', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'all providers failed' }, 502));
    vi.stubGlobal('fetch', fetchMock);

    await expect(proxySearch('q', 5)).rejects.toThrow(/502/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('proxyScrape', () => {
  it('GETs /api/scrape with url + format=json and maps the fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        url: 'https://example.com/final',
        title: 'Page title',
        content: 'page text',
        provider: 'tavily',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await proxyScrape('https://example.com/page');

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toBe('http://127.0.0.1:3003/api/scrape?url=https%3A%2F%2Fexample.com%2Fpage&format=json');
    expect(out).toEqual({ url: 'https://example.com/final', title: 'Page title', content: 'page text', provider: 'tavily' });
  });

  it('throws on 503 (scrape disabled) so web-fetch can fall back', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'disabled' }, 503));
    vi.stubGlobal('fetch', fetchMock);

    await expect(proxyScrape('https://example.com/')).rejects.toThrow(/503/);
  });
});
