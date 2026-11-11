/** Types and constants shared by the Worker and the browser app. */

export const MODES = ["general", "data", "study", "dev"] as const;
export type Mode = (typeof MODES)[number];

export const MODE_LABELS: Record<Mode, string> = {
  general: "General",
  data: "Data Analyst",
  study: "Study Buddy",
  dev: "Dev Tools",
};

/** Modes that work today. The rest show "Coming soon" until their phase ships. */
export const AVAILABLE_MODES: readonly Mode[] = ["general", "data", "study", "dev"];

/** Header carrying a user's own OpenRouter key. Never logged or stored server-side. */
export const BYOK_HEADER = "X-OpenRouter-Key";
/** Model choice; honored only together with BYOK_HEADER. */
export const MODEL_HEADER = "X-Mofu-Model";

/** Hard limits, enforced by the Worker. The UI only mirrors them. */
export const LIMITS = {
  maxBodyBytes: 200_000,
  maxMessages: 40,
  maxHistoryChars: 60_000,
  maxMemoryItems: 50,
  maxMemoryItemChars: 300,
  maxSteps: 6,
  maxOutputTokens: 2_000,
  timeoutMs: 90_000,
  /** Repository overview the browser builds and sends in Dev Tools mode. */
  maxContextChars: 16_000,
  sessionTtlMs: 2 * 60 * 60 * 1000,
  /** Study documents on the free tier; your own key raises these. */
  freeDocPages: 30,
  freeDocChars: 60_000,
  byokDocPages: 300,
  byokDocChars: 400_000,
  /** Text returned by /api/fetch-page. */
  maxPageChars: 400_000,
} as const;

