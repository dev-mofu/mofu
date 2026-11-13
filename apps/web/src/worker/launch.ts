/**
 * Launch window: who bought in the token's first minute, whether those wallets are tied together
 * (funded by the same wallet, bought for by the same sender, or by the creator), and what they
 * still hold. Buyers come from the token's first 100 transactions on GoldRush; holdings from live
 * balanceOf calls. The buyer list never changes once the window has passed, so it's kept and only
 * holdings are re-read on later scans. Deterministic; no model.
 */
import type {
  LaunchActivity,
  LaunchBuyer,
  LaunchGroup,
  TokenCheck,
  TokenScanReport,
} from "../shared/api.js";
import { callOf, rpcBatch } from "./chain.js";
import {
  earliestTransactions,
  transactionCount,
  type ChainDataOptions,
  type TxItem,
} from "./chain-data.js";
import { deployerCheck, deployerReputation } from "./deployer.js";
import type { LaunchCache, TokenIndex } from "./stats.js";

/** Seconds of trading looked at, from the token's first transaction. */
export const WINDOW_S = 60;
/** Buys this soon after launch are almost always bots. */
const SNIPE_S = 3;
const MAX_BUYERS = 40;
/** Funding is looked up for at most this many still-holding wallets per token. */
const FUND_LOOKUPS = 8;
/** A funder with more transactions than this is a service (exchange, bridge, faucet), not a person. */
const SERVICE_TXS = 5000;
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (part: bigint, total: bigint) =>
  total > 0n ? Number((part * 1_000_000n) / total) / 10_000 : 0;
const fmt = (n: number) => `${Number(n.toFixed(2))}%`;

type Ev = NonNullable<TxItem["log_events"]>[number];
const param = (e: Ev, name: string) => e.decoded?.params?.find((p) => p.name === name)?.value;

/**
 * Reads the launch window from the token's first transactions (oldest first). The venue is the
 * curve or pool tokens are bought from; when unknown, the address that sent tokens out most often.
 */
