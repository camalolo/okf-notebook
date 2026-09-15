/**
 * Built-in `web_fetch` tool: fetch a web page by URL and return its readable
 * text (HTML stripped). Complements `web_search` — search finds candidate
 * sources, fetch reads the actual page so facts can be verified against the
 * source content instead of a search snippet.
 *
 * Two paths, in preference order:
 *
 *   1. Scrape proxy (search-proxy.ts — the inference proxy's /api/scrape).
 *      Handles JS-heavy and bot-protected pages server-side via provider
 *      failover. Any failure (proxy down, rate-limited, all providers
 *      failed) falls through to path 2.
 *   2. Direct hardened fetch (below).
 *
 * Safety: the URL comes from the LLM, so the SSRF guard runs *before* either
 * path — we don't ask the proxy to fetch internal addresses either:
 *   - only http(s), no embedded credentials;
 *   - DNS is resolved up front and every resolved address must be public
 *     (loopback, RFC1918, CGNAT, link-local, unique-local IPv6 refused).
 * On the direct path, redirects are additionally followed manually with the
 * same validation per hop (max 5), so a public URL can't bounce to an
 * internal address; download is capped (2 MB) and response text capped
 * (20k chars) so one page can't flood the chat context. The proxy applies
 * its own caps server-side; the 20k char cap is enforced here regardless.
 *
 * Residual risk (documented, accepted): the DNS lookup and the actual
 * connection are separate resolutions (TOCTOU rebinding), and on the proxy
 * path redirect targets are validated by the proxy, not here. Both accepted
 * for a trusted-user app on a trusted LAN.
 */

import { lookup } from 'node:dns/promises';

import { proxyScrape } from './search-proxy.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_DOWNLOAD_BYTES = 2_000_000;
const MAX_CONTENT_CHARS = 20_000;
const MAX_REDIRECTS = 5;

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Notebook/1.0';

// --- SSRF guards ------------------------------------------------------------

/** True for addresses that must never be fetched: loopback, private, link-local, CGNAT, unspecified. */
export function isPrivateIp(address: string): boolean {
  const a = address.toLowerCase().replace(/%.*$/, ''); // strip zone id (fe80::1%eth0)

  if (a.includes(':')) {
    // IPv6 — check IPv4-mapped forms first (::ffff:10.0.0.1).
    const mapped = a.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPrivateIp(mapped[1]);
    if (a === '::' || a === '::1') return true;
    const first = a.split(':')[0];
    if (/^f[cd]/.test(first)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(first)) return true; // fe80::/10 link-local
    return false;
  }

  const parts = a.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // malformed — refuse rather than risk it
  }
  const [o1, o2] = parts;
  if (o1 === 0 || o1 === 10 || o1 === 127) return true; // this-network, private, loopback
  if (o1 === 169 && o2 === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true; // private
  if (o1 === 192 && o2 === 168) return true; // private
  if (o1 === 100 && o2 >= 64 && o2 <= 127) return true; // CGNAT
  return false;
}

