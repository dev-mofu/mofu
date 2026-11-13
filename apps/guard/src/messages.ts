/** Shapes shared by the content script, the background worker and the popup. */

export interface GuardSettings {
  /** Stop and show signing requests. */
  protection: boolean;
  /** Scan tooltip when hovering a contract address. */
  hover: boolean;
  /** Verdict labels next to contract addresses in posts on X. */
  xLabels: boolean;
  /** Show the simulated result of every contract call on Robinhood Chain, not only risky ones. */
  preview: boolean;
}

/** What Mofu's /api/guard/check returns for one address (Robinhood Chain). */
export interface ScanSummary {
  address: string;
  isContract: boolean;
  name: string | null;
  symbol: string | null;
  verdict: "clean" | "caution" | "risky";
  /** Details of the checks that weren't ok. */
  risks: string[];
}

export const API = "https://mofu.works";
