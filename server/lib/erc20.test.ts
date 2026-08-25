import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { erc20Balances } from './erc20.js';

const ADDR = '0xe2680516C89bd1D814A21fE6eCbf34eeC2b8793f';

/** A realistic Blockscout token-balances payload (subset). */
function blockscoutPayload(): unknown[] {
  return [
    {
      value: '1234567890000000000000',
      token: {
        address: '0xE2D31990CD39213249A858cE3C39C6347F1b9f02',
        symbol: 'REALTOKEN-SOME-PROPERTY',
        name: 'Some Property 123 Main St',
        decimals: '18',
        type: 'ERC-20',
        exchange_rate: '100.25',
      },
    },
    {
      value: '5000000000000000000',
      token: {
        address: '0x6A023CCd18ff134537eC7294b19F72DEA0e25BEf',
        symbol: 'NO-RATE',
        name: 'Token without exchange rate',
        decimals: '18',
        type: 'ERC-20',
        exchange_rate: null,
      },
    },
    {
      value: '1',
      token: {
        address: '0x1234567890123456789012345678901234567890',
        symbol: 'NFT',
        name: 'An NFT',
        decimals: '0',
        type: 'ERC-721',
        exchange_rate: '1',
      },
    },
    {
      value: '3',
      token: {
        address: '0x2234567890123456789012345678901234567890',
        symbol: 'NFT1155',
        name: 'A multi-token',
        decimals: '0',
        type: 'ERC-1155',
        exchange_rate: null,
      },
    },
    {
      // Zero balance — must be dropped.
      value: '0',
      token: {
        address: '0x3234567890123456789012345678901234567890',
        symbol: 'ZERO',
        name: 'Empty',
        decimals: '18',
        type: 'ERC-20',
        exchange_rate: '5',
      },
    },
    {
      // Native-coin entry (token null) — must be dropped.
      value: '1000000000000000000',
      token: null,
    },
    {
      // Small-balance token with a rate, fewer decimals, new address_hash field name.
      value: '25075',
      token: {
        address_hash: '0x4234567890123456789012345678901234567890',
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: '6',
        type: 'ERC-20',
        exchange_rate: '0.9998',
      },
    },
  ];
}

let calls: { url: string; init?: RequestInit }[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(blockscoutPayload()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('erc20Balances', () => {
  it('routes to the correct Blockscout host per chain', async () => {
    await erc20Balances(ADDR, 'gnosis');
    await erc20Balances(ADDR, 'ethereum');
    expect(calls.map((c) => c.url)).toEqual([
      `https://gnosis.blockscout.com/api/v2/addresses/${ADDR.toLowerCase()}/token-balances`,
      `https://eth.blockscout.com/api/v2/addresses/${ADDR.toLowerCase()}/token-balances`,
    ]);
  });

  it('accepts chain aliases and is case-insensitive', async () => {
    const r = await erc20Balances(ADDR, 'ETH');
    expect(r.chain).toBe('ethereum');
    const r2 = await erc20Balances(ADDR, 'xdai');
    expect(r2.chain).toBe('gnosis');
  });

  it('keeps only ERC-20 with balance > 0, normalizes and prices', async () => {
    const r = await erc20Balances(ADDR, 'gnosis');
    expect(r.address).toBe(ADDR.toLowerCase());
    expect(r.chain).toBe('gnosis');

    const symbols = r.tokens.map((t) => t.symbol);
    expect(symbols).toContain('REALTOKEN-SOME-PROPERTY');
    expect(symbols).toContain('NO-RATE');
    expect(symbols).toContain('USDC');
    expect(symbols).not.toContain('NFT');
    expect(symbols).not.toContain('NFT1155');
    expect(symbols).not.toContain('ZERO');
    expect(r.tokens).toHaveLength(3);

    const realt = r.tokens.find((t) => t.symbol === 'REALTOKEN-SOME-PROPERTY')!;
    expect(realt.raw_balance).toBe('1234567890000000000000');
    expect(realt.balance).toBeCloseTo(1234.56789, 8);
    expect(realt.token_address).toBe('0xe2d31990cd39213249a858ce3c39c6347f1b9f02');
    // 1234.56789 * 100.25 = 123765.4309… rounded to cents
    expect(realt.usd_value).toBeCloseTo(123765.43, 1);

    const noRate = r.tokens.find((t) => t.symbol === 'NO-RATE')!;
    expect(noRate.balance).toBeCloseTo(5, 8);
    expect(noRate.usd_value).toBeNull();

    const usdc = r.tokens.find((t) => t.symbol === 'USDC')!;
    expect(usdc.balance).toBeCloseTo(0.025075, 9);
    expect(usdc.usd_value).toBeCloseTo(0.03, 2); // 0.025075 * 0.9998 → $0.03
  });

  it('sorts by USD value descending, unknown-rate tokens last', async () => {
    const r = await erc20Balances(ADDR, 'gnosis');
    const symbols = r.tokens.map((t) => t.symbol);
    expect(symbols.indexOf('REALTOKEN-SOME-PROPERTY')).toBeLessThan(symbols.indexOf('USDC'));
    expect(r.tokens[r.tokens.length - 1]!.usd_value).toBeNull();
  });

  it('rejects invalid addresses', async () => {
    await expect(erc20Balances('0x123', 'gnosis')).rejects.toThrow(/invalid address/i);
    await expect(erc20Balances('not-an-address', 'ethereum')).rejects.toThrow(/invalid address/i);
  });

  it('rejects unsupported chains with the supported list', async () => {
    await expect(erc20Balances(ADDR, 'polygon')).rejects.toThrow(
      /unsupported chain.*ethereum.*gnosis/i,
    );
  });

  it('surfaces HTTP errors with status and body', async () => {
    globalThis.fetch = (async () =>
      new Response('{"message":"Not Found"}', { status: 404 })) as typeof fetch;
    await expect(erc20Balances(ADDR, 'gnosis')).rejects.toThrow(/HTTP 404/);
  });

  it('caps output at 200 rows and reports truncation', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      value: String(1000 + i),
      token: {
        address: `0x${String(i).padStart(40, '0')}`,
        symbol: `TK${i}`,
        name: `Token ${i}`,
        decimals: '0',
        type: 'ERC-20',
        exchange_rate: null,
      },
    }));
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(many), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    const r = await erc20Balances(ADDR, 'gnosis');
    expect(r.tokens).toHaveLength(200);
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(250);
    // Balance-descending order among equal-rate rows: TK249 (1249 units) first.
    expect(r.tokens[0]!.symbol).toBe('TK249');
  });
});
