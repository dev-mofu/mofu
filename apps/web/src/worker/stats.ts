/**
 * Public usage counters for mofu.works/stats. Counts only (no addresses, no content), kept in one
 * Durable Object. Recording never blocks or fails a request.
 */
export type StatKey =
  | "chat_free"
  | "chat_holder"
  | "chat_byok"
  | "token_scan"
  | "tx_explain"
  | "guard_check"
  | "guard_stopped"
  | "mcp_scan_token"
  | "mcp_check_dependencies"
  | "mcp_explain_transaction"
  | "holder_connect"
  | "vote_cast"
  | "wallet_check"
  | "mcp_check_wallet";

export interface Stats {
  add(key: StatKey, n?: number): Promise<void>;
  all(): Promise<{ since: string | null; counters: Record<string, number> }>;
}

export const statsFromEnv = (env: Env): Stats => env.STATS.get(env.STATS.idFromName("global"));

/** A token someone scanned, listed on mofu.works/token/ and in the token sitemap. */
export interface IndexedToken {
  address: string;
  name: string | null;
  symbol: string | null;
  verdict: "clean" | "caution" | "risky";
  /** When it was last scanned (ms). */
  at: number;
}

/** Most recent first; the index keeps this many. */
export const TOKEN_INDEX_MAX = 1000;

export interface TokenIndex {
  /** Lists a scanned token publicly (and remembers its name for lookalike checks). */
  noteToken(token: IndexedToken): Promise<void>;
  tokens(limit?: number): Promise<IndexedToken[]>;
  /** Remembers tokens' names and tickers for lookalike checks only (not listed). */
  rememberTokens(tokens: IndexedToken[]): Promise<void>;
  /** Tokens with the same normalized name or ticker, other than `exclude`. */
  similar(name: string | null, symbol: string | null, exclude: string): Promise<IndexedToken[]>;
}

/** Names compared without case, spaces or symbols: "Mofu Coin" and "MOFUCOIN" match. */
export const normalizeName = (s: string | null | undefined) =>
  (s ?? "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 40);

/** Storage keys under which a token is found by name and by ticker. */
export const nameKeys = (t: Pick<IndexedToken, "address" | "name" | "symbol">) =>
  [
    normalizeName(t.symbol) && `sym:${normalizeName(t.symbol)}:${t.address.toLowerCase()}`,
    normalizeName(t.name) && `nam:${normalizeName(t.name)}:${t.address.toLowerCase()}`,
  ].filter((k): k is string => !!k);

export const tokenIndexFromEnv = (env: Env): TokenIndex =>
  env.STATS.get(env.STATS.idFromName("global"));
