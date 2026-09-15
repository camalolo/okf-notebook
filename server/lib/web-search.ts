/**
 * Multi-provider web search with automatic fallback.
 *
 * Tries providers in preference order: inference proxy → exa → tavily →
 * tinyfish → serper. The proxy (same host as the LLM endpoint, see
 * search-proxy.ts) needs no key on the LAN and does its own provider
 * failover server-side, so it works with zero configuration; the direct
 * providers each need their own API key env var. Providers without a key are
 * skipped silently; providers that error at runtime fall through to the next.
 */

import { proxySearch } from './search-proxy.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Full text content if the provider returned it (exa). */
  content?: string;
}

export interface WebSearchResult {
  query: string;
  provider: string;
  results: SearchResult[];
}

/** What a provider search returns: the hits, plus an optional label refinement. */
interface ProviderOutcome {
  results: SearchResult[];
  /** Refines the reported provider name, e.g. the upstream a proxy picked. */
  upstream?: string;
}

interface Provider {
  name: string;
  /** Returns the API key, or empty string if not configured. Absent = no key needed. */
  key?: () => string;
  search: (query: string, numResults: number, key: string) => Promise<ProviderOutcome>;
}

/** Minimal shape of a provider search response (union of their fields). */
interface RawSearchResponse {
  results?: RawSearchItem[];
  organic?: RawSearchItem[];
}

interface RawSearchItem {
  title?: string;
  url?: string;
  /** Serper names the destination field `link`. */
  link?: string;
  content?: string;
  /** Exa names the text field `text`. */
  text?: string;
  snippet?: string;
}

// --- Inference proxy (default — same host as the LLM API) --------------------

async function searchViaProxy(query: string, numResults: number): Promise<ProviderOutcome> {
  const data = await proxySearch(query, numResults);
  return {
    results: data.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
    upstream: data.provider,
  };
}

// --- Exa ---------------------------------------------------------------------

async function searchExa(query: string, numResults: number, key: string): Promise<ProviderOutcome> {
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({
      query,
      numResults,
      contents: { text: { maxCharacters: 2000 } },
    }),
  });
  if (!res.ok) throw new Error(`exa HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as RawSearchResponse;
  return {
    results: (data.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: (r.text ?? '').slice(0, 300),
      content: r.text,
    })),
  };
}

// --- Tavily ------------------------------------------------------------------

async function searchTavily(query: string, numResults: number, key: string): Promise<ProviderOutcome> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      query,
      max_results: numResults,
      include_answer: false,
    }),
  });
  if (!res.ok) throw new Error(`tavily HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as RawSearchResponse;
  return {
    results: (data.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: (r.content ?? '').slice(0, 300),
    })),
  };
}

// --- TinyFish ----------------------------------------------------------------

async function searchTinyfish(query: string, numResults: number, key: string): Promise<ProviderOutcome> {
  const url = new URL('https://api.search.tinyfish.ai');
  url.searchParams.set('query', query);
  const res = await fetch(url, {
    headers: { 'X-API-Key': key },
  });
  if (!res.ok) throw new Error(`tinyfish HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as RawSearchResponse;
  return {
    results: (data.results ?? []).slice(0, numResults).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.snippet ?? '',
    })),
  };
}

// --- Serper ------------------------------------------------------------------

async function searchSerper(query: string, numResults: number, key: string): Promise<ProviderOutcome> {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: numResults }),
  });
  if (!res.ok) throw new Error(`serper HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as RawSearchResponse;
  return {
    results: (data.organic ?? []).slice(0, numResults).map((r) => ({
      title: r.title ?? '',
      url: r.link ?? '',
      snippet: r.snippet ?? '',
    })),
  };
}

// --- Dispatch ----------------------------------------------------------------

const PROVIDERS: Provider[] = [
  { name: 'proxy', search: searchViaProxy },
  { name: 'exa', key: () => process.env.EXA_API_KEY || '', search: searchExa },
  { name: 'tavily', key: () => process.env.TAVILY_API_KEY || '', search: searchTavily },
  { name: 'tinyfish', key: () => process.env.TINYFISH_API_KEY || '', search: searchTinyfish },
  { name: 'serper', key: () => process.env.SERPER_API_KEY || '', search: searchSerper },
];

/** Run a web search, trying providers in preference order until one succeeds. */
export async function webSearch(query: string, numResults = 5): Promise<WebSearchResult> {
  const errors: string[] = [];

  for (const p of PROVIDERS) {
    const key = p.key?.() ?? '';
    if (p.key && !key) continue;
    try {
      const outcome = await p.search(query, Math.min(numResults, 10), key);
      return { query, provider: outcome.upstream ? `${p.name}:${outcome.upstream}` : p.name, results: outcome.results };
    } catch (err) {
      errors.push(`${p.name}: ${err instanceof Error ? err.message : String(err)}`);
      // Fall through to next provider
    }
  }

  return {
    query,
    provider: 'none',
    results: [],
    error:
      'No search provider available or all failed. The search proxy (' +
      'SEARCH_PROXY_URL / LLM_BASE_URL host) is tried first and needs no key; ' +
      'as fallback set at least one of: EXA_API_KEY, TAVILY_API_KEY, TINYFISH_API_KEY, SERPER_API_KEY. ' +
      (errors.length ? `Details: ${errors.join('; ')}` : ''),
  } as WebSearchResult & { error: string };
}
