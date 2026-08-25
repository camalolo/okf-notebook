/**
 * ERC-20 balance enumeration via the Blockscout v2 API (no API key needed).
 *
 * One function: `erc20Balances(address, chain)` — lists every ERC-20 token
 * held by an address on the given chain, with symbol, normalized balance,
 * and USD value where an exchange rate is known. Purely read-only public
 * API calls; no wallet key material is involved.
 */

/** Chains supported, mapped to their public Blockscout v2 instances. */
const CHAINS: Record<string, string> = {
  ethereum: 'https://eth.blockscout.com',
  gnosis: 'https://gnosis.blockscout.com',
};

/** Tolerated aliases (LLMs shorten chain names). */
const CHAIN_ALIASES: Record<string, string> = {
  eth: 'ethereum',
  gno: 'gnosis',
  xdai: 'gnosis',
};

export const SUPPORTED_CHAINS = Object.keys(CHAINS);

export interface Erc20BalanceRow {
  chain: string;
  token_address: string;
  symbol: string;
  name: string;
  /** Raw uint256 balance as a decimal string (exact — divide by 10^decimals). */
  raw_balance: string;
  /** Normalized balance (raw / 10^decimals), rounded to 10 decimal places. */
  balance: number;
  /** USD value (balance × exchange_rate) or null when the rate is unknown. */
  usd_value: number | null;
}

export interface Erc20BalancesResult {
  address: string;
  chain: string;
  tokens: Erc20BalanceRow[];
  /** Present (true) when the row list was capped — total is in `total`. */
  truncated?: boolean;
  /** Total ERC-20 count found (present only when truncated). */
  total?: number;
}

/** Minimal shape of a Blockscout token-balances item. */
interface RawTokenBalance {
  value?: string | null;
  token?: {
    /** eth/gnosis instances renamed it to address_hash; accept both. */
    address?: string | null;
    address_hash?: string | null;
    symbol?: string | null;
    name?: string | null;
    decimals?: string | null;
    type?: string | null;
    exchange_rate?: string | null;
  } | null;
}

/** Hard cap on returned rows so huge wallets (mostly spam airdrops) can't flood the chat context. */
const MAX_ROWS = 200;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Convert a raw uint256 string + decimals into a JS number, rounding to 10
 * decimal places via BigInt so there is no float error in the meaningful
 * digits. Returns null for unparseable input or overflow.
 */
function rawToNumber(raw: string, decimals: number): number | null {
  if (!/^\d+$/.test(raw)) return null;
  // Clamp decimals to something sane (uint256 tokens cap at 18-ish; be generous).
  const d = Math.max(0, Math.min(Math.trunc(decimals) || 0, 78));
  try {
    const SCALE = 10n ** 10n; // 10 fractional digits of output precision
    const shift = 10n ** BigInt(d);
    const scaled = (BigInt(raw) * SCALE + shift / 2n) / shift; // rounded
    const n = Number(scaled) / 1e10;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Enumerate the ERC-20 token balances of `address` on `chain`.
 *
 * Uses `GET {blockscout}/api/v2/addresses/{address}/token-balances`, filters
 * to type === "ERC-20" (drops NFTs) and non-zero balances, normalizes values,
 * and sorts by USD value (known rates first, then by balance) so the most
 * meaningful tokens head the list.
 */
export async function erc20Balances(address: string, chain: string): Promise<Erc20BalancesResult> {
  const addr = address.trim();
  if (!ADDRESS_RE.test(addr)) {
    throw new Error(`Invalid address: "${address}" — expected a 0x-prefixed 42-char hex address.`);
  }
  const normalized = addr.toLowerCase();

  const chainKey = chain.trim().toLowerCase();
  const resolved = CHAIN_ALIASES[chainKey] ?? chainKey;
  const base = CHAINS[resolved];
  if (!base) {
    throw new Error(`Unsupported chain: "${chain}". Supported: ${SUPPORTED_CHAINS.join(', ')}.`);
  }

  const res = await fetch(`${base}/api/v2/addresses/${normalized}/token-balances`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Blockscout ${resolved} HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as RawTokenBalance[];
  if (!Array.isArray(data)) {
    throw new Error(`Blockscout ${resolved} returned an unexpected (non-array) response.`);
  }

  const rows: Erc20BalanceRow[] = [];
  for (const item of data) {
    const token = item.token;
    // Native-coin / weird entries have a null token; NFTs have a non-ERC-20 type.
    if (!token || token.type !== 'ERC-20') continue;

    const raw = (item.value ?? '').toString();
    if (!raw || raw === '0') continue; // keep only balance > 0

    const decimals = Number(token.decimals);
    const balance = rawToNumber(raw, Number.isInteger(decimals) ? decimals : 0);
    if (balance === null || balance === 0) continue;

    const rate = token.exchange_rate != null && token.exchange_rate !== '' ? Number(token.exchange_rate) : NaN;
    const usd = Number.isFinite(rate) && rate > 0 ? Math.round(rate * balance * 100) / 100 : null;

    rows.push({
      chain: resolved,
      token_address: (token.address_hash ?? token.address ?? '').toLowerCase(),
      symbol: token.symbol ?? '',
      name: token.name ?? '',
      raw_balance: raw,
      balance,
      usd_value: usd,
    });
  }

  // Most valuable first; unknown-value tokens after, by balance.
  rows.sort((a, b) => {
    if (a.usd_value !== null && b.usd_value !== null) return b.usd_value - a.usd_value;
    if (a.usd_value !== null) return -1;
    if (b.usd_value !== null) return 1;
    return b.balance - a.balance;
  });

  const total = rows.length;
  const capped = rows.slice(0, MAX_ROWS);
  return capped.length === total
    ? { address: normalized, chain: resolved, tokens: capped }
    : { address: normalized, chain: resolved, tokens: capped, truncated: true, total };
}
