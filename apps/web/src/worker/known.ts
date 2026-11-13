/**
 * Known contracts: names for addresses that show up everywhere on Robinhood Chain (the $MOFU
 * contracts, the Pons launchpad, WETH, burn addresses), plus what can be read about any other
 * address without guessing: wallet or contract, token name, launch curve, pool pair, how old it is
 * and how busy. A name only appears when Mofu's list has it or the chain says it.
 */
import type { AddressInfo } from "../shared/api.js";
import { callOf, rpcBatch, type BatchCall } from "./chain.js";
import type { ChainDataOptions } from "./chain-data.js";
import { decodeString } from "./token-scan.js";

export const MOFU_TOKEN = "0xf76593c1c321c2a2f77775025e9677999ce7ea8c";
export const MOFU_CURVE = "0xc2347eda73ddcbc7a1ce29ff140fd6a62d0cf460";
export const PONS_LAUNCHPAD = "0xe33e9e479df8802cb0866d5d05258bec4cf62948";
export const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
/** Has unlock, initialize, modifyLiquidity and extsload: the Uniswap v4 singleton. Graduated Pons tokens trade here. */
export const V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

/** Mofu's own list. Each entry was checked on-chain (see the notes). */
export const KNOWN: Record<string, { label: string; kind: AddressInfo["kind"] }> = {
  // The official token: the contract linked from mofu.works/verify.
  [MOFU_TOKEN]: { label: "$MOFU (official)", kind: "token" },
  // token() on this contract returns $MOFU; it holds the unsold supply and takes buys and sells.
  [MOFU_CURVE]: { label: "Pons launch curve for $MOFU", kind: "curve" },
  // $MOFU was minted in a call to this contract; it creates every Pons token and its curve.
  [PONS_LAUNCHPAD]: { label: "Pons launchpad", kind: "contract" },
  // symbol() returns WETH; it's the WETH() address of Robinhood Chain routers.
  [WETH]: { label: "WETH (wrapped ETH)", kind: "token" },
  // Holds the tokens of every v4 pool at once (it's a singleton), so it shows up as a top holder.
  [V4_POOL_MANAGER]: { label: "Uniswap v4 pool manager", kind: "pool" },
  [ZERO]: { label: "Burn address (zero)", kind: "burn" },
  [DEAD]: { label: "Burn address (dead)", kind: "burn" },
};

/** Selectors a Pons launch curve has: buy, sell and token(). */
const CURVE_SELECTORS = ["59a87bc1", "d04c6983", "fc0c546a"];

const word = (h: BatchResult) => (h && /^0x[0-9a-f]{64}/i.test(h) ? h.slice(0, 66) : null);
type BatchResult = string | null;
const addressOf = (h: BatchResult) => {
  const w = word(h);
  if (!w || !/^0x0{24}/.test(w)) return null;
  const a = `0x${w.slice(26)}`.toLowerCase();
  return a === ZERO ? null : a;
};
const str = (h: BatchResult) => {
  if (!h || h === "0x") return null;
  try {
    return decodeString(h);
  } catch {
    return null;
  }
};

interface Summary {
  items?: Array<{ total_count?: number; earliest_transaction?: { block_signed_at?: string } }>;
}

