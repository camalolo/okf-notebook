/**
 * Tests for the built-in web_fetch tool's pure boundaries: the SSRF guard
 * (isPrivateIp / assertSafeUrl) and the HTML→text conversion. No network —
 * assertSafeUrl is exercised with IP literals only (numeric hosts resolve
 * locally, no DNS query leaves the machine). The webFetch path tests stub
 * fetch and use SEARCH_PROXY_URL to keep the scrape proxy hermetic too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPrivateIp, assertSafeUrl, htmlToText, webFetch } from './web-fetch.js';

const ENV_KEYS = ['SEARCH_PROXY_URL', 'SEARCH_API_KEY', 'LLM_API_KEY', 'INFERENCE_API_KEY'] as const;
const savedEnv = new Map<string, string | undefined>();
beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);
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

describe('isPrivateIp', () => {
  it('blocks loopback, private, link-local, CGNAT, and this-network IPv4', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('10.1.2.3')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true); // cloud metadata
    expect(isPrivateIp('100.64.0.1')).toBe(true); // CGNAT
    expect(isPrivateIp('0.0.0.0')).toBe(true);
  });

  it('allows public IPv4', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.2.3.4')).toBe(false);
    expect(isPrivateIp('172.32.0.1')).toBe(false); // outside 172.16/12
  });

  it('treats malformed IPv4 as private (refuse rather than risk)', () => {
    expect(isPrivateIp('999.1.1.1')).toBe(true);
    expect(isPrivateIp('not-an-ip')).toBe(true);
  });

  it('blocks loopback, link-local, and unique-local IPv6', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('::')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('febf::a')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd12:3456::1')).toBe(true);
  });

  it('blocks IPv4-mapped private addresses, allows public IPv6', () => {
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:192.168.0.5')).toBe(true);
    expect(isPrivateIp('2606:4700::1111')).toBe(false);
  });
});

describe('assertSafeUrl', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertSafeUrl('ftp://example.com/x')).rejects.toThrow(/http\(s\)/);
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow(/http\(s\)/);
  });

  it('rejects embedded credentials', async () => {
    await expect(assertSafeUrl('http://user:pass@example.com/')).rejects.toThrow(/credentials/);
  });

  it('rejects hosts that resolve to private addresses (IP literals, no network)', async () => {
    await expect(assertSafeUrl('http://127.0.0.1:3003/api')).rejects.toThrow(/non-public/);
    await expect(assertSafeUrl('http://192.168.1.1/')).rejects.toThrow(/non-public/);
    await expect(assertSafeUrl('http://[::1]:8080/')).rejects.toThrow(/non-public/);
  });

  it('accepts public IP-literal URLs', async () => {
    const url = await assertSafeUrl('https://8.8.8.8/dns-query');
    expect(url.hostname).toBe('8.8.8.8');
  });

  it('rejects unparseable URLs', async () => {
    await expect(assertSafeUrl('not a url')).rejects.toThrow(/Invalid URL/);
  });
});

describe('htmlToText', () => {
  it('strips scripts, styles, and comments', () => {
    const out = htmlToText('<script>evil()</script><style>.x{}</style><!--c--><p>hi</p>');
    expect(out).toBe('hi');
  });

  it('converts block-level closing tags and <br> to newlines', () => {
    const out = htmlToText('<p>one</p><p>two<br>three</p>');
    expect(out).toBe('one\ntwo\nthree');
  });

  it('decodes entities', () => {
    const out = htmlToText('<p>a &amp; b &lt;c&gt; d&quot;e&#39;f&#x4F60;g</p>');
    expect(out).toBe('a & b <c> d"e\'f你g');
  });

  it('collapses intra-line whitespace but keeps line structure', () => {
    const out = htmlToText('<div>a   b\t c</div>\n<div>next</div>');
    expect(out).toBe('a b c\nnext');
  });
});

describe('webFetch', () => {
  it('uses the scrape proxy when it succeeds (caps content at 20k chars)', async () => {
    process.env.SEARCH_PROXY_URL = 'http://proxy.test:3003';
    const longContent = 'x'.repeat(25_000);
    const fetchMock = vi.fn(async (input: unknown) => {
      expect(String(input)).toBe(
        'http://proxy.test:3003/api/scrape?url=https%3A%2F%2F8.8.8.8%2Fpage&format=json',
      );
      return jsonResponse({
        url: 'https://8.8.8.8/page',
        title: 'Page title',
        content: longContent,
        provider: 'tavily',
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await webFetch('https://8.8.8.8/page');

    expect(fetchMock).toHaveBeenCalledTimes(1); // direct fetch never reached
    expect(out.provider).toBe('tavily');
    expect(out.title).toBe('Page title');
    expect(out.finalUrl).toBe('https://8.8.8.8/page');
    expect(out.content).toHaveLength(20_000);
    expect(out.truncated).toBe(true);
  });

  it('falls back to the direct hardened fetch when the proxy fails', async () => {
    process.env.SEARCH_PROXY_URL = 'http://proxy.test:3003';
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith('http://proxy.test:3003/api/scrape')) return jsonResponse({ error: 'down' }, 502);
      if (url === 'https://8.8.8.8/page') {
        return new Response('<html><body>hi there</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await webFetch('https://8.8.8.8/page');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.content).toBe('hi there');
    expect(out.status).toBe(200);
    expect(out.provider).toBeUndefined();
  });

  it('refuses private URLs before contacting the proxy', async () => {
    process.env.SEARCH_PROXY_URL = 'http://proxy.test:3003';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const out = await webFetch('http://127.0.0.1:3003/api');

    expect(out.error).toMatch(/non-public/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
