/**
 * New Token Radar: every token launched through the Pons launchpad on Robinhood Chain, scanned a
 * few minutes after launch (once the first minute of buying can be read) with every check Mofu
 * has. The Durable Object's own alarm runs tick() every two minutes (started once by ensure(),
 * then it keeps itself going); the scans also file each token under its creator and queue its
 * verdict for the on-chain registry.
 */
import { DurableObject } from "cloudflare:workers";
import type { TokenScanReport } from "../shared/api.js";
import { parseRpcUrls } from "./chain.js";
import { recentTransactions, type ChainDataOptions, type TxItem } from "./chain-data.js";
import { PONS_LAUNCHPAD } from "./known.js";
import { withLookalikes } from "./lookalike.js";
import { tokenIndexFromEnv } from "./stats.js";
import { scanToken } from "./token-scan.js";
import { queueVerdict } from "./verdict-store.js";
import { walletWatchFromEnv } from "./wallet-watch.js";

const ZERO = "0x0000000000000000000000000000000000000000";
/** Wait this long after launch, so the launch window (first minute) is complete. */
export const SETTLE_MS = 150_000;
const KEEP_ENTRIES = 300;
const MAX_QUEUE = 60;
const MAX_TRIES = 3;
const SEEN_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** Launches older than this when first seen are skipped. */
const FRESH_MS = 30 * 60 * 1000;

export interface RadarEntry {
  address: string;
  name: string | null;
  symbol: string | null;
  creator: string;
  launchedAt: string;
  scannedAt: string;
  verdict: TokenScanReport["verdict"];
  /** Simulated sell: passed, failed, or not tested. */
  sell: "passed" | "failed" | null;
  bundle: "ok" | "warn" | "risk" | null;
  deployer: "ok" | "warn" | "risk" | null;
  /** Share of the way to graduation on the launch curve, 0–100. */
  progress: number | null;
  /** Labels of the checks that came back risky. */
  risks: string[];
}

/** Tokens minted in the launcher's transactions: token, creator, time. Pure. */
export function launchesFrom(txs: TxItem[]): Array<{ token: string; creator: string; at: number }> {
  const out = new Map<string, { token: string; creator: string; at: number }>();
  for (const tx of txs) {
    const at = Date.parse(tx.block_signed_at ?? "");
    const creator = tx.from_address?.toLowerCase();
    if (!Number.isFinite(at) || !creator) continue;
    for (const e of tx.log_events ?? []) {
      if (e.decoded?.name !== "Transfer") continue;
      const from = String(e.decoded.params?.find((p) => p.name === "from")?.value ?? "");
      const token = e.sender_address?.toLowerCase();
      if (from.toLowerCase() !== ZERO || !token || out.has(token)) continue;
      out.set(token, { token, creator, at });
    }
  }
  return [...out.values()].sort((a, b) => a.at - b.at);
}

/** The radar's line for one scanned token. Pure. */
export function radarEntry(
  r: TokenScanReport,
  creator: string,
  launchedAt: number,
  now: number,
): RadarEntry {
  const check = (id: string) => r.checks.find((c) => c.id === id)?.status;
  const level = (id: string) => {
    const s = check(id);
    return s === "ok" || s === "warn" || s === "risk" ? s : null;
  };
  return {
    address: r.address,
    name: r.token.name,
    symbol: r.token.symbol,
    creator: r.origin?.creator ?? creator,
    launchedAt: new Date(launchedAt).toISOString(),
    scannedAt: new Date(now).toISOString(),
    verdict: r.verdict,
    sell:
      r.sellTest?.status === "passed"
        ? "passed"
        : r.sellTest?.status === "failed"
          ? "failed"
          : null,
    bundle: level("bundle"),
    deployer: level("deployer"),
    progress: r.liquidity?.curve?.progressPercent ?? null,
    risks: r.checks.filter((c) => c.status === "risk").map((c) => c.label),
  };
}

