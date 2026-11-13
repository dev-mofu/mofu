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
  | { kind: "tx"; title: string; text: string }
  /** Wallet Health: a wallet's approvals and holdings. */
  | { kind: "wallet"; title: string; text: string };

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
    | "concentration"
    | "sell"
    | "lookalike"
    | "fingerprint"
    | "deployer"
    | "bundle"
    | "liquidity";
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
  /** A simulated buy and sell; null when there was nowhere to test it. */
  sellTest: SellTest | null;
  /** Other tokens Mofu has seen with the same name or ticker. */
  lookalikes: TokenLookalike[];
  /**
   * A fingerprint of the contract's code (metadata and embedded addresses left out), so the same
   * contract deployed again under another name gives the same value. Null for non-contracts.
   */
  fingerprint: string | null;
  /** Other tokens with the same code fingerprint whose simulated sell failed. */
  codeMatch: CodeMatch | null;
  /** The creator's track record: other tokens they launched and what Mofu found in them. */
  deployer?: DeployerReputation | null;
  /** Who bought in the first minute, whether those wallets are linked, and what they still hold. */
  launch?: LaunchActivity | null;
  /** Where the liquidity is and whether a wallet can pull it. */
  liquidity?: LiquidityInfo | null;
  /** What this scan can't see. */
  limits: string[];
}

/** A buy and a sell simulated on Robinhood Chain (eth_simulateV1): nothing is sent. */
export interface SellTest {
  status: "passed" | "failed" | "unknown";
  /** "curve": a real buy then sell on the Pons launch curve. "transfer": token moves to and from the pool. */
  method: "curve" | "transfer";
  /** Where it was tested: the curve or pool address. */
  venue: string;
  /** Share of the tokens lost on the way in, 0–100. */
  buyTaxPercent: number | null;
  /** Share lost on the way out, 0–100. */
  sellTaxPercent: number | null;
  /** ETH you'd get back from a small buy sold straight away, 0–100 (curve only; fees and price impact included). */
  roundTripPercent: number | null;
  /** How big one sale can be before the price drops 10%; null when it couldn't be measured. */
  depth: SellDepth | null;
  detail: string;
}

/** Sell depth: the biggest single sale before the price drops 10%. */
export interface SellDepth {
  /** "simulated": sells of growing size on the launch curve. "reserves": from a V2 pool's reserves. */
  method: "simulated" | "reserves";
  /** ETH that sale returns; null when even the smallest step moved the price more than 10%. */
  ethAt10Percent: number | null;
  /** True when every size tried stayed under 10%: the real depth is bigger. */
  moreThan: boolean;
  /** Each size tried: share of the supply sold, the ETH it returned and the price drop, 0–100. */
  steps: Array<{ supplyPercent: number | null; ethOut: number; impactPercent: number }>;
  detail: string;
}

/** Where a token's liquidity sits and who could take it out. */
export interface LiquidityInfo {
  /**
   * "curve": still on its Pons launch curve. "graduated": moved from the curve to a v4 pool.
   * "v2" / "v3": a Uniswap-style pool. "v4": a v4 pool it wasn't graduated into.
   */
  kind: "curve" | "graduated" | "v2" | "v3" | "v4";
  venue: string;
  /** ETH on the ETH side (curve balance or the pool's WETH); null when not ETH-paired or unknown. */
  eth: number | null;
  /** On a launch curve: what it raised toward graduation, in ETH. */
  curve: {
    raised: number | null;
    threshold: number | null;
    progressPercent: number | null;
    /** The curve's code has an owner or withdraw function. */
    adminFunctions: string[];
  } | null;
  /** In a v2 pool: who holds the LP tokens, 0–100 each. */
  lp: {
    burnedPercent: number;
    contractPercent: number | null;
    walletPercent: number | null;
    topWallet: { address: string; percent: number } | null;
  } | null;
  status: "ok" | "warn" | "risk" | "info";
  detail: string;
}

/** A token launched by the same creator, as Mofu last saw it. */
export interface DeployerToken {
  address: string;
  symbol: string | null;
  /** Mofu's verdict, or null when Mofu hasn't scanned it. */
  verdict: "clean" | "caution" | "risky" | null;
  /** Mofu's simulated sell failed, or its code matches known honeypots. */
  honeypot: boolean;
}

export interface DeployerReputation {
  creator: string;
  status: "ok" | "warn" | "risk";
  /** Other tokens this creator launched that Mofu knows of. */
  launches: number;
  /** How many of those Mofu has scanned, and what it found. */
  scanned: number;
  honeypots: number;
  risky: number;
  caution: number;
  clean: number;
  /** Of the recent launches looked at, how many had no activity in the last 7 days. */
  quiet: number | null;
  quietOf: number | null;
  /** A few of the other launches, honeypots first. */
  tokens: DeployerToken[];
  detail: string;
}

