/**
 * Token timeline: what Mofu has seen happen to a token across its scans. Each full scan leaves a
 * small snapshot; the next scan compares against it and records what changed (verdict, owner,
 * supply, graduation, liquidity, the sell test). The launch itself comes from the creation
 * transaction. Times are when Mofu noticed a change, except the launch.
 */
import type { TimelineEvent, TokenScanReport } from "../shared/api.js";
import type { TokenIndex } from "./stats.js";

export const TIMELINE_MAX = 40;

export interface TokenSnapshot {
  verdict: TokenScanReport["verdict"];
  ownerStatus: TokenScanReport["owner"]["status"];
  owner: string | null;
  /** Whole tokens. */
  supply: string | null;
  graduated: boolean;
  /** ETH on the curve or in the pool. */
  eth: number | null;
  sell: "passed" | "failed" | null;
}

export function snapshotOf(r: TokenScanReport): TokenSnapshot {
  return {
    verdict: r.verdict,
    ownerStatus: r.owner.status,
    owner: r.owner.address,
    supply: r.token.totalSupply,
    graduated: r.liquidity?.kind === "graduated",
    eth: r.liquidity?.eth ?? null,
    sell:
      r.sellTest?.status === "passed"
        ? "passed"
        : r.sellTest?.status === "failed"
          ? "failed"
          : null,
  };
}

const short = (a: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "none");
const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : Number(n.toFixed(n >= 1 ? 2 : 4)).toString());
const big = (s: string) => {
  try {
    return BigInt(s);
  } catch {
    return null;
  }
};

/** Events between two snapshots of the same token. Pure. */
export function changes(prev: TokenSnapshot, next: TokenSnapshot, at: string): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  const ev = (kind: TimelineEvent["kind"], text: string, level: TimelineEvent["level"]) =>
    out.push({ at, kind, text, level, tx: null });
  if (prev.verdict !== next.verdict) {
    const worse =
      ["clean", "caution", "risky"].indexOf(next.verdict) >
      ["clean", "caution", "risky"].indexOf(prev.verdict);
    ev(
      "verdict",
      `Mofu's verdict changed from ${prev.verdict} to ${next.verdict}.`,
      worse ? (next.verdict === "risky" ? "risk" : "warn") : "ok",
    );
  }
  if (prev.ownerStatus !== next.ownerStatus || (prev.owner ?? "") !== (next.owner ?? "")) {
    if (next.ownerStatus === "renounced") ev("owner", "Ownership was renounced.", "ok");
    else if (next.ownerStatus === "active" && prev.ownerStatus !== "active")
      ev("owner", `An owner was set: ${short(next.owner)}.`, "warn");
    else if (next.ownerStatus === "active")
      ev("owner", `The owner changed from ${short(prev.owner)} to ${short(next.owner)}.`, "warn");
  }
  if (prev.supply && next.supply && prev.supply !== next.supply) {
    const a = big(prev.supply),
      b = big(next.supply);
    if (a !== null && b !== null)
      ev(
        "supply",
        b > a
          ? `Total supply went up from ${a.toLocaleString("en-US")} to ${b.toLocaleString("en-US")}: new tokens were minted.`
          : `Total supply went down from ${a.toLocaleString("en-US")} to ${b.toLocaleString("en-US")}.`,
        b > a ? "risk" : "info",
      );
  }
  if (!prev.graduated && next.graduated)
    ev("graduated", "It graduated from the launch curve to a Uniswap v4 pool.", "ok");
  else if (prev.eth !== null && next.eth !== null && prev.eth >= 0.01 && !next.graduated) {
    const drop = (prev.eth - next.eth) / prev.eth;
    if (drop >= 0.3)
      ev(
        "liquidity",
        `ETH liquidity fell ${Math.round(drop * 100)}%, from ${fmt(prev.eth)} to ${fmt(next.eth)} ETH.`,
        drop >= 0.6 ? "risk" : "warn",
      );
  }
  if (prev.sell && next.sell && prev.sell !== next.sell)
    ev(
      "sell",
      next.sell === "failed"
        ? "Mofu's simulated sell started failing."
        : "Mofu's simulated sell works again.",
      next.sell === "failed" ? "risk" : "ok",
    );
  return out;
}

export type StoredSnapshot = TokenSnapshot & {
  /** A different verdict seen once, waiting for the next scan to confirm it. */
  pending: TokenSnapshot["verdict"] | null;
};

/**
 * One scan's step: the events to record and the snapshot to keep. A verdict change has to show
 * up on two scans in a row, so a lookup that failed once doesn't write history. Pure.
 */
export function step(
  prev: StoredSnapshot | null,
  next: TokenSnapshot,
  at: string,
): { events: TimelineEvent[]; stored: StoredSnapshot } {
  if (!prev) return { events: [], stored: { ...next, pending: null } };
  const held = next.verdict !== prev.verdict && prev.pending !== next.verdict;
  const stored: StoredSnapshot = held
    ? { ...next, verdict: prev.verdict, pending: next.verdict }
    : { ...next, pending: null };
  return { events: changes(prev, stored, at), stored };
}

/** The first events for a token Mofu hasn't seen before. Pure. */
export function firstEvents(r: TokenScanReport, at: string): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  if (r.origin?.createdAt)
    out.push({
      at: r.origin.createdAt,
      kind: "launched",
      text: `Launched by ${short(r.origin.creator)}${r.origin.launcher ? " on the Pons launchpad" : ""}.`,
      level: "info",
      tx: r.origin.creationTx,
    });
  out.push({
    at,
    kind: "first-scan",
    text: `First scanned by Mofu: ${r.verdict}.`,
    level: r.verdict === "clean" ? "ok" : r.verdict === "caution" ? "warn" : "risk",
    tx: null,
  });
  return out;
}

/** Adds this scan to the token's timeline and puts the timeline on the report. Never throws. */
export async function withTimeline(
  r: TokenScanReport,
  index: TokenIndex | null,
  now = Date.now(),
): Promise<TokenScanReport> {
  if (!r.isContract || !index?.observeToken) return r;
  const timeline = await index
    .observeToken(r.address, snapshotOf(r), firstEvents(r, new Date(now).toISOString()), now)
    .catch(() => null);
  return timeline ? { ...r, timeline } : r;
}
