/** Report shapes returned by Mofu's API (mofu.works/api/v1). */

export type Verdict = "clean" | "caution" | "risky";

export interface TokenCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "risk" | "info";
  detail: string;
}

/** The biggest single sale before the price drops 10%. */
export interface SellDepth {
  method: "simulated" | "reserves";
  /** ETH that sale returns; null when even the smallest size moved the price more than 10%. */
  ethAt10Percent: number | null;
  /** True when every size tried stayed under 10%: the real depth is bigger. */
  moreThan: boolean;
  steps: Array<{ supplyPercent: number | null; ethOut: number; impactPercent: number }>;
  detail: string;
}

/** A buy and a sell simulated on Robinhood Chain; nothing is sent. */
export interface SellTest {
  status: "passed" | "failed" | "unknown";
  method: "curve" | "transfer";
  venue: string;
  buyTaxPercent: number | null;
  sellTaxPercent: number | null;
  roundTripPercent: number | null;
  depth: SellDepth | null;
  detail: string;
}

/** Same code as tokens whose simulated sell failed. */
export interface CodeMatch {
  flagged: number;
  passed: number;
  examples: Array<{ address: string; symbol: string | null }>;
}

/** The creator's track record: other tokens they launched and what Mofu found in them. */
export interface DeployerReputation {
  creator: string;
  status: "ok" | "warn" | "risk";
  launches: number;
  scanned: number;
  honeypots: number;
  risky: number;
  caution: number;
  clean: number;
  quiet: number | null;
  quietOf: number | null;
  tokens: Array<{
    address: string;
    symbol: string | null;
    verdict: Verdict | null;
    honeypot: boolean;
  }>;
  detail: string;
}

/** Who bought in the first minute, whether they're linked, and what they still hold. */
export interface LaunchActivity {
  status: "ok" | "warn" | "risk";
  windowSeconds: number;
  buyers: number;
  snipers: number;
  boughtPercent: number;
  holdPercent: number | null;
  creatorBoughtPercent: number;
  sameBlock: number;
  groups: Array<{
    via: string;
    kind: "creator" | "funder" | "sender";
    wallets: string[];
    holdPercent: number;
  }>;
  top: Array<{
    address: string;
    seconds: number;
    boughtPercent: number;
    holdPercent: number | null;
    funder: string | null;
    contract: boolean;
  }>;
  detail: string;
}

export interface TokenReport {
  address: string;
  chainName: string;
  isContract: boolean;
  codeSize: number;
  token: {
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    totalSupply: string | null;
  };
  owner: {
    status: "none" | "renounced" | "active";
    address: string | null;
    holdsPercent: number | null;
  };
  proxy: { kind: "none" | "eip1967" | "beacon" | "minimal"; implementation: string | null };
  burnedPercent: number | null;
  checks: TokenCheck[];
  verdict: Verdict;
  distribution: {
    status: "full" | "summary" | "unavailable";
    top10Percent: number | null;
    largestWallet: { address: string; percent: number } | null;
    holders: Array<{
      address: string;
      balance: string;
      percent: number;
      kind: "wallet" | "contract" | "burn";
    }>;
  };
  sellTest: SellTest | null;
  lookalikes: Array<{
    address: string;
    name: string | null;
    symbol: string | null;
    createdAt: string | null;
  }>;
  fingerprint: string | null;
  codeMatch: CodeMatch | null;
  deployer?: DeployerReputation | null;
  launch?: LaunchActivity | null;
  limits: string[];
}

export interface AddressInfo {
  address: string;
  kind: "wallet" | "burn" | "token" | "curve" | "pool" | "contract";
  label: string | null;
  known: boolean;
  txCount: number | null;
  firstSeen: string | null;
  ageDays: number | null;
}

export interface WalletApproval {
  token: string;
  tokenName: string | null;
  tokenSymbol: string | null;
  balance: string | null;
  spender: AddressInfo;
  unlimited: boolean;
  allowance: string;
  approvedAt: string | null;
  txHash: string | null;
  risk: "ok" | "warn" | "risk";
  reasons: string[];
}

export interface WalletReport {
  address: string;
  isContract: boolean;
  eth: string | null;
  holdings: Array<{ token: string; name: string | null; symbol: string | null; balance: string }>;
  holdingsTotal: number;
  approvals: WalletApproval[];
  /** Lookalike addresses planted in the wallet's recent history (address poisoning). */
  poisoning: PoisonAlert[];
  status: { holdings: "ok" | "unavailable"; approvals: "ok" | "unavailable" };
  checkedAt: string;
  limits: string[];
}

/** A transfer someone else made to plant a lookalike address in a wallet's history. */
export interface PoisonAlert {
  address: string;
  /** The real address it imitates (one the wallet sent to, or the wallet itself). */
  resembles: string | null;
  resemblesSelf: boolean;
  kind: "dust" | "zero-transfer";
  token: string | null;
  tokenSymbol: string | null;
  txHash: string;
  at: string | null;
  risk: "risk" | "warn";
}

/** A report plus where to see it and how many calls are left today. */
export interface Checked<T> {
  report: T;
  url: string;
  remaining: number;
  limit: number;
}

export const WEBHOOK_EVENTS = [
  "owner_changed",
  "supply_changed",
  "upgraded",
  "pause_changed",
  "liquidity_dropped",
  "verdict_changed",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export interface Webhook {
  id: string;
  url: string;
  tokens: string[];
  events: WebhookEventType[];
  createdAt: string;
  status: "active" | "disabled";
  disabledAt: string | null;
  failures: number;
  delivered: number;
  lastDeliveryAt: string | null;
  lastResult: string | null;
  /** In a status lookup: when Mofu last read each token. */
  watching?: Array<{
    address: string;
    symbol: string | null;
    verdict: Verdict | null;
    lastChecked: string | null;
    lastScanned: string | null;
  }>;
}

/** What Mofu POSTs to a webhook URL. */
export interface WebhookEvent {
  id: string;
  type: WebhookEventType | "ping" | "test";
  createdAt: string;
  token: { address: string; name: string | null; symbol: string | null } | null;
  summary: string;
  before: unknown;
  after: unknown;
  report: string | null;
  webhook: string;
}