/** A wallet that bought in the launch window. */
export interface LaunchBuyer {
  address: string;
  /** Seconds after the token's first transaction. */
  seconds: number;
  /** Share of the supply it bought in the window, 0–100. */
  boughtPercent: number;
  /** Share it holds now, 0–100; null when it couldn't be read. */
  holdPercent: number | null;
  /** Who sent this wallet its first ETH, when it was looked up. */
  funder: string | null;
  contract: boolean;
}

/** Wallets tied together: funded by the same wallet, or bought for by the same sender. */
export interface LaunchGroup {
  via: string;
  kind: "creator" | "funder" | "sender";
  wallets: string[];
  /** What the group holds now, 0–100 of the supply. */
  holdPercent: number;
}

export interface LaunchActivity {
  status: "ok" | "warn" | "risk";
  /** Seconds of trading looked at, from the token's first transaction. */
  windowSeconds: number;
  /** Distinct wallets that bought in the window, the creator left out. */
  buyers: number;
  /** Of those, bought within the first 3 seconds (almost always bots). */
  snipers: number;
  /** Share of the supply the early buyers bought, and what they still hold, 0–100. */
  boughtPercent: number;
  holdPercent: number | null;
  /** What the creator bought in the window, 0–100. */
  creatorBoughtPercent: number;
  /** Most distinct buyers in one block. */
  sameBlock: number;
  groups: LaunchGroup[];
  /** The biggest early buyers. */
  top: LaunchBuyer[];
  detail: string;
}

/** Same code as tokens that turned out to be honeypots. */
export interface CodeMatch {
  /** Tokens with this code whose simulated sell failed. */
  flagged: number;
  /** Tokens with this code whose simulated sell passed. */
  passed: number;
  /** A few of the flagged ones. */
  examples: Array<{ address: string; symbol: string | null }>;
}

export interface TokenLookalike {
  address: string;
  name: string | null;
  symbol: string | null;
  /** When its first transaction happened, if known. */
  createdAt: string | null;
}

/** What Mofu can say about an address without guessing. */
export interface AddressInfo {
  address: string;
  kind: "wallet" | "burn" | "token" | "curve" | "pool" | "contract";
  /** A name: from Mofu's list of known contracts, or read from the chain (token name, pool pair). */
  label: string | null;
  /** True when the label comes from Mofu's own list. */
  known: boolean;
  txCount: number | null;
  firstSeen: string | null;
  ageDays: number | null;
}

export interface WalletApproval {
  token: string;
  tokenName: string | null;
  tokenSymbol: string | null;
  /** Whole tokens the wallet holds now, when known. */
  balance: string | null;
  spender: AddressInfo;
  unlimited: boolean;
  /** Whole tokens the spender may take ("unlimited" when unlimited). */
  allowance: string;
  approvedAt: string | null;
  txHash: string | null;
  risk: "ok" | "warn" | "risk";
  reasons: string[];
}

/** An approval for a whole NFT collection (setApprovalForAll), re-checked on the chain. */
export interface WalletNftApproval {
  collection: string;
  name: string | null;
  symbol: string | null;
  operator: AddressInfo;
  approvedAt: string | null;
  txHash: string | null;
  risk: "ok" | "warn" | "risk";
  reasons: string[];
}

export interface WalletHolding {
  token: string;
  name: string | null;
  symbol: string | null;
  /** Whole tokens, formatted. */
  balance: string;
}

/** A transfer someone else made to plant a lookalike address in a wallet's history. */
export interface PoisonAlert {
  /** The lookalike (the scammer's address). */
  address: string;
  /** The real address it imitates: one the wallet sent to, or the wallet itself. Null when there's no twin. */
  resembles: string | null;
  resemblesSelf: boolean;
  /** "dust": a tiny transfer from the lookalike. "zero-transfer": a 0-token transfer the wallet never sent. */
  kind: "dust" | "zero-transfer";
  token: string | null;
  tokenSymbol: string | null;
  txHash: string;
  at: string | null;
  risk: "risk" | "warn";
}

/** Wallet Health: what a wallet holds and which approvals it has given. */
export interface WalletReport {
  address: string;
  isContract: boolean;
  /** ETH balance, formatted. */
  eth: string | null;
  holdings: WalletHolding[];
  holdingsTotal: number;
  approvals: WalletApproval[];
  /** Approvals for whole NFT collections that are still on. */
  nftApprovals?: WalletNftApproval[];
  /** Lookalike addresses planted in the wallet's recent history (address poisoning). */
  poisoning: PoisonAlert[];
  status: { holdings: "ok" | "unavailable"; approvals: "ok" | "unavailable" };
  checkedAt: string;
  limits: string[];
}

export interface WalletResponse {
  report: WalletReport;
  remaining: number;
  limit: number;
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
  /** Other tokens the creator launched through the same launcher, in its latest transactions (up to 20). */
  otherLaunches: string[];
  otherLaunchCount: number;
  /** A closer look at up to five of those launches. */
  otherLaunchDetails: LaunchHistory[];
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

/** One of the creator's other launches, and whether it still sees any activity. */
export interface LaunchHistory {
  address: string;
  name: string | null;
  symbol: string | null;
  lastActive: string | null;
  /** Any transaction in the last seven days. */
  active: boolean;
}