const entryKey = (launchedAt: number, token: string) =>
  `e:${String(9_999_999_999_999 - launchedAt).padStart(13, "0")}:${token}`;

export interface LastTick {
  at: string;
  found: number;
  scanned: number;
  queued: number;
}

interface Queued {
  token: string;
  creator: string;
  at: number;
  tries: number;
}

const TICK_MS = 2 * 60 * 1000;
/** Sooner while launches are waiting, since each run scans one. */
const BACKLOG_MS = 45 * 1000;

export class RadarStore extends DurableObject<Env> {
  /** Starts the two-minute alarm if it isn't running. Cheap; called from the radar's pages. */
  async ensure(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
  }

  override async alarm(): Promise<void> {
    let backlog = false;
    try {
      backlog = (await this.tick()).queued > 0;
    } catch (err) {
      await this.ctx.storage
        .put("lastError", {
          at: new Date().toISOString(),
          message: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        })
        .catch(() => undefined);
    } finally {
      // Off (RADAR_ENABLED isn't "true"): stop instead of waking up for nothing.
      if (String((this.env as Env & { RADAR_ENABLED?: string }).RADAR_ENABLED) === "true")
        await this.ctx.storage.setAlarm(Date.now() + (backlog ? BACKLOG_MS : TICK_MS));
    }
  }

  private options(): (ChainDataOptions & { now: number }) | null {
    const env = this.env as Env & { GOLDRUSH_API_KEY?: string };
    const urls = parseRpcUrls(env.HOLDER_RPC_URL);
    if (!env.GOLDRUSH_API_KEY || urls.length === 0) return null;
    return {
      apiKey: env.GOLDRUSH_API_KEY,
      chain: String(env.GOLDRUSH_CHAIN ?? "robinhood-mainnet"),
      rpcUrls: urls,
      // Wrapped: GoldRush helpers call o.fetch(...), and a bare fetch called as a method throws
      // "Illegal invocation" on Workers.
      fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
      now: Date.now(),
    };
  }

