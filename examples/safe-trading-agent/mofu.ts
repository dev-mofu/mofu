/**
 * Mofu client and the buy rule: ask Mofu about a token, then decide whether the agent may buy it.
 * No dependencies; Node 22.18+ runs this file directly.
 */

export type Verdict = "clean" | "caution" | "risky";

export interface TokenReport {
  address: string;
  isContract: boolean;
  token: { name: string | null; symbol: string | null };
  verdict: Verdict;
  checks: Array<{
    id: string;
    label: string;
    status: "ok" | "warn" | "risk" | "info";
    detail: string;
  }>;
  sellTest: {
    status: "passed" | "failed" | "unknown";
    buyTaxPercent: number | null;
    sellTaxPercent: number | null;
    roundTripPercent: number | null;
  } | null;
  lookalikes: Array<{ address: string }>;
}

/** What the agent refuses. Tighten or loosen it here, in one place. */
export interface Policy {
  /** Verdicts that block a buy. */
  blockVerdicts: Verdict[];
  /** Block when Mofu couldn't simulate a sell (no curve or pool found). */
  requireSellTest: boolean;
  maxBuyTaxPercent: number;
  maxSellTaxPercent: number;
  /** Block when another token Mofu has seen uses the same name or ticker. */
  blockLookalikes: boolean;
}

export const DEFAULT_POLICY: Policy = {
  blockVerdicts: ["risky"],
  requireSellTest: true,
  maxBuyTaxPercent: 10,
  maxSellTaxPercent: 10,
  blockLookalikes: false,
};

export interface Decision {
  allowed: boolean;
  /** Why it was blocked; empty when allowed. */
  reasons: string[];
  report: TokenReport | null;
}

/** Applies a policy to a Mofu report. Pure, so it's easy to test and to change. */
export function decide(r: TokenReport, policy: Policy = DEFAULT_POLICY): Decision {
  const reasons: string[] = [];
  if (!r.isContract) reasons.push("not a token contract");
  if (policy.blockVerdicts.includes(r.verdict)) reasons.push(`Mofu's verdict is ${r.verdict}`);
  for (const c of r.checks) if (c.status === "risk") reasons.push(`${c.label}: ${c.detail}`);
  const t = r.sellTest;
  if (t?.status === "failed") reasons.push("a simulated sell failed (possible honeypot)");
  else if (!t || t.status !== "passed") {
    if (policy.requireSellTest) reasons.push("Mofu couldn't test selling it");
  } else {
    if ((t.buyTaxPercent ?? 0) > policy.maxBuyTaxPercent)
      reasons.push(`buy tax ${t.buyTaxPercent}% is over ${policy.maxBuyTaxPercent}%`);
    if ((t.sellTaxPercent ?? 0) > policy.maxSellTaxPercent)
      reasons.push(`sell tax ${t.sellTaxPercent}% is over ${policy.maxSellTaxPercent}%`);
  }
  if (policy.blockLookalikes && r.lookalikes.length)
    reasons.push(`${r.lookalikes.length} other token(s) use the same name or ticker`);
  return { allowed: reasons.length === 0, reasons: [...new Set(reasons)], report: r };
}

export class MofuError extends Error {}

const BASE = (process.env.MOFU_API_URL ?? "https://mofu.works").replace(/\/+$/, "");
const cache = new Map<string, { at: number; report: TokenReport }>();
/** Reuse a report for this long: the free API allows 50 calls a day per IP. */
const CACHE_MS = 10 * 60 * 1000;

export async function scanToken(
  address: string,
  fetchFn: typeof fetch = fetch,
): Promise<TokenReport> {
  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.report;
  const res = await fetchFn(`${BASE}/api/v1/token/${key}`, {
    headers: { Accept: "application/json", "User-Agent": "mofu-safe-agent/0.1" },
    signal: AbortSignal.timeout(90_000),
  });
  const body = (await res.json().catch(() => null)) as {
    report?: TokenReport;
    error?: { message?: string };
  } | null;
  if (!res.ok || !body?.report)
    throw new MofuError(body?.error?.message ?? `Mofu answered HTTP ${res.status}`);
  cache.set(key, { at: Date.now(), report: body.report });
  return body.report;
}

/**
 * The one gate every buy goes through. If Mofu can't be reached, the answer is no:
 * an agent that buys when its safety check is down isn't checking anything.
 */
export async function checkBeforeBuy(
  address: string,
  policy: Policy = DEFAULT_POLICY,
  fetchFn: typeof fetch = fetch,
): Promise<Decision> {
  try {
    return decide(await scanToken(address, fetchFn), policy);
  } catch (err) {
    return {
      allowed: false,
      reasons: [`no answer from Mofu: ${(err as Error).message}`],
      report: null,
    };
  }
}
