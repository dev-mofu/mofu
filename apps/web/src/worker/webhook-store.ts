import { DurableObject } from "cloudflare:workers";
import { parseRpcUrls, rpcBatch, type BatchCall } from "./chain.js";
import { withLookalikes } from "./lookalike.js";
import { tokenIndexFromEnv } from "./stats.js";
import { upgradeSummary } from "./templates.js";
import { scanToken } from "./token-scan.js";
import {
  applyScan,
  applySnapshot,
  cheapChanges,
  deliver,
  DISABLED_TTL_MS,
  emptySnapshot,
  MAX_FAILURES,
  MAX_HOOKS,
  MAX_WATCHED_TOKENS,
  POLL_INTERVAL_MS,
  POLL_PER_RUN,
  publicHook,
  randomHex,
  RESCAN_INTERVAL_MS,
  sameSecret,
  snapshotCalls,
  tokenRef,
  verdictStep,
  type Change,
  type DeliveryResult,
  type PublicHook,
  type StoredHook,
  type TokenSnapshot,
  type WebhookEvent,
  type WebhookEventType,
} from "./webhooks.js";

/** Subrequests one alarm may make; the strictest Workers plan allows 50. */
const BUDGET = 45;
const BATCH_CALLS = 25;

class BudgetSpent extends Error {}

export type CreateResult = { hook: PublicHook } | { error: string };

/**
 * One instance holds every webhook (hook:<id>) and what Mofu last saw for each watched token
 * (watch:<address>). While any hook is active an alarm runs every few minutes: cheap on-chain reads
 * for the tokens due, one full re-scan, then the deliveries.
 */
export class WebhookStore extends DurableObject<Env> {
  private async hooks(): Promise<StoredHook[]> {
    return [...(await this.ctx.storage.list<StoredHook>({ prefix: "hook:" })).values()];
  }