  /** Finds new launches and scans the ones that have settled. */
  async tick(): Promise<{ found: number; scanned: number; queued: number }> {
    const env = this.env as Env & { RADAR_ENABLED?: string; RADAR_PER_RUN?: string };
    const data = this.options();
    if (String(env.RADAR_ENABLED) !== "true" || !data) return { found: 0, scanned: 0, queued: 0 };
    const now = Date.now();

    // 1. New launches.
    let found = 0;
    const txs = await recentTransactions(data, PONS_LAUNCHPAD, { min: 50 }).catch(async (err) => {
      await this.ctx.storage.put("lastError", {
        at: new Date().toISOString(),
        message: `launchpad read: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`,
      });
      return [] as TxItem[];
    });
    const launches = launchesFrom(txs).filter((l) => now - l.at < SEEN_TTL_MS);
    if (launches.length) {
      const seen = await this.ctx.storage.get<number>(launches.map((l) => `seen:${l.token}`));
      const writes: Record<string, unknown> = {};
      for (const l of launches) {
        if (seen.has(`seen:${l.token}`)) continue;
        writes[`seen:${l.token}`] = l.at;
        // Only fresh launches get scanned (the first run sees hours of history).
        if (now - l.at > FRESH_MS) continue;
        writes[`q:${l.token}`] = {
          token: l.token,
          creator: l.creator,
          at: l.at,
          tries: 0,
        } as Queued;
        found++;
      }
      if (Object.keys(writes).length) await this.ctx.storage.put(writes);
    }

    // 2. Scan what has settled, oldest first.
    const queue = [...(await this.ctx.storage.list<Queued>({ prefix: "q:" })).values()].sort(
      (a, b) => a.at - b.at,
    );
    // Too far behind: drop the oldest instead of scanning stale launches forever.
    const overflow = queue.length > MAX_QUEUE ? queue.splice(0, queue.length - MAX_QUEUE) : [];
    if (overflow.length) await this.ctx.storage.delete(overflow.map((q) => `q:${q.token}`));
    // One full scan uses most of a Workers invocation's 50 subrequests: one per run by default.
    const perRun = Math.max(1, Math.min(3, Number.parseInt(String(env.RADAR_PER_RUN), 10) || 1));
    const due = queue.filter((q) => now - q.at >= SETTLE_MS).slice(0, perRun);
    let scanned = 0;
    const index = (() => {
      try {
        return tokenIndexFromEnv(this.env);
      } catch {
        return null;
      }
    })();
    for (const q of due) {
      try {
        const at = Date.now();
        const report = await scanToken(data.rpcUrls, q.token, data.fetch, { ...data, now: at });
        const full = await withLookalikes(report, index, data);
        const waits: Promise<unknown>[] = [];
        queueVerdict(this.env, full, at, (p) => waits.push(p));
        await Promise.all(waits);
        if (index && (full.token.name || full.token.symbol))
          await index
            .rememberTokens([
              {
                address: full.address,
                name: full.token.name,
                symbol: full.token.symbol,
                verdict: full.verdict,
                at,
              },
            ])
            .catch(() => undefined);
        const entry = radarEntry(full, q.creator, q.at, at);
        await this.ctx.storage.put(entryKey(q.at, q.token), entry);
        // Creator Watch: tell anyone following this creator.
        await walletWatchFromEnv(this.env)
          .creatorLaunched(entry)
          .catch(() => 0);
        await this.ctx.storage.delete(`q:${q.token}`);
        scanned++;
      } catch (err) {
        await this.ctx.storage.put("lastError", {
          at: new Date().toISOString(),
          message: `scan of ${q.token}: ${(err instanceof Error ? err.message : String(err)).slice(0, 150)}`,
        });
        if (q.tries + 1 >= MAX_TRIES) await this.ctx.storage.delete(`q:${q.token}`);
        else await this.ctx.storage.put(`q:${q.token}`, { ...q, tries: q.tries + 1 });
      }
    }

    // 3. Keep the list and the seen set bounded.
    const entries = await this.ctx.storage.list({ prefix: "e:" });
    if (entries.size > KEEP_ENTRIES)
      await this.ctx.storage.delete([...entries.keys()].slice(KEEP_ENTRIES).slice(0, 128));
    if (Math.random() < 0.05) {
      const seen = await this.ctx.storage.list<number>({ prefix: "seen:" });
      const old = [...seen.entries()].filter(([, at]) => now - at > SEEN_TTL_MS).map(([k]) => k);
      for (let i = 0; i < old.length; i += 128)
        await this.ctx.storage.delete(old.slice(i, i + 128));
    }
    const left = (await this.ctx.storage.list({ prefix: "q:" })).size;
    if (txs.length && scanned === due.length) await this.ctx.storage.delete("lastError");
    await this.ctx.storage.put("lastTick", {
      at: new Date(now).toISOString(),
      found,
      scanned,
      queued: left,
    });
    return { found, scanned, queued: left };
  }

  async list(limit = 100): Promise<{
    entries: RadarEntry[];
    queued: number;
    lastTick: LastTick | null;
    lastError: { at: string; message: string } | null;
    alarm: number | null;
  }> {
    const rows = await this.ctx.storage.list<RadarEntry>({
      prefix: "e:",
      limit: Math.min(300, limit),
    });
    return {
      entries: [...rows.values()],
      queued: (await this.ctx.storage.list({ prefix: "q:" })).size,
      lastTick: (await this.ctx.storage.get<LastTick>("lastTick")) ?? null,
      lastError: (await this.ctx.storage.get<{ at: string; message: string }>("lastError")) ?? null,
      alarm: await this.ctx.storage.getAlarm(),
    };
  }
}

export const radarFromEnv = (env: Env) => env.RADAR.get(env.RADAR.idFromName("global"));
