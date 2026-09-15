/**
 * Tests for the web_search provider chain: the search proxy is tried first
 * (no key needed, works from the LAN) and its upstream provider is surfaced
 * in the result label; keyed direct providers are the fallback. No network —
 * fetch is stubbed and dispatches on URL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webSearch } from './web-search.js';

const ENV_KEYS = [
  'LLM_BASE_URL',
  'SEARCH_PROXY_URL',
  'SEARCH_API_KEY',
  'LLM_API_KEY',
  'INFERENCE_API_KEY',
  'EXA_API_KEY',
  'TAVILY_API_KEY',
  'TINYFISH_API_KEY',
  'SERPER_API_KEY',
] as const;

const savedEnv = new Map<string, string | undefined>();
beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);
  delete process.env.SEARCH_PROXY_URL;
  process.env.LLM_BASE_URL = 'http://127.0.0.1:3003/api/v1';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('webSearch', () => {
  it('prefers the proxy provider and labels it with the upstream provider', async () => {
    process.env.EXA_API_KEY = 'exa-key'; // configured but must NOT be used
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:3003/api/search')) {
        return jsonResponse({ query: 'q', provider: 'tavily', results: [{ title: 'T', url: 'u', snippet: 's' }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await webSearch('q', 5);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.provider).toBe('proxy:tavily');
    expect(out.results).toEqual([{ title: 'T', url: 'u', snippet: 's' }]);
  });

  it('falls through to keyed providers when the proxy fails', async () => {
    process.env.EXA_API_KEY = 'exa-key';
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:3003/api/search')) return jsonResponse({ error: 'down' }, 502);
      if (url.startsWith('https://api.exa.ai/search')) {
        return jsonResponse({ results: [{ title: 'E', url: 'u', text: 'text' }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await webSearch('q', 5);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.provider).toBe('exa');
    expect(out.results[0]?.title).toBe('E');
    expect(out.results[0]?.content).toBe('text');
  });

  it('reports the proxy attempt in the error when everything fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'all providers failed' }, 502));
    vi.stubGlobal('fetch', fetchMock);

    const out = await webSearch('q', 5);

    expect(out.provider).toBe('none');
    expect(out.results).toEqual([]);
    const err = (out as { error?: string }).error ?? '';
    expect(err).toContain('proxy');
    expect(err).toContain('proxy: search proxy search HTTP 502');
  });
});
