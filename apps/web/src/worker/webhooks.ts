/**
 * Webhooks: Mofu watches a few tokens and POSTs to a URL when something about one changes.
 *
 * Pure helpers here (URL rules, signing, the on-chain snapshot and what counts as a change);
 * the WebhookStore Durable Object keeps the hooks and runs the checks on an alarm.
 */
import type { TokenScanReport } from "../shared/api.js";
import { callOf, type BatchCall, type BatchResult } from "./chain.js";
import { WETH } from "./known.js";

export const WEBHOOK_EVENTS = [
  "owner_changed",
  "supply_changed",
  "upgraded",
  "pause_changed",
  "liquidity_dropped",
  "verdict_changed",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

/** A token can be in at most this many hooks' lists; these bound the work per check. */
export const MAX_TOKENS_PER_HOOK = 10;
export const MAX_HOOKS = 200;
export const MAX_WATCHED_TOKENS = 60;
/** Consecutive failed deliveries before a hook is switched off. */
export const MAX_FAILURES = 20;
/** Disabled hooks are deleted after this long. */
export const DISABLED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How often the cheap on-chain checks run, and how often each token gets a full re-scan. */
export const POLL_INTERVAL_MS = 5 * 60 * 1000;
export const RESCAN_INTERVAL_MS = 3 * 60 * 60 * 1000;
/** Tokens read per check (5 calls each, 25 calls per batch). */
export const POLL_PER_RUN = 30;
/** ETH-side liquidity must fall at least this much between two checks to count. */
export const LIQUIDITY_DROP = 0.3;
/** …and only when there was at least this much to begin with (0.01 ETH). */
export const LIQUIDITY_MIN_WEI = 10n ** 16n;

export interface StoredHook {
  id: string;
  url: string;
  /** The signing secret; also what the owner uses to manage the hook. */
  secret: string;
  tokens: string[];
  events: WebhookEventType[];
  createdAt: string;
  status: "active" | "disabled";
  disabledAt: string | null;
  failures: number;
  delivered: number;
  lastDeliveryAt: string | null;
  /** HTTP status of the last delivery, or a short error. */
  lastResult: string | null;
}

/** What the owner sees about a hook (never the secret). */
export type PublicHook = Omit<StoredHook, "secret"> & {
  /** When Mofu last read each token (only in a status lookup). */
  watching?: Array<{
    address: string;
    symbol: string | null;
    verdict: TokenScanReport["verdict"] | null;
    lastChecked: string | null;
    lastScanned: string | null;
  }>;
};
export const publicHook = ({ secret: _secret, ...rest }: StoredHook): PublicHook => rest;

/** What Mofu last saw on chain for a watched token. */
export interface TokenSnapshot {
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  owner: string | null;
  /** Raw total supply, decimal string. */
  supply: string | null;
  /** EIP-1967 implementation address, when the slot is set. */
  implementation: string | null;
  paused: boolean | null;
  /** Where it trades: the launch curve or a pool, from the last full scan. */
  venue: string | null;
  venueKind: "curve" | "pool" | null;
  /** ETH on the curve, or WETH in the pool, in wei. */
  liquidity: string | null;
  verdict: TokenScanReport["verdict"] | null;
  /** A different verdict seen once, waiting for the next scan to confirm it. */
  pendingVerdict: TokenScanReport["verdict"] | null;
  polledAt: number;
  scannedAt: number;
}

export const emptySnapshot = (address: string): TokenSnapshot => ({
  address,
  name: null,
  symbol: null,
  decimals: null,
  owner: null,
  supply: null,
  implementation: null,
  paused: null,
  venue: null,
  venueKind: null,
  liquidity: null,
  verdict: null,
  pendingVerdict: null,
  polledAt: 0,
  scannedAt: 0,
});

export interface WebhookEvent {
  id: string;
  type: WebhookEventType | "ping" | "test";
  createdAt: string;
  token: { address: string; name: string | null; symbol: string | null } | null;
  /** One sentence a person can read. */
  summary: string;
  before: unknown;
  after: unknown;
  report: string | null;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** Hostnames a webhook may not point at. Workers can't reach private networks anyway. */
const BLOCKED_HOST =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home|.*\.arpa|metadata\.google\.internal)$/i;

/** Returns the cleaned URL, or a message saying what's wrong with it. */
export function checkWebhookUrl(input: unknown): { url: string } | { error: string } {
  if (typeof input !== "string" || input.length > 500) {
    return { error: "url must be an https:// address of at most 500 characters." };
  }
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return { error: "url isn't a valid address." };
  }
  if (u.protocol !== "https:") return { error: "url must start with https://" };
  if (u.username || u.password) return { error: "url can't contain a username or password." };
  if (u.port && u.port !== "443") return { error: "url must use the standard https port." };
  const host = u.hostname.toLowerCase();
  // IP literals (v4 or v6) and single-label names aren't allowed: a webhook needs a real domain.
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) {
    return { error: "url must use a domain name, not an IP address." };
  }
  if (!host.includes(".") || BLOCKED_HOST.test(host)) {
    return { error: "url must be a public domain, not localhost or a local network name." };
  }
  u.hash = "";
  return { url: u.toString() };
}

