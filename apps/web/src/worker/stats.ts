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