  private async ensureAlarm(soon = false) {
    const at = Date.now() + (soon ? 5_000 : POLL_INTERVAL_MS);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  async create(input: {
    id: string;
    url: string;
    secret: string;
    tokens: Array<{ address: string; name: string | null; symbol: string | null }>;
    events: WebhookEventType[];
    now: number;
  }): Promise<CreateResult> {
    const hooks = await this.hooks();
    if (hooks.length >= MAX_HOOKS)
      return { error: "Mofu is watching as many webhooks as it can right now. Try again later." };
    if (hooks.filter((h) => h.url === input.url).length >= 3)
      return { error: "That URL already has 3 webhooks. Delete one first." };
    const watched = new Set(hooks.flatMap((h) => h.tokens));
    const added = input.tokens.filter((t) => !watched.has(t.address));
    if (watched.size + added.length > MAX_WATCHED_TOKENS)
      return {
        error: `Mofu can watch ${MAX_WATCHED_TOKENS} tokens in total and is near that now. Try fewer tokens, or later.`,
      };
    const hook: StoredHook = {
      id: input.id,
      url: input.url,
      secret: input.secret,
      tokens: input.tokens.map((t) => t.address),
      events: input.events,
      createdAt: new Date(input.now).toISOString(),
      status: "active",
      disabledAt: null,
      failures: 0,
      delivered: 0,
      lastDeliveryAt: null,
      lastResult: null,
    };
    const writes: Record<string, unknown> = { [`hook:${hook.id}`]: hook };
    for (const t of added)
      writes[`watch:${t.address}`] = {
        ...emptySnapshot(t.address),
        name: t.name,
        symbol: t.symbol,
      };
    await this.ctx.storage.put(writes);
    // The first check runs right away, so the baseline exists before anything can change.
    await this.ensureAlarm(true);
    return { hook: publicHook(hook) };
  }

  private async owned(id: string, secret: string): Promise<StoredHook | null> {
    const hook = await this.ctx.storage.get<StoredHook>(`hook:${id}`);
    return hook && sameSecret(hook.secret, secret) ? hook : null;
  }

  async get(id: string, secret: string): Promise<PublicHook | null> {
    const hook = await this.owned(id, secret);
    if (!hook) return null;
    const snaps = await this.ctx.storage.get<TokenSnapshot>(hook.tokens.map((a) => `watch:${a}`));
    const iso = (ms: number) => (ms ? new Date(ms).toISOString() : null);
    return {
      ...publicHook(hook),
      watching: hook.tokens.map((a) => {
        const s = snaps.get(`watch:${a}`);
        return {
          address: a,
          symbol: s?.symbol ?? null,
          verdict: s?.verdict ?? null,
          lastChecked: iso(s?.polledAt ?? 0),
          lastScanned: iso(s?.scannedAt ?? 0),
        };
      }),
    };
  }

  async remove(id: string, secret: string): Promise<boolean> {
    const hook = await this.owned(id, secret);
    if (!hook) return false;
    await this.ctx.storage.delete(`hook:${id}`);
    await this.dropUnwatched();
    return true;
  }

  /** Sends a test event now. A disabled hook that answers is switched back on. */
  async test(id: string, secret: string, now: number): Promise<DeliveryResult | null> {
    const hook = await this.owned(id, secret);
    if (!hook) return null;
    const event: WebhookEvent = {
      id: `evt_${randomHex(12)}`,
      type: "test",
      createdAt: new Date(now).toISOString(),
      token: null,
      summary: "A test event from Mofu. Your webhook is set up.",
      before: null,
      after: null,
      report: null,
    };
    const res = await deliver(fetch, hook, event, now);
    await this.ctx.storage.put(`hook:${id}`, this.afterDelivery(hook, res, now));
    if (res.ok) await this.ensureAlarm();
    return res;
  }

  private afterDelivery(hook: StoredHook, res: DeliveryResult, now: number): StoredHook {
    const failures = res.ok ? 0 : hook.failures + 1;
    const disable = failures >= MAX_FAILURES;
    return {
      ...hook,
      failures,
      delivered: hook.delivered + (res.ok ? 1 : 0),
      lastDeliveryAt: new Date(now).toISOString(),
      lastResult: res.result,
      status: res.ok ? "active" : disable ? "disabled" : hook.status,
      disabledAt: res.ok
        ? null
        : disable
          ? (hook.disabledAt ?? new Date(now).toISOString())
          : hook.disabledAt,
    };
  }

  private async dropUnwatched() {
    const hooks = await this.hooks();
    const watched = new Set(hooks.flatMap((h) => h.tokens));
    const snaps = await this.ctx.storage.list<TokenSnapshot>({ prefix: "watch:" });
    const stale = [...snaps.keys()].filter((k) => !watched.has(k.slice("watch:".length)));
    for (let i = 0; i < stale.length; i += 128)
      await this.ctx.storage.delete(stale.slice(i, i + 128));
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    let hooks = await this.hooks();
    // Disabled hooks are deleted after a week.
    const expired = hooks.filter(
      (h) =>
        h.status === "disabled" && h.disabledAt && now - Date.parse(h.disabledAt) > DISABLED_TTL_MS,
    );
    if (expired.length) {
      await this.ctx.storage.delete(expired.map((h) => `hook:${h.id}`));
      await this.dropUnwatched();
      hooks = hooks.filter((h) => !expired.includes(h));
    }
    const active = hooks.filter((h) => h.status === "active");
    if (active.length === 0) {
      // Nothing to deliver to; a disabled hook still needs a later cleanup pass.
      if (hooks.length) await this.ctx.storage.setAlarm(now + 6 * 60 * 60 * 1000);
      return;
    }

    let used = 0;
    const counted: typeof fetch = (input, init) => {
      if (++used > BUDGET) return Promise.reject(new BudgetSpent());
      return fetch(input, init);
    };
    const urls = parseRpcUrls(this.env.HOLDER_RPC_URL);
    const watched = [...new Set(active.flatMap((h) => h.tokens))];
    const stored = await this.ctx.storage.get<TokenSnapshot>(watched.map((a) => `watch:${a}`));
    const snaps = new Map<string, TokenSnapshot>();
    for (const a of watched) snaps.set(a, stored.get(`watch:${a}`) ?? emptySnapshot(a));
    const events: Array<{ token: TokenSnapshot; change: Change }> = [];
    let confirmSoon = false;

    // 1. One full scan first, while the budget is fresh: the token never scanned, or longest ago.
    const due = [...snaps.values()]
      .filter((s) => s.pendingVerdict !== null || now - s.scannedAt > RESCAN_INTERVAL_MS)
      .sort(
        (a, b) =>
          Number(b.pendingVerdict !== null) - Number(a.pendingVerdict !== null) ||
          a.scannedAt - b.scannedAt,
      );
    const target = due[0];
    if (target) {
      try {
        const apiKey = (this.env as Env & { GOLDRUSH_API_KEY?: string }).GOLDRUSH_API_KEY;
        const data = apiKey
          ? {
              apiKey,
              chain: String(this.env.GOLDRUSH_CHAIN ?? "robinhood-mainnet"),
              rpcUrls: urls,
              fetch: counted,
            }
          : undefined;
        let index = null;
        try {
          index = tokenIndexFromEnv(this.env);
        } catch {
          // no index binding
        }
        const before = used;
        const report = await withLookalikes(
          await scanToken(urls, target.address, counted, data && { ...data, now }),
          index,
          data,
        );
        // A scan cut short by the budget isn't trusted for a verdict.
        if (used <= BUDGET && used - before > 0) {
          let s = applyScan(target, report, now);
          const step = verdictStep(s, report.verdict);
          s = step.snapshot;
          if (step.change) events.push({ token: s, change: step.change });
          confirmSoon ||= step.confirmSoon;
          snaps.set(s.address, s);
        }
      } catch {
        // try this token again next time
      }
    }

    // 2. Cheap reads for the tokens checked longest ago.
    const toPoll = [...snaps.values()]
      .sort((a, b) => a.polledAt - b.polledAt)
      .slice(0, POLL_PER_RUN);
    // Whole tokens per batch, so each token's reads come back together.
    type Batch = {
      calls: BatchCall[];
      tokens: Array<{ address: string; from: number; count: number }>;
    };
    const batches: Batch[] = [];
    for (const s of toPoll) {
      const c = snapshotCalls(s);
      let b = batches.at(-1);
      if (!b || b.calls.length + c.length > BATCH_CALLS)
        batches.push((b = { calls: [], tokens: [] }));
      b.tokens.push({ address: s.address, from: b.calls.length, count: c.length });
      b.calls.push(...c);
    }
    for (const b of batches) {
      if (used >= BUDGET - 5) break;
      try {
        const out = await rpcBatch(urls, b.calls, counted);
        for (const c of b.tokens) {
          const part = out.slice(c.from, c.from + c.count);
          // Nothing came back at all: the endpoint failed, not the token. Skip it this round.
          if (part.every((r) => r === null)) continue;
          const prev = snaps.get(c.address)!;
          const next = applySnapshot(prev, part, now);
          for (const change of cheapChanges(prev, next)) events.push({ token: next, change });
          snaps.set(c.address, next);
        }
      } catch {
        break;
      }
    }

    // An upgrade says what the new code added and removed (two code reads, if the budget allows).
    for (const e of events) {
      if (e.change.type !== "upgraded" || used > BUDGET - 8) continue;
      const s = await upgradeSummary(
        urls,
        counted,
        (e.change.before as string | null) ?? null,
        (e.change.after as string | null) ?? null,
      ).catch(() => null);
      if (s) e.change = { ...e.change, summary: `${e.change.summary.split(":")[0]}: ${s.text}` };
    }

    // 3. Deliver, with whatever budget is left. Each hook gets the events it asked for.
    const changedHooks = new Map<string, StoredHook>();
    for (const { token, change } of events) {
      const event: WebhookEvent = {
        id: `evt_${randomHex(12)}`,
        createdAt: new Date(now).toISOString(),
        token: tokenRef(token),
        report: `https://mofu.works/token/${token.address}`,
        ...change,
      };
      for (const h of active) {
        if (
          !h.tokens.includes(token.address) ||
          !h.events.includes(change.type as WebhookEventType)
        )
          continue;
        const hook = changedHooks.get(h.id) ?? h;
        if (hook.status !== "active") continue;
        if (used >= BUDGET) break;
        used++;
        const res = await deliver(fetch, hook, event, now);
        changedHooks.set(h.id, this.afterDelivery(hook, res, now));
      }
    }

    const writes: Record<string, unknown> = {};
    for (const [a, s] of snaps) writes[`watch:${a}`] = s;
    for (const [id, h] of changedHooks) writes[`hook:${id}`] = h;
    const entries = Object.entries(writes);
    for (let i = 0; i < entries.length; i += 128)
      await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
    await this.ctx.storage.setAlarm(now + (confirmSoon ? 60_000 : POLL_INTERVAL_MS));
  }
}
