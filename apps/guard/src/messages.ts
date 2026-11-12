/** Shapes shared by the content script, the background worker and the popup. */

export interface GuardSettings {
  /** Stop and show signing requests. */
  protection: boolean;
  /** Scan tooltip when hovering a contract address. */
  hover: boolean;
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
