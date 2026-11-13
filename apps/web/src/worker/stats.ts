/**
 * Public usage counters for mofu.works/stats. Counts only (no addresses, no content), kept in one
 * Durable Object. Recording never blocks or fails a request.
 */
import type { CodeMatch, DeployerToken, TimelineEvent } from "../shared/api.js";
import type { TokenSnapshot } from "./timeline.js";

export type StatKey =
  | "chat_free"
  | "chat_holder"
  | "chat_byok"
  | "token_scan"
  | "tx_explain"
  | "guard_check"
  | "guard_stopped"
  | "guard_preview"
  | "mcp_scan_token"
  | "mcp_check_dependencies"
  | "mcp_explain_transaction"
  | "holder_connect"
  | "vote_cast"
  | "wallet_check"
  | "mcp_check_wallet"
  | "api_scan_token"
  | "api_check_wallet"
  | "cli_scan_token"
  | "cli_check_wallet"
  | "webhook_created"
  | "mcp_scan_secrets"
  | "mcp_audit_solidity";

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
  /** Remembers whether a token with this code fingerprint sold fine in the simulated sell. */
  noteCode?(fingerprint: string, entry: CodeEntry): Promise<void>;
  /** Other tokens with this fingerprint: how many failed the sell test, how many passed. */
  codeMatches?(fingerprint: string, exclude: string): Promise<CodeMatch>;
  /** Remembers a scanned token under its creator. */
  noteCreator?(creator: string, entry: CreatorEntry): Promise<void>;
  /** What Mofu knows of a creator's tokens, plus of `also` (other launches found on the chain). */
  creatorTokens?(creator: string, also: string[]): Promise<DeployerToken[]>;
  /** Launch-window buyers found earlier (they never change), or null. */
  launchCache?(token: string): Promise<LaunchCache | null>;
  saveLaunch?(token: string, cache: LaunchCache): Promise<void>;
  /** Every creator Mofu has filed tokens under, with their counts. */
  creatorBoard?(): Promise<CreatorSummary[]>;
  /** The tokens filed under one creator, newest first. */
  creatorRecords?(creator: string): Promise<CreatorEntry[]>;
  /** The verdict of each token's latest full scan, for the tokens Mofu has scanned. */
  knownVerdicts?(tokens: string[]): Promise<Record<string, IndexedToken["verdict"]>>;
  /**
   * Records a scan in the token's timeline (the first events when it's new) and returns the
   * timeline, newest first.
   */
  observeToken?(
    token: string,
    snapshot: TokenSnapshot,
    first: TimelineEvent[],
    now: number,
    extra?: TimelineEvent[],
  ): Promise<TimelineEvent[]>;
  /** The snapshot the token's last full scan left, or null. */
  tokenSnapshot?(token: string): Promise<TokenSnapshot | null>;
}

/** One creator's record across the tokens Mofu scanned. */
export interface CreatorSummary {
  creator: string;
  launches: number;
  honeypots: number;
  risky: number;
  caution: number;
  clean: number;
  /** When Mofu last scanned one of their tokens (ms). */
  last: number;
}

/** Counts per creator from the filed entries. Pure. */
export function summarizeCreators(rows: Array<[string, CreatorEntry]>): CreatorSummary[] {
  const by = new Map<string, CreatorSummary>();
  for (const [key, e] of rows) {
    const creator = key.split(":")[1] ?? "";
    if (!/^0x[0-9a-f]{40}$/.test(creator)) continue;
    const s = by.get(creator) ?? {
      creator,
      launches: 0,
      honeypots: 0,
      risky: 0,
      caution: 0,
      clean: 0,
      last: 0,
    };
    s.launches += 1;
    if (e.honeypot) s.honeypots += 1;
    else if (e.verdict === "risky") s.risky += 1;
    else if (e.verdict === "caution") s.caution += 1;
    else s.clean += 1;
    s.last = Math.max(s.last, e.at);
    by.set(creator, s);
  }
  return [...by.values()];
}

/** A scanned token under its creator; the verdict is the one before the creator and launch checks. */
export interface CreatorEntry {
  address: string;
  symbol: string | null;
  verdict: IndexedToken["verdict"];
  honeypot: boolean;
  at: number;
}

/** The launch window of a token, kept once read. Amounts are raw token units as strings. */
export interface LaunchCache {
  /** Time of the token's first transaction (ISO). */
  startedAt: string;
  windowSeconds: number;
  sameBlock: number;
  creatorBought: string;
  buyers: Array<{
    address: string;
    seconds: number;
    bought: string;
    sender: string;
    contract: boolean;
    /** undefined: not looked up yet; null: looked up, no plain ETH funding found. */
    funder?: string | null;
  }>;
}

export interface CodeEntry {
  address: string;
  symbol: string | null;
  outcome: "failed" | "passed";
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