/** Suggested models for people using their own key. Any OpenRouter ID with tool support works. */
export const CURATED_MODELS = [
  { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5 (fast, cheap)" },
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5" },
  { id: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5 (most capable)" },
  { id: "qwen/qwen3.7-flash", label: "Qwen 3.7 Flash (cheapest)" },
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
] as const;

export type ApiErrorCode =
  | "session_required"
  | "daily_limit"
  | "free_tier_disabled"
  | "bad_request"
  | "too_large"
  | "invalid_key"
  | "forbidden_origin"
  | "holder_only"
  | "server_error";

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  /** ISO time when the daily limit resets (daily_limit only). */
  resetAt?: string;
  limit?: number;
}

/** Extra material the browser gathered for the model, e.g. a GitHub repository overview. */
export type ChatContext =
  | {
      kind: "github-repo";
      /** owner/repo */
      title: string;
      text: string;
    }
  | { kind: "dep-scan"; title: string; text: string }
  /** Profile of the user's file, built in the browser. */
  | { kind: "dataset"; title: string; text: string }
  /** Outline of a study document; the browser serves the pages through read_document. */
  | { kind: "document"; title: string; text: string }
  /** APIForge: the endpoint list of a spec parsed in the browser, plus a breaking-change diff when one was made. */
  | { kind: "api-spec"; title: string; text: string }
  /** Token Scanner: a report built from Robinhood Chain data. */
  | { kind: "token-scan"; title: string; text: string }
  /** Transaction explainer: a decoded Robinhood Chain transaction. */
  | { kind: "tx"; title: string; text: string };

export interface FetchedPageResponse {
  url: string;
  title: string;
  text: string;
}

export interface UsageInfo {
  freeTierEnabled: boolean;
  limit: number;
  remaining: number;
  resetAt: string;
  /** Set when a wallet is connected for $MOFU holder perks. */
  holder?: HolderStatus | null;
}

/** A connected wallet and whether it currently qualifies for holder perks. */
export interface HolderStatus {
  address: string;
  /** Whole tokens, or null when the balance couldn't be read right now. */
  balance: string | null;
  eligible: boolean;
}

/** Holder perks as configured on the server; null when they're off. */
export interface HolderPerks {
  token: string;
  chainName: string;
  /** Whole tokens needed. */
  minTokens: string;
  dailyLimit: number;
}

export interface HolderChallengeResponse {
  /** Text for the wallet to sign (personal_sign). */
  message: string;
  /** Opaque token to send back with the signature. */
  challenge: string;
}

export interface PublicConfig {
  turnstileSiteKey: string;
  defaultModel: string;
  freeDailyLimit: number;
  freeTierEnabled: boolean;
  holder: HolderPerks | null;
}

export interface SessionResponse {
  expiresAt: string;
}

export interface KeyCheckResponse {
  valid: boolean;
  /** Credit left on the key, in USD, when the key has a limit. */
  limitRemaining?: number | null;
}

/** Parses an error thrown by the chat transport (its message is the response body). */
export function parseApiError(err: unknown): ApiError | null {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  try {
    const parsed = JSON.parse(text) as Partial<ApiError>;
    if (parsed && typeof parsed.code === "string" && typeof parsed.message === "string") {
      return parsed as ApiError;
    }
  } catch {
    // Not one of ours.
  }
  return null;
}

/** One line of a token scan: a question about what the contract can do, and the answer. */
export interface TokenCheck {
  id:
    | "mint"
    | "pause"
    | "blacklist"
    | "fees"
    | "limits"
    | "upgrade"
    | "owner"
    | "destroy"
    | "concentration";
  label: string;
  status: "ok" | "warn" | "risk" | "info";
  detail: string;
}

/** Token Scanner report, built by Mofu's own code from Robinhood Chain data (no model). */
export interface TokenScanReport {
  address: string;
  chainName: string;
  isContract: boolean;
  codeSize: number;
  token: {
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    /** Whole tokens. */
    totalSupply: string | null;
  };
  owner: {
    status: "none" | "renounced" | "active";
    address: string | null;
    /** Share of supply the owner wallet holds, 0–100. */
    holdsPercent: number | null;
  };
  proxy: { kind: "none" | "eip1967" | "beacon" | "minimal"; implementation: string | null };
  /** Share of supply sitting in burn addresses, 0–100. */
  burnedPercent: number | null;
  checks: TokenCheck[];
  verdict: "clean" | "caution" | "risky";
  /** Who holds the supply. "full" for $MOFU holders, "summary" for everyone else. */
  distribution: TokenDistribution;
  /** Who created the token; only in the full report. */
  origin: TokenOrigin | null;
  /** What this scan can't see. */
  limits: string[];
}

export interface TokenScanResponse {
  report: TokenScanReport;
  /** Scans left today for this IP or holder wallet. */
  remaining: number;
  limit: number;
}

export interface TokenHolder {
  address: string;
  /** Whole tokens. */
  balance: string;
  /** Share of supply, 0–100. */
  percent: number;
  kind: "wallet" | "contract" | "burn";
}

export interface TokenDistribution {
  status: "full" | "summary" | "unavailable";
  /** Share of supply held by the top 10 holders that aren't burn addresses. */
  top10Percent: number | null;
  /** The biggest plain wallet (not a contract, not burned). */
  largestWallet: { address: string; percent: number } | null;
  /** The top holders; empty unless status is "full". */
  holders: TokenHolder[];
}

export interface TokenOrigin {
  creator: string;
  /** The launchpad contract the creator called, when the token was minted in that call. */
  launcher: string | null;
  creationTx: string;
  createdAt: string | null;
  creatorFirstSeen: string | null;
  creatorAgeDays: number | null;
  creatorTxCount: number | null;
  /** Whole tokens the creator still holds. */
  creatorHolds: string | null;
  creatorHoldsPercent: number | null;
  /** Other tokens the creator launched through the same launcher, in its latest 100 transactions. */
  otherLaunches: string[];
  otherLaunchCount: number;
}

export interface TxTransfer {
  token: string;
  symbol: string | null;
  from: string;
  to: string;
  /** Human amount, already scaled by decimals. */
  amount: string;
  mint: boolean;
  burn: boolean;
}

export interface TxApproval {
  token: string;
  symbol: string | null;
  owner: string;
  spender: string;
  /** Human amount, "unlimited", "all items" or "revoked". */
  amount: string;
  unlimited: boolean;
  spenderIsContract: boolean | null;
}

/** Transaction explainer report, decoded by Mofu's code (no model). */
export interface TxReport {
  hash: string;
  chainName: string;
  status: "success" | "failed";
  time: string | null;
  from: string;
  to: string | null;
  toIsContract: boolean | null;
  valueEth: string;
  feeEth: string;
  transfers: TxTransfer[];
  approvals: TxApproval[];
  otherEvents: string[];
  flags: Array<{ level: "warn" | "risk"; text: string }>;
}

export interface TxResponse {
  report: TxReport;
  remaining: number;
  limit: number;
}

/** The holder roadmap vote: the round, live results and this visitor's own vote. */
export interface VoteResponse {
  round: {
    id: string;
    question: string;
    open: boolean;
    options: Array<{ id: string; title: string; body: string }>;
  };
  results: Array<{ id: string; voters: number; weight: string; percent: number }>;
  totalVoters: number;
  /** Whole $MOFU behind all counted votes. */
  totalWeight: string;
  /** The option this connected wallet voted for, if any. */
  mine: string | null;
  /** True when a connected wallet holds enough $MOFU to vote. */
  canVote: boolean;
  minTokens: string;
}
