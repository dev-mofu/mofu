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
  | "vote_cast";

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
  noteToken(token: IndexedToken): Promise<void>;
  tokens(limit?: number): Promise<IndexedToken[]>;
}

export const tokenIndexFromEnv = (env: Env): TokenIndex =>
  env.STATS.get(env.STATS.idFromName("global"));