async function summary(o: ChainDataOptions, address: string) {
  try {
    const res = await o.fetch(
      `https://api.covalenthq.com/v1/${o.chain}/address/${address}/transactions_summary/`,
      {
        headers: { Authorization: `Bearer ${o.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const body = (await res.json()) as { data?: Summary };
    const it = body.data?.items?.[0];
    return {
      txCount: it?.total_count ?? null,
      firstSeen: it?.earliest_transaction?.block_signed_at ?? null,
    };
  } catch {
    return { txCount: null, firstSeen: null };
  }
}

const cache = new Map<string, { info: AddressInfo; at: number }>();

/**
 * Describes addresses in three batched RPC calls plus one GoldRush summary per contract (up to
 * `maxSummaries`, the rest stay without age). Results are cached for ten minutes.
 */
export async function describeAddresses(
  o: ChainDataOptions & { now: number },
  addresses: readonly string[],
  maxSummaries = 8,
): Promise<Map<string, AddressInfo>> {
  const out = new Map<string, AddressInfo>();
  const todo: string[] = [];
  for (const raw of new Set(addresses.map((a) => a.toLowerCase()))) {
    const hit = cache.get(raw);
    if (hit && o.now - hit.at < 10 * 60_000) out.set(raw, hit.info);
    else todo.push(raw);
  }
  if (todo.length === 0) return out;

  // Code, token(), token0(), token1(), name(), symbol() for each address.
  const calls: BatchCall[] = todo.flatMap((a) => [
    { method: "eth_getCode", params: [a, "latest"] },
    callOf(a, "0xfc0c546a"),
    callOf(a, "0x0dfe1681"),
    callOf(a, "0xd21220a7"),
    callOf(a, "0x06fdde03"),
    callOf(a, "0x95d89b41"),
  ]);
  const r = await rpcBatch(o.rpcUrls, calls, o.fetch);
  const facts = todo.map((address, i) => {
    const [code, token, t0, t1, name, symbol] = r.slice(i * 6, i * 6 + 6);
    return {
      address,
      code: code ?? "0x",
      token: addressOf(token ?? null),
      t0: addressOf(t0 ?? null),
      t1: addressOf(t1 ?? null),
      name: str(name ?? null),
      symbol: str(symbol ?? null),
    };
  });

  // Symbols of curve tokens and pool pairs, in one more batch.
  const related = [
    ...new Set(facts.flatMap((f) => [f.token, f.t0, f.t1].filter((x): x is string => !!x))),
  ];
  const relatedSymbols = new Map<string, string | null>();
  if (related.length) {
    const rs = await rpcBatch(
      o.rpcUrls,
      related.map((a) => callOf(a, "0x95d89b41")),
      o.fetch,
    );
    related.forEach((a, i) =>
      relatedSymbols.set(a, KNOWN[a] ? KNOWN[a].label : str(rs[i] ?? null)),
    );
  }
  const sym = (a: string) => {
    const s = relatedSymbols.get(a);
    return s ? (s.startsWith("$") || KNOWN[a] ? s : `$${s}`) : `${a.slice(0, 6)}…${a.slice(-4)}`;
  };

  let summaries = 0;
  await Promise.all(
    facts.map(async (f) => {
      const known = KNOWN[f.address];
      // EIP-7702 wallets carry a 23-byte delegation (0xef0100…): still a wallet.
      const isContract = f.code.length > 2 && !f.code.startsWith("0xef0100");
      let kind: AddressInfo["kind"];
      let label: string | null = known?.label ?? null;
      if (known) kind = known.kind;
      else if (!isContract) kind = "wallet";
      else if (f.token && CURVE_SELECTORS.every((s) => f.code.includes(`63${s}`))) {
        kind = "curve";
        label = `Launch curve for ${sym(f.token)}`;
      } else if (f.t0 && f.t1) {
        kind = "pool";
        label = `Liquidity pool ${sym(f.t0)} / ${sym(f.t1)}`;
      } else if (f.symbol || f.name) {
        kind = "token";
        label = [f.name, f.symbol ? `($${f.symbol})` : null].filter(Boolean).join(" ") || null;
      } else kind = "contract";

      let txCount: number | null = null;
      let firstSeen: string | null = null;
      if (kind !== "burn" && summaries < maxSummaries) {
        summaries++;
        ({ txCount, firstSeen } = await summary(o, f.address));
      }
      const info: AddressInfo = {
        address: f.address,
        kind,
        label,
        known: !!known,
        txCount,
        firstSeen,
        ageDays: firstSeen
          ? Math.max(0, Math.floor((o.now - Date.parse(firstSeen)) / 86_400_000))
          : null,
      };
      out.set(f.address, info);
      cache.set(f.address, { info, at: o.now });
    }),
  );
  if (cache.size > 2000) cache.clear();
  return out;
}

/** "New contract, 3 days old, 12 transactions" style facts for an address. */
export function describeActivity(i: AddressInfo): string {
  const parts: string[] = [];
  if (i.ageDays !== null)
    parts.push(i.ageDays === 0 ? "first active today" : `active for ${i.ageDays} days`);
  if (i.txCount !== null) parts.push(`${i.txCount.toLocaleString("en-US")} transactions`);
  return parts.join(", ");
}
