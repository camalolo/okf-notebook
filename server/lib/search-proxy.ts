/**
 * Client for the inference proxy's search/scrape API — the same local proxy
 * that serves the OpenAI-compatible LLM endpoint (see llm.ts). One request in,
 * one normalized response out; provider failover happens server-side.
 *
 *   GET /api/search?q=<query>&limit=<1-20>
 *     → { results: [{title, url, snippet}], query, provider }
 *   GET /api/scrape?url=<https-url>&format=json
 *     → { url, title, content, provider }
 *
 * Errors: 400 bad request · 429 rate limited (Retry-After) · 502 all
 * providers failed · 503 scrape disabled. Callers treat any failure as
 * "proxy unavailable" and fall through (web-search to the next provider,
 * web-fetch to the direct hardened fetch).
 *
 * Configuration (env vars):
 *   SEARCH_PROXY_URL  Proxy root (e.g. http://127.0.0.1:3003). Defaults to
 *                     LLM_BASE_URL with its version segment stripped
 *                     (…/api/v1 → root), so the zero-config setup points at
 *                     the same host as the LLM calls.
 *   SEARCH_API_KEY    Bearer key (`Authorization: Bearer ik-…`). Defaults to
 *                     LLM_API_KEY (legacy: INFERENCE_API_KEY) — same proxy,
 *                     same key. Unset is fine: requests from the LAN skip
 *                     auth.
 *
 * The scrape `depth` parameter is left at its `auto` default — the proxy's
 * own tip: only pin `advanced`/`basic` when you already know the page type.
 */

const DEFAULT_LLM_BASE_URL = 'http://127.0.0.1:3003/api/v1';

const PROXY_TIMEOUT_MS = 30_000; // scrape may fail over between providers server-side
const RETRY_AFTER_CAP_MS = 5_000; // a chat tool call must not stall on a long rate limit

/**
 * Root of the search/scrape proxy (no trailing slash): SEARCH_PROXY_URL when
 * set, else LLM_BASE_URL minus its version segment (`/v1`, `/api/v1`,
 * `/api/paas/v4`, …).
 */
export function searchProxyBase(): string {
  const override = process.env.SEARCH_PROXY_URL?.replace(/\/+$/, '');
  if (override) return override;
  const llmBase = (process.env.LLM_BASE_URL || DEFAULT_LLM_BASE_URL).replace(/\/+$/, '');
  return llmBase.replace(/\/(api\/)?v\d+$/, '');
}

/** Bearer key for the proxy: SEARCH_API_KEY, else the LLM key; LAN needs none. */
function authHeaders(): Record<string, string> {
  const key = process.env.SEARCH_API_KEY || process.env.LLM_API_KEY || process.env.INFERENCE_API_KEY || '';
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GET {proxy}{path}?<params> with auth and a timeout. Honors a single 429
 * `Retry-After` (capped — past the cap the caller is better served by its
 * own fallback than by waiting).
 */
async function proxyApiGet(
  path: string,
  params: Record<string, string>,
  timeoutMs = PROXY_TIMEOUT_MS,
): Promise<Response> {
  const url = new URL(path, searchProxyBase());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers = authHeaders();

  let res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 429) {
    const secs = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, RETRY_AFTER_CAP_MS) : 0;
    void res.body?.cancel().catch(() => {});
    if (waitMs > 0) await sleep(waitMs);
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  }
  return res;
}

async function errorFrom(res: Response, what: string): Promise<Error> {
  const text = await res.text().catch(() => '');
  return new Error(`search proxy ${what} HTTP ${res.status}: ${text.slice(0, 200)}`);
}

// --- Search ------------------------------------------------------------------

export interface ProxySearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface ProxySearchResponse {
  /** Echoed query (per the API spec; may differ in normalization). */
  query: string;
  /** Upstream provider the proxy's failover picked (exa, tavily, …). */
  provider: string;
  results: ProxySearchHit[];
}

/** Search via the proxy. Throws on any failure — the caller falls through. */
export async function proxySearch(query: string, limit: number): Promise<ProxySearchResponse> {
  const res = await proxyApiGet('/api/search', {
    q: query,
    limit: String(Math.min(Math.max(1, Math.round(limit)), 20)),
  });
  if (!res.ok) throw await errorFrom(res, 'search');

  const data = (await res.json()) as {
    query?: string;
    provider?: string;
    results?: { title?: string; url?: string; snippet?: string }[];
  };
  return {
    query: data.query ?? query,
    provider: data.provider ?? 'proxy',
    results: (data.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.snippet ?? '',
    })),
  };
}

// --- Scrape ------------------------------------------------------------------

export interface ProxyScrapeResult {
  /** Final URL (redirects resolved server-side), when reported. */
  url?: string;
  title?: string;
  content: string;
  /** Upstream scrape provider the proxy's failover picked. */
  provider?: string;
}

/**
 * Scrape a page to readable text via the proxy (`format=json`, `depth=auto`).
 * Throws on any failure — web-fetch then falls back to its direct fetch.
 */
export async function proxyScrape(url: string): Promise<ProxyScrapeResult> {
  const res = await proxyApiGet('/api/scrape', { url, format: 'json' });
  if (!res.ok) throw await errorFrom(res, 'scrape');

  const data = (await res.json()) as {
    url?: string;
    title?: string;
    content?: string;
    provider?: string;
  };
  return {
    url: data.url,
    title: data.title,
    content: String(data.content ?? ''),
    provider: data.provider,
  };
}
