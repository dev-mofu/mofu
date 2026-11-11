/**
 * Top $MOFU holders for the tower in Mofu Town, from GoldRush (Covalent). Free public RPCs can't
 * list holders, so this needs a GOLDRUSH_API_KEY secret; without it the tower says "coming soon".
 * Contracts (the Pons curve or a pool) and burn addresses are labeled so wallets stand out.
 */
import { rpcCall } from "./chain.js";

const BURN = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);
const CACHE_MS = 5 * 60 * 1000;

export interface TownHolder {
  address: string;
  /** Whole tokens. */
  balance: string;
  /** Share of supply, 0–100. */
  percent: number;
  kind: "wallet" | "contract" | "burn";
}

export type TownHoldersResponse =
  { status: "ok"; updatedAt: string; holders: TownHolder[] } | { status: "unavailable" };

interface GoldRushItem {
  address?: string;
  balance?: string;
  total_supply?: string;
  contract_decimals?: number;
}

let cache: { at: number; body: TownHoldersResponse } | null = null;

export async function townHolders(opts: {
  apiKey: string | undefined;
  chain: string;
  token: string;
  rpcUrls: readonly string[];
  fetch: typeof fetch;
  now: number;
}): Promise<TownHoldersResponse> {
  if (!opts.apiKey) return { status: "unavailable" };
  if (cache && opts.now - cache.at < CACHE_MS) return cache.body;
  const url = `https://api.covalenthq.com/v1/${opts.chain}/tokens/${opts.token}/token_holders_v2/`;
  const res = await opts.fetch(url, {
    headers: { Authorization: `Bearer ${opts.apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GoldRush HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { items?: GoldRushItem[] } };
  // GoldRush rejects custom page sizes on this chain; take the first page and keep the top ten.
  const items = (json.data?.items ?? [])
    .filter((i) => i.address && i.balance && /^\d+$/.test(i.balance))
    .sort((a, b) =>
      BigInt(b.balance!) > BigInt(a.balance!)
        ? 1
        : BigInt(b.balance!) < BigInt(a.balance!)
          ? -1
          : 0,
    )
    .slice(0, 10);
  const holders = await Promise.all(
    items.map(async (i): Promise<TownHolder> => {
      const address = i.address!.toLowerCase();
      const decimals = BigInt(i.contract_decimals ?? 18);
      const balance = BigInt(i.balance!);
      const supply = BigInt(i.total_supply ?? "0");
      const percent = supply > 0n ? Number((balance * 1_000_000n) / supply) / 10_000 : 0;
      let kind: TownHolder["kind"] = BURN.has(address) ? "burn" : "wallet";
      if (kind === "wallet") {
        const code = await rpcCall<string>(
          opts.rpcUrls,
          "eth_getCode",
          [address, "latest"],
          opts.fetch,
        ).catch(() => "0x");
        if (code && code !== "0x") kind = "contract";
      }
      return { address, balance: (balance / 10n ** decimals).toString(), percent, kind };
    }),
  );
  const body: TownHoldersResponse = {
    status: "ok",
    updatedAt: new Date(opts.now).toISOString(),
    holders,
  };
  if (holders.length > 0) cache = { at: opts.now, body };
  return body;
}

/** Only for tests. */
export function clearTownHoldersCache(): void {
  cache = null;
}