export function launchWindow(
  token: string,
  txs: TxItem[],
  venueHint: string | null,
  creator: string | null,
): LaunchCache | null {
  const tk = token.toLowerCase();
  const t0 = Date.parse(txs[0]?.block_signed_at ?? "");
  if (!Number.isFinite(t0)) return null;
  const rows: Array<{
    tx: TxItem;
    sec: number;
    net: Map<string, bigint>;
    out: Map<string, bigint>;
  }> = [];
  for (const tx of txs) {
    const sec = (Date.parse(tx.block_signed_at ?? "") - t0) / 1000;
    if (!(sec <= WINDOW_S)) break;
    const net = new Map<string, bigint>();
    const out = new Map<string, bigint>();
    for (const e of tx.log_events ?? []) {
      if (e.sender_address?.toLowerCase() !== tk || e.decoded?.name !== "Transfer") continue;
      const raw = String(param(e, "value") ?? "");
      if (!/^\d+$/.test(raw)) continue;
      const v = BigInt(raw);
      const from = String(param(e, "from") ?? "").toLowerCase();
      const to = String(param(e, "to") ?? "").toLowerCase();
      if (from !== ZERO) {
        net.set(from, (net.get(from) ?? 0n) - v);
        out.set(from, (out.get(from) ?? 0n) + v);
      }
      net.set(to, (net.get(to) ?? 0n) + v);
    }
    rows.push({ tx, sec, net, out });
  }
  let venue = venueHint?.toLowerCase() ?? null;
  if (!venue) {
    const sends = new Map<string, number>();
    for (const r of rows) for (const a of r.out.keys()) sends.set(a, (sends.get(a) ?? 0) + 1);
    venue = [...sends.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }
  const skip = new Set([ZERO, DEAD, tk, venue ?? ""]);
  const me = creator?.toLowerCase() ?? null;
  const buyers = new Map<string, LaunchCache["buyers"][number]>();
  const perBlock = new Map<number, Set<string>>();
  let creatorBought = 0n;
  for (const r of rows) {
    if (!venue || !((r.out.get(venue) ?? 0n) > 0n)) continue;
    for (const [a, d] of r.net) {
      if (d <= 0n || skip.has(a)) continue;
      if (a === me) {
        creatorBought += d;
        continue;
      }
      const block = r.tx.block_height ?? -1;
      perBlock.set(block, (perBlock.get(block) ?? new Set()).add(a));
      const b = buyers.get(a);
      if (b) b.bought = (BigInt(b.bought) + d).toString();
      else if (buyers.size < MAX_BUYERS)
        buyers.set(a, {
          address: a,
          seconds: Math.max(0, Math.round(r.sec * 10) / 10),
          bought: d.toString(),
          sender: r.tx.from_address?.toLowerCase() ?? a,
          contract: false,
        });
    }
  }
  const last = rows.at(-1)?.sec ?? 0;
  return {
    startedAt: new Date(t0).toISOString(),
    // A full first page that ends inside the minute only covers that long.
    windowSeconds: txs.length >= 100 && rows.length === txs.length ? Math.ceil(last) : WINDOW_S,
    sameBlock: Math.max(0, ...[...perBlock.values()].map((s) => s.size)),
    creatorBought: creatorBought.toString(),
    buyers: [...buyers.values()],
  };
}

/** Turns the window, live holdings and funder facts into the report section. Pure. */
export function launchActivity(
  cache: LaunchCache,
  holds: Map<string, bigint | null>,
  supply: bigint,
  creator: string | null,
  /** Transaction counts of funders shared by several buyers (services get left out). */
  funderTxs: Map<string, number | null>,
): LaunchActivity {
  const me = creator?.toLowerCase() ?? null;
  const hold = (a: string) => holds.get(a) ?? null;
  const buyers: LaunchBuyer[] = cache.buyers.map((b) => {
    const h = hold(b.address);
    return {
      address: b.address,
      seconds: b.seconds,
      boughtPercent: pct(BigInt(b.bought), supply),
      holdPercent: h === null ? null : pct(h, supply),
      funder: b.funder ?? null,
      contract: b.contract,
    };
  });
  const sumHold = (list: string[]) =>
    pct(
      list.reduce((n, a) => n + (hold(a) ?? 0n), 0n),
      supply,
    );
  const known = buyers.some((b) => b.holdPercent !== null);
  const holdPercent = known ? sumHold(buyers.map((b) => b.address)) : null;
  const snipers = buyers.filter((b) => b.seconds <= SNIPE_S);

  // Groups: by the creator, by a shared funder, by a shared sender.
  const groups: LaunchGroup[] = [];
  const byCreator = me
    ? cache.buyers.filter((b) => b.funder === me || b.sender === me).map((b) => b.address)
    : [];
  if (byCreator.length)
    groups.push({ via: me!, kind: "creator", wallets: byCreator, holdPercent: sumHold(byCreator) });
  const collect = (key: (b: LaunchCache["buyers"][number]) => string | null | undefined) => {
    const m = new Map<string, string[]>();
    for (const b of cache.buyers) {
      const k = key(b);
      if (!k || k === me) continue;
      m.set(k, [...(m.get(k) ?? []), b.address]);
    }
    return [...m.entries()].filter(([, w]) => w.length >= 2);
  };
  for (const [via, wallets] of collect((b) => b.funder)) {
    const txs = funderTxs.get(via);
    if (txs !== undefined && txs !== null && txs > SERVICE_TXS) continue;
    groups.push({ via, kind: "funder", wallets, holdPercent: sumHold(wallets) });
  }
  for (const [via, wallets] of collect((b) => (b.sender !== b.address ? b.sender : null)))
    groups.push({ via, kind: "sender", wallets, holdPercent: sumHold(wallets) });
  groups.sort((a, b) => b.holdPercent - a.holdPercent);

  const snipeHold = sumHold(snipers.map((b) => b.address));
  const worst = groups[0];
  const creatorGroup = groups.find((g) => g.kind === "creator");
  const status: LaunchActivity["status"] =
    (creatorGroup && creatorGroup.holdPercent >= 5) || (worst && worst.holdPercent >= 15)
      ? "risk"
      : (worst && worst.holdPercent >= 3) || snipeHold >= 25
        ? "warn"
        : "ok";

  const boughtPercent = pct(
    cache.buyers.reduce((n, b) => n + BigInt(b.bought), 0n),
    supply,
  );
  const creatorBoughtPercent = pct(BigInt(cache.creatorBought), supply);
  const describe = (g: LaunchGroup) =>
    g.kind === "creator"
      ? `${plural(g.wallets.length, "wallet")} funded or bought for by the creator`
      : g.kind === "funder"
        ? `${plural(g.wallets.length, "wallet")} funded by the same wallet (${short(g.via)})`
        : `${plural(g.wallets.length, "wallet")} bought for by the same wallet (${short(g.via)})`;
  const facts =
    buyers.length === 0
      ? `Nobody but the creator bought in the first ${cache.windowSeconds} seconds.`
      : `${plural(buyers.length, "wallet")} bought in the first ${cache.windowSeconds} seconds${snipers.length ? ` (${snipers.length} within ${SNIPE_S} seconds, almost always bots)` : ""}, taking ${fmt(boughtPercent)} of the supply${holdPercent === null ? "." : holdPercent < 0.01 ? "; all of it has been sold since." : `; ${fmt(holdPercent)} is still held.`}`;
  const creatorNote =
    creatorBoughtPercent > 0 ? ` The creator bought ${fmt(creatorBoughtPercent)} at launch.` : "";
  const linked = groups.filter((g) => g.holdPercent >= 0.01);
  const lead =
    status === "risk" && worst
      ? `Yes. ${describe(creatorGroup && creatorGroup.holdPercent >= 5 ? creatorGroup : worst)} bought at launch and still hold ${fmt((creatorGroup && creatorGroup.holdPercent >= 5 ? creatorGroup : worst).holdPercent)} of the supply. `
      : status === "warn" && worst && worst.holdPercent >= 3
        ? `Some sign of it. ${describe(worst)} still hold ${fmt(worst.holdPercent)}. `
        : status === "warn"
          ? `Snipers still hold ${fmt(snipeHold)} of the supply and could sell into any buy. `
          : linked.length
            ? `Not much. ${describe(linked[0]!)} hold only ${fmt(linked[0]!.holdPercent)} now. `
            : "No sign of it. ";
  const fundingNote =
    status === "ok" && !linked.length && holdPercent !== null && holdPercent >= 1
      ? cache.buyers.some((b) => b.funder !== undefined)
        ? " No funding links to the creator or between the buyers still holding."
        : ""
      : "";

  return {
    status,
    windowSeconds: cache.windowSeconds,
    buyers: buyers.length,
    snipers: snipers.length,
    boughtPercent,
    holdPercent,
    creatorBoughtPercent,
    sameBlock: cache.sameBlock,
    groups,
    // The eight biggest, in the order they bought.
    top: [...buyers]
      .sort((a, b) => b.boughtPercent - a.boughtPercent)
      .slice(0, 8)
      .sort((a, b) => a.seconds - b.seconds),
    detail: `${lead}${facts}${creatorNote}${fundingNote}`,
  };
}

export const launchCheck = (l: LaunchActivity): TokenCheck => ({
  id: "bundle",
  label: "Was the launch bundled or sniped?",
  status: l.status,
  detail: l.detail,
});

const pad = (a: string) => a.toLowerCase().slice(2).padStart(64, "0");
const isCode = (c: string | null) => !!c && c !== "0x" && !c.toLowerCase().startsWith("0xef0100");

/** Reads (or recalls) the window, re-reads holdings, looks up funders. Throws on GoldRush errors. */
export async function readLaunchActivity(
  r: TokenScanReport,
  index: TokenIndex | null,
  data: ChainDataOptions,
  now: number,
): Promise<LaunchActivity | null> {
  if (!r.isContract || r.token.totalSupply === null) return null;
  const supply = BigInt(r.token.totalSupply) * 10n ** BigInt(r.token.decimals ?? 18);
  if (supply === 0n) return null;
  const creator = r.origin?.creator ?? null;
  let cache = (await index?.launchCache?.(r.address).catch(() => null)) ?? null;
  let changed = false;
  if (!cache) {
    const txs = await earliestTransactions(data, r.address);
    cache = launchWindow(r.address, txs, r.sellTest?.venue ?? null, creator);
    if (!cache) return null;
    const codes = await rpcBatch(
      data.rpcUrls,
      cache.buyers.map((b) => ({ method: "eth_getCode", params: [b.address, "latest"] })),
      data.fetch,
    ).catch(() => cache!.buyers.map(() => null));
    cache.buyers.forEach((b, i) => (b.contract = isCode(codes[i] ?? null)));
    changed = true;
  }
  const readBalances = () =>
    rpcBatch(
      data.rpcUrls,
      cache!.buyers.map((b) => callOf(r.address, `0x70a08231${pad(b.address)}`)),
      data.fetch,
    ).catch(() => cache!.buyers.map(() => null));
  let balances = await readBalances();
  // Public RPCs sometimes turn Cloudflare away for a moment: one more try when nothing came back.
  if (balances.length && balances.every((b) => b === null)) balances = await readBalances();
  const holds = new Map<string, bigint | null>();
  cache.buyers.forEach((b, i) => {
    const h = balances[i];
    holds.set(b.address, h && /^0x[0-9a-f]+$/i.test(h) ? BigInt(h) : null);
  });

  // Who funded the wallets that still hold a meaningful share (0.1% or more).
  const need = cache.buyers
    .filter((b) => !b.contract && (holds.get(b.address) ?? 0n) * 1000n >= supply)
    .sort((a, b) => Number((holds.get(b.address) ?? 0n) - (holds.get(a.address) ?? 0n)))
    .slice(0, FUND_LOOKUPS)
    .filter((b) => b.funder === undefined);
  if (need.length) {
    await Promise.all(
      need.map(async (b) => {
        const txs = await earliestTransactions(data, b.address, { logs: false }).catch(() => null);
        if (!txs) return;
        const first = txs.find(
          (t) => t.to_address?.toLowerCase() === b.address && /^[1-9]\d*$/.test(t.value ?? ""),
        );
        b.funder = first?.from_address?.toLowerCase() ?? null;
      }),
    );
    changed = true;
  }
  const counts = new Map<string, number>();
  for (const b of cache.buyers)
    if (b.funder && b.funder !== creator) counts.set(b.funder, (counts.get(b.funder) ?? 0) + 1);
  const shared = [...counts.entries()].filter(([, n]) => n >= 2).map(([f]) => f);
  const funderTxs = new Map<string, number | null>(
    await Promise.all(shared.map(async (f) => [f, await transactionCount(data, f)] as const)),
  );

  // Keep it once the window is over (later scans then cost no GoldRush calls for buyers).
  if (changed && now - Date.parse(cache.startedAt) > (WINDOW_S + 120) * 1000)
    await index?.saveLaunch?.(r.address, cache).catch(() => undefined);
  return launchActivity(cache, holds, supply, creator, funderTxs);
}

const verdictOf = (checks: TokenCheck[]): TokenScanReport["verdict"] =>
  checks.some((c) => c.status === "risk")
    ? "risky"
    : checks.some((c) => c.status === "warn")
      ? "caution"
      : "clean";

/**
 * Adds "What else did the creator launch?" and "Was the launch bundled or sniped?", and files
 * this token under its creator for later scans. Never throws.
 */
export async function withLaunchChecks(
  r: TokenScanReport,
  index: TokenIndex | null,
  data: ChainDataOptions | undefined,
  now = Date.now(),
): Promise<TokenScanReport> {
  if (!r.isContract) return r;
  const o = r.origin;
  const [known, launch] = await Promise.all([
    o && index?.creatorTokens
      ? index.creatorTokens(o.creator, o.otherLaunches).catch(() => null)
      : Promise.resolve(null),
    data ? readLaunchActivity(r, index, data, now).catch(() => null) : Promise.resolve(null),
  ]);
  const deployer = known ? deployerReputation(r, known) : null;
  if (o && index?.noteCreator) {
    // The verdict before these two checks, so one bad launch doesn't snowball into the next.
    const honeypot =
      r.sellTest?.status === "failed" ||
      r.checks.some((c) => c.id === "fingerprint" && c.status === "risk");
    await index
      .noteCreator(o.creator, {
        address: r.address,
        symbol: r.token.symbol,
        verdict: r.verdict,
        honeypot,
        at: now,
      })
      .catch(() => undefined);
  }
  const limits =
    data && !launch
      ? [...(r.limits ?? []), "The launch window (first buyers) couldn't be read right now."]
      : r.limits;
  const checks = r.checks.filter((c) => c.id !== "deployer" && c.id !== "bundle");
  if (deployer) checks.push(deployerCheck(deployer));
  if (launch) checks.push(launchCheck(launch));
  return { ...r, checks, verdict: verdictOf(checks), deployer, launch, limits };
}
