/**
 * Multi-provider web search with automatic fallback.
 *
 * Tries providers in preference order: exa → tavily → tinyfish → serper.
 * Each provider needs its own API key env var. Providers without a key are
 * skipped silently; providers that error at runtime fall through to the next.
 */

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

interface Provider {
  name: string;
  /** Returns the API key, or empty string if not configured. */
  key: () => string;
  search: (query: string, numResults: number, key: string) => Promise<SearchResult[]>;
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

// --- Exa ---------------------------------------------------------------------

async function searchExa(query: string, numResults: number, key: string): Promise<SearchResult[]> {
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
  return (data.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: (r.text ?? '').slice(0, 300),
    content: r.text,
  }));
}

// --- Tavily ------------------------------------------------------------------

async function searchTavily(query: string, numResults: number, key: string): Promise<SearchResult[]> {
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
  return (data.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: (r.content ?? '').slice(0, 300),
  }));
}

// --- TinyFish ----------------------------------------------------------------

async function searchTinyfish(query: string, numResults: number, key: string): Promise<SearchResult[]> {
  const url = new URL('https://api.search.tinyfish.ai');
  url.searchParams.set('query', query);
  const res = await fetch(url, {
    headers: { 'X-API-Key': key },
  });
  if (!res.ok) throw new Error(`tinyfish HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as RawSearchResponse;
  return (data.results ?? []).slice(0, numResults).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.snippet ?? '',
  }));
}

// --- Serper ------------------------------------------------------------------

async function searchSerper(query: string, numResults: number, key: string): Promise<SearchResult[]> {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: numResults }),
  });
  if (!res.ok) throw new Error(`serper HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as RawSearchResponse;
  return (data.organic ?? []).slice(0, numResults).map((r) => ({
    title: r.title ?? '',
    url: r.link ?? '',
    snippet: r.snippet ?? '',
  }));
}

// --- Dispatch ----------------------------------------------------------------

const PROVIDERS: Provider[] = [
  { name: 'exa', key: () => process.env.EXA_API_KEY || '', search: searchExa },
  { name: 'tavily', key: () => process.env.TAVILY_API_KEY || '', search: searchTavily },
  { name: 'tinyfish', key: () => process.env.TINYFISH_API_KEY || '', search: searchTinyfish },
  { name: 'serper', key: () => process.env.SERPER_API_KEY || '', search: searchSerper },
];

/** Run a web search, trying providers in preference order until one succeeds. */
export async function webSearch(query: string, numResults = 5): Promise<WebSearchResult> {
  const errors: string[] = [];

  for (const p of PROVIDERS) {
    const key = p.key();
    if (!key) continue;
    try {
      const results = await p.search(query, Math.min(numResults, 10), key);
      return { query, provider: p.name, results };
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
      'No search provider available or all failed. Set at least one of: ' +
      'EXA_API_KEY, TAVILY_API_KEY, TINYFISH_API_KEY, SERPER_API_KEY. ' +
      (errors.length ? `Details: ${errors.join('; ')}` : ''),
  } as WebSearchResult & { error: string };
}