/**
 * Validate an LLM-supplied URL and resolve its host: http(s) only, no
 * credentials, and every resolved address must be public. Throws with a
 * model-readable message otherwise. Returns the parsed URL.
 */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs are allowed, got "${url.protocol}"`);
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }
  let addrs: { address: string }[];
  try {
    // URL.hostname keeps brackets on IPv6 literals — dns.lookup wants them bare.
    addrs = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  } catch {
    throw new Error(`Cannot resolve host: ${url.hostname}`);
  }
  if (addrs.length === 0) throw new Error(`Cannot resolve host: ${url.hostname}`);
  const blocked = addrs.find((a) => isPrivateIp(a.address));
  if (blocked) {
    throw new Error(
      `Refusing to fetch non-public address ${blocked.address} — internal network access is blocked.`,
    );
  }
  return url;
}

// --- HTML → text ------------------------------------------------------------

/** Strip HTML down to readable plain text (no dependencies). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|table|ul|ol|dl|dd|dt|figcaption)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0*39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(Number(d)))
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function safeCodePoint(cp: number): string {
  return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
}

// --- Fetch ------------------------------------------------------------------

export interface WebFetchResult {
  url: string;
  finalUrl?: string;
  status?: number;
  /** Page title, when the scrape proxy reported one. */
  title?: string;
  content?: string;
  /** Bytes downloaded (may exceed the returned text length; direct path only). */
  contentLength?: number;
  /** True when the download or the returned text was cut short by a cap. */
  truncated?: boolean;
  /** Upstream provider that served the scrape (proxy path only). */
  provider?: string;
  error?: string;
}

/**
 * Fetch a public web page and return readable text: scrape proxy first
 * (JS-heavy/bot-protected pages, provider failover server-side), direct
 * hardened fetch as fallback. Never throws — errors land in the returned
 * `{ error }` so the calling agent can react to them.
 */
export async function webFetch(rawUrl: string): Promise<WebFetchResult> {
  // SSRF guard gates both paths — we don't ask the proxy to fetch internal
  // addresses either.
  try {
    await assertSafeUrl(rawUrl);
  } catch (err) {
    return { url: rawUrl, error: err instanceof Error ? err.message : String(err) };
  }

  // Preferred: scrape proxy. An empty-but-successful scrape also falls
  // through — the direct fetch may still get the page.
  try {
    const scraped = await proxyScrape(rawUrl);
    if (scraped.content) {
      const truncated = scraped.content.length > MAX_CONTENT_CHARS;
      return {
        url: rawUrl,
        finalUrl: scraped.url || rawUrl,
        title: scraped.title,
        content: scraped.content.slice(0, MAX_CONTENT_CHARS),
        truncated: truncated || undefined,
        provider: scraped.provider,
      };
    }
  } catch {
    // Proxy unavailable / rate-limited / all its providers failed → direct fetch.
  }

  return directFetch(rawUrl);
}

/** Direct fetch with per-hop SSRF validation. The pre-proxy fallback path. */
async function directFetch(rawUrl: string): Promise<WebFetchResult> {
  try {
    let url = await assertSafeUrl(rawUrl);
    let res: Response;

    for (let hops = 0; ; hops++) {
      res = await fetch(url, {
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (hops >= MAX_REDIRECTS) return { url: rawUrl, error: 'Too many redirects' };
        const next = await assertSafeUrl(new URL(res.headers.get('location')!, url).toString());
        void res.body?.cancel().catch(() => {});
        url = next;
        continue;
      }
      break;
    }

    if (!res.ok) {
      return { url: rawUrl, finalUrl: url.toString(), status: res.status, error: `HTTP ${res.status} for ${url}` };
    }

    const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
    const fetchable =
      ctype.includes('text/') || ctype.includes('json') || ctype.includes('xml') || ctype.includes('javascript');
    if (ctype && !fetchable) {
      return {
        url: rawUrl,
        finalUrl: url.toString(),
        status: res.status,
        error: `Unsupported content-type "${ctype.split(';')[0]}" — only text pages can be fetched (PDF/images are not supported).`,
      };
    }

    // Bounded read: stop pulling once the byte cap is hit.
    const reader = res.body?.getReader();
    if (!reader) return { url: rawUrl, error: 'Empty response body' };
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let bytes = 0;
    let raw = '';
    let downloadTruncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      raw += decoder.decode(value, { stream: true });
      if (bytes >= MAX_DOWNLOAD_BYTES) {
        downloadTruncated = true;
        void reader.cancel().catch(() => {});
        break;
      }
    }
    raw += decoder.decode();

    const content = ctype.includes('html') || ctype.includes('xml') ? htmlToText(raw) : raw.trim();
    const truncated = downloadTruncated || content.length > MAX_CONTENT_CHARS;
    return {
      url: rawUrl,
      finalUrl: url.toString(),
      status: res.status,
      contentLength: bytes,
      content: content.slice(0, MAX_CONTENT_CHARS),
      truncated: truncated || undefined,
    };
  } catch (err) {
    return { url: rawUrl, error: err instanceof Error ? err.message : String(err) };
  }
}