export const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

export const newHookId = () => `wh_${randomHex(12)}`;
export const newSecret = () => `whsec_${randomHex(24)}`;

/** HMAC-SHA256 of `${timestamp}.${body}`, hex. Receivers recompute it with their secret. */
export async function signPayload(secret: string, timestamp: number, body: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares two secrets without leaking where they differ. */
export function sameSecret(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface DeliveryResult {
  ok: boolean;
  /** HTTP status as text, or a short reason. */
  result: string;
}

/** POSTs one event, signed. Redirects aren't followed; only a 2xx answer counts. */
export async function deliver(
  fetchFn: typeof fetch,
  hook: Pick<StoredHook, "id" | "url" | "secret">,
  event: WebhookEvent,
  now: number,
): Promise<DeliveryResult> {
  const body = JSON.stringify({ ...event, webhook: hook.id });
  const t = Math.floor(now / 1000);
  try {
    const res = await fetchFn(hook.url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mofu-Webhooks/1 (+https://mofu.works/docs/#webhooks)",
        "Mofu-Event": event.type,
        "Mofu-Delivery": event.id,
        "Mofu-Signature": `t=${t},v1=${await signPayload(hook.secret, t, body)}`,
      },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    await res.body?.cancel().catch(() => undefined);
    return { ok: res.status >= 200 && res.status < 300, result: String(res.status) };
  } catch (err) {
    return {
      ok: false,
      result: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "unreachable",
    };
  }
}

const pad = (addr: string) => addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** The cheap reads for one token: owner, supply, implementation slot, paused, liquidity. */
export function snapshotCalls(s: TokenSnapshot): BatchCall[] {
  const calls: BatchCall[] = [
    callOf(s.address, "0x8da5cb5b"), // owner()
    callOf(s.address, "0x18160ddd"), // totalSupply()
    { method: "eth_getStorageAt", params: [s.address, IMPL_SLOT, "latest"] },
    callOf(s.address, "0x5c975abb"), // paused()
  ];
  if (s.venue && s.venueKind === "curve")
    calls.push({ method: "eth_getBalance", params: [s.venue, "latest"] });
  else if (s.venue && s.venueKind === "pool") calls.push(callOf(WETH, `0x70a08231${pad(s.venue)}`)); // WETH.balanceOf(pool)
  return calls;
}

const word = (hex: BatchResult): bigint | null => {
  if (!hex || !/^0x[0-9a-f]+$/i.test(hex) || hex.length < 3) return null;
  try {
    return BigInt(hex.length > 66 ? `0x${hex.slice(2, 66)}` : hex);
  } catch {
    return null;
  }
};
const asAddress = (hex: BatchResult): string | null => {
  const n = word(hex);
  return n === null ? null : `0x${n.toString(16).padStart(40, "0").slice(-40)}`;
};

/** Applies the answers of snapshotCalls. A read that didn't come back keeps the old value. */
export function applySnapshot(s: TokenSnapshot, out: BatchResult[], now: number): TokenSnapshot {
  const [owner, supply, impl, paused, liquidity] = out;
  const implAddr = asAddress(impl ?? null);
  const supplyN = word(supply ?? null);
  const pausedN = word(paused ?? null);
  const liqN = word(liquidity ?? null);
  return {
    ...s,
    owner: asAddress(owner ?? null) ?? s.owner,
    supply: supplyN !== null ? supplyN.toString() : s.supply,
    implementation: impl ? (implAddr === ZERO ? null : implAddr) : s.implementation,
    paused: pausedN !== null ? pausedN !== 0n : s.paused,
    liquidity: s.venue && liqN !== null ? liqN.toString() : s.liquidity,
    polledAt: now,
  };
}

/** Takes what a full scan knows: name, venue for the liquidity read, and the verdict. */
export function applyScan(s: TokenSnapshot, r: TokenScanReport, now: number): TokenSnapshot {
  const test = r.sellTest;
  const venueKind = test ? (test.method === "curve" ? "curve" : "pool") : s.venueKind;
  const venue = test ? test.venue.toLowerCase() : s.venue;
  return {
    ...s,
    name: r.token.name ?? s.name,
    symbol: r.token.symbol ?? s.symbol,
    decimals: r.token.decimals ?? s.decimals,
    venue,
    venueKind,
    // A new venue (graduated to a pool) starts a fresh liquidity baseline.
    liquidity: venue === s.venue ? s.liquidity : null,
    scannedAt: now,
  };
}

const short = (a: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "none");
const tokenLabel = (s: TokenSnapshot) =>
  s.symbol ? `$${s.symbol}` : s.name ? s.name : short(s.address);

export function formatUnits(raw: string, decimals: number | null): string {
  const d = decimals ?? 18;
  const n = BigInt(raw);
  const whole = n / 10n ** BigInt(d);
  const frac = d > 0 ? (n % 10n ** BigInt(d)).toString().padStart(d, "0").slice(0, 4) : "";
  const fracTrim = frac.replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fracTrim ? `.${fracTrim}` : ""}`;
}

export type Change = Omit<WebhookEvent, "id" | "createdAt" | "token" | "report">;

/** What changed between two cheap reads of the same token. Only values read both times count. */
export function cheapChanges(prev: TokenSnapshot, next: TokenSnapshot): Change[] {
  const out: Change[] = [];
  const label = tokenLabel(next);
  if (prev.polledAt === 0) return out; // first read: nothing to compare with
  if (prev.owner && next.owner && prev.owner !== next.owner) {
    const gone = next.owner === ZERO || next.owner === DEAD;
    out.push({
      type: "owner_changed",
      summary: gone
        ? `${label}: ownership was renounced (owner is now ${short(next.owner)}).`
        : `${label}: the owner changed from ${short(prev.owner)} to ${short(next.owner)}.`,
      before: prev.owner,
      after: next.owner,
    });
  }
  if (prev.supply && next.supply && prev.supply !== next.supply) {
    const up = BigInt(next.supply) > BigInt(prev.supply);
    out.push({
      type: "supply_changed",
      summary: `${label}: total supply ${up ? "went up" : "went down"} from ${formatUnits(prev.supply, next.decimals)} to ${formatUnits(next.supply, next.decimals)}${up ? " (new tokens were minted)" : ""}.`,
      before: prev.supply,
      after: next.supply,
    });
  }
  if (prev.implementation !== next.implementation && prev.polledAt > 0) {
    // Only a change from one known value to another: a missing read keeps the old value.
    out.push({
      type: "upgraded",
      summary: `${label}: the contract's code was swapped (implementation ${short(prev.implementation)} → ${short(next.implementation)}).`,
      before: prev.implementation,
      after: next.implementation,
    });
  }
  if (prev.paused !== null && next.paused !== null && prev.paused !== next.paused) {
    out.push({
      type: "pause_changed",
      summary: next.paused
        ? `${label}: transfers were paused.`
        : `${label}: transfers were unpaused.`,
      before: prev.paused,
      after: next.paused,
    });
  }
  if (
    prev.venue &&
    prev.venue === next.venue &&
    prev.liquidity &&
    next.liquidity &&
    BigInt(prev.liquidity) >= LIQUIDITY_MIN_WEI
  ) {
    const before = BigInt(prev.liquidity);
    const after = BigInt(next.liquidity);
    // drop share in basis points, so the comparison stays in integers
    const dropBp = Number(((before - after) * 10_000n) / before);
    if (dropBp >= LIQUIDITY_DROP * 10_000) {
      const where =
        next.venueKind === "curve"
          ? "ETH on its launch curve (heavy selling, or the token graduated to a pool)"
          : "WETH in its pool";
      out.push({
        type: "liquidity_dropped",
        summary: `${label}: ${where} fell ${(dropBp / 100).toFixed(1)}%, from ${formatUnits(prev.liquidity, 18)} to ${formatUnits(next.liquidity, 18)} ETH.`,
        before: prev.liquidity,
        after: next.liquidity,
      });
    }
  }
  return out;
}

/**
 * A full scan's verdict. A different verdict has to show up on two scans in a row before it's
 * sent, so one flaky lookup can't fire an alert.
 */
export function verdictStep(
  s: TokenSnapshot,
  verdict: TokenScanReport["verdict"],
): { snapshot: TokenSnapshot; change: Change | null; confirmSoon: boolean } {
  if (s.verdict === null)
    return { snapshot: { ...s, verdict, pendingVerdict: null }, change: null, confirmSoon: false };
  if (verdict === s.verdict)
    return { snapshot: { ...s, pendingVerdict: null }, change: null, confirmSoon: false };
  if (s.pendingVerdict !== verdict)
    return { snapshot: { ...s, pendingVerdict: verdict }, change: null, confirmSoon: true };
  return {
    snapshot: { ...s, verdict, pendingVerdict: null },
    change: {
      type: "verdict_changed",
      summary: `${tokenLabel(s)}: Mofu's verdict changed from ${s.verdict} to ${verdict}.`,
      before: s.verdict,
      after: verdict,
    },
    confirmSoon: false,
  };
}

export const tokenRef = (s: TokenSnapshot) => ({
  address: s.address,
  name: s.name,
  symbol: s.symbol,
});
