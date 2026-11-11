/**
 * Top $MOFU holders for the tower in Mofu Town, from GoldRush. Without GOLDRUSH_API_KEY the
 * tower says "coming soon". Cached for five minutes per Worker instance.
 */
import type { TokenHolder } from "../shared/api.js";
import { topHolders } from "./chain-data.js";

const CACHE_MS = 5 * 60 * 1000;

export type TownHolder = TokenHolder;

export type TownHoldersResponse =
  { status: "ok"; updatedAt: string; holders: TownHolder[] } | { status: "unavailable" };

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
  const holders = await topHolders(
    { apiKey: opts.apiKey, chain: opts.chain, rpcUrls: opts.rpcUrls, fetch: opts.fetch },
    opts.token,
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
