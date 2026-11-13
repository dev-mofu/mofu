/**
 * Wallet Watch: webhooks for wallets. Mofu re-checks each watched wallet about every half hour
 * (Wallet Health: approvals, NFT approvals, lookalike addresses, holdings) and POSTs a signed
 * event when something new and bad shows up: a risky approval, a planted lookalike address, or a
 * token the wallet holds that Mofu now rates risky. The first check is the baseline.
 *
 * Its own Durable Object, so wallet checks don't eat into the token webhooks' subrequest budget:
 * one wallet per alarm.
 */
import { DurableObject } from "cloudflare:workers";
import type { WalletReport } from "../shared/api.js";
import { parseRpcUrls } from "./chain.js";
import { tokenIndexFromEnv } from "./stats.js";
import { walletReport } from "./wallet.js";
import {
  deliver,
  DISABLED_TTL_MS,
  MAX_FAILURES,
  randomHex,
  sameSecret,
  type DeliveryResult,
  type StoredHook,
  type WebhookEvent,
} from "./webhooks.js";

export const WALLET_EVENTS = ["risky_approval", "poisoning", "holding_risky"] as const;
export type WalletEventType = (typeof WALLET_EVENTS)[number];

export const MAX_WALLETS_PER_HOOK = 3;
export const MAX_WATCHED_WALLETS = 40;
const MAX_WALLET_HOOKS = 100;
/** Each wallet is re-checked about this often. */
export const WALLET_POLL_MS = 30 * 60 * 1000;
/** Between alarms while wallets are due (one wallet per alarm). */
const STEP_MS = 90 * 1000;
/** Subrequests one alarm may make; the strictest Workers plan allows 50. */
const BUDGET = 45;
/** After a check that couldn't finish. */
const RETRY_MS = 10 * 60 * 1000;

export const newWatchId = () => `ww_${randomHex(12)}`;

export interface WalletHook extends Omit<StoredHook, "tokens" | "events"> {
  wallets: string[];
  events: WalletEventType[];
}

/** What Mofu last saw for one wallet. */
export interface WalletSnapshot {
  /** Risky approvals: "token:<token>:<spender>" and "nft:<collection>:<operator>". */
  approvals: string[];
  /** Lookalike addresses planted in its history. */
  poison: string[];
  /** Tokens it holds that Mofu rates risky. */
  risky: string[];
  polledAt: number;
  /** false: a placeholder after a failed first check, not something to compare against. */
  baseline?: boolean;
  /** Why the last check didn't finish, when it didn't. */
  note?: string;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The snapshot of a fresh Wallet Health report, plus the verdicts Mofu knows. Pure. */
export function walletSnapshot(
  r: WalletReport,
  verdicts: Record<string, string>,
  now: number,
): WalletSnapshot {
  return {
    approvals: [
      ...r.approvals
        .filter((a) => a.risk === "risk")
        .map((a) => `token:${a.token}:${a.spender.address}`),
      ...(r.nftApprovals ?? [])
        .filter((a) => a.risk === "risk")
        .map((a) => `nft:${a.collection}:${a.operator.address}`),
    ],
    poison: (r.poisoning ?? []).map((p) => p.address),
    risky: r.holdings.filter((h) => verdicts[h.token] === "risky").map((h) => h.token),
    polledAt: now,
  };
}

type WalletChange = Pick<WebhookEvent, "summary" | "before" | "after"> & { type: WalletEventType };

/** New bad things between two snapshots of a wallet, described from the fresh report. Pure. */
export function walletChanges(
  wallet: string,
  prev: WalletSnapshot,
  next: WalletSnapshot,
  r: WalletReport,
): WalletChange[] {
  const out: WalletChange[] = [];
  const w = short(wallet);
  for (const key of next.approvals) {
    if (prev.approvals.includes(key)) continue;
    const [kind, contract, spender] = key.split(":") as [string, string, string];
    if (kind === "token") {
      const a = r.approvals.find((x) => x.token === contract && x.spender.address === spender);
      out.push({
        type: "risky_approval",
        summary:
          `${w} gave a risky approval: ${short(spender)} (${a?.spender.label ?? a?.spender.kind ?? "unknown"}) can spend ${a?.allowance ?? "?"} ${a?.tokenSymbol ? `$${a.tokenSymbol}` : short(contract)}. ${a?.reasons[0] ?? ""}`.trim(),
        before: null,
        after: { kind: "token", token: contract, spender, allowance: a?.allowance ?? null },
      });
    } else {
      const a = (r.nftApprovals ?? []).find(
        (x) => x.collection === contract && x.operator.address === spender,
      );
      out.push({
        type: "risky_approval",
        summary:
          `${w} let ${short(spender)} move every item in ${a?.name ?? short(contract)}. ${a?.reasons[1] ?? a?.reasons[0] ?? ""}`.trim(),
        before: null,
        after: { kind: "nft", collection: contract, operator: spender },
      });
    }
  }
  for (const address of next.poison) {
    if (prev.poison.includes(address)) continue;
    const p = (r.poisoning ?? []).find((x) => x.address === address);
    out.push({
      type: "poisoning",
      summary: `A lookalike address was planted in ${w}'s history: never send to ${address}${p?.resembles ? `. It imitates ${p.resemblesSelf ? "the wallet itself" : p.resembles}` : ""}.`,
      before: null,
      after: { address, resembles: p?.resembles ?? null, txHash: p?.txHash ?? null },
    });
  }
  for (const token of next.risky) {
    if (prev.risky.includes(token)) continue;
    const h = r.holdings.find((x) => x.token === token);
    out.push({
      type: "holding_risky",
      summary: `${w} holds ${h?.symbol ? `$${h.symbol}` : short(token)}, which Mofu now rates risky.`,
      before: null,
      after: { token, balance: h?.balance ?? null, report: `https://mofu.works/token/${token}` },
    });
  }
  return out;
}

export type WatchCreateResult = { hook: ReturnType<typeof publicWatch> } | { error: string };

/** What the owner sees about a wallet hook (never the secret). */
export const publicWatch = (h: WalletHook): Omit<WalletHook, "secret"> => ({
  id: h.id,
  url: h.url,
  wallets: h.wallets,
  events: h.events,
  createdAt: h.createdAt,
  status: h.status,
  disabledAt: h.disabledAt,
  failures: h.failures,
  delivered: h.delivered,
  lastDeliveryAt: h.lastDeliveryAt,
  lastResult: h.lastResult,
});

export class WalletWatchStore extends DurableObject<Env> {
  private async hooks(): Promise<WalletHook[]> {
    return [...(await this.ctx.storage.list<WalletHook>({ prefix: "hook:" })).values()];
  }

  private async soon(ms: number) {
    const at = Date.now() + ms;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  async create(input: {
    id: string;
    url: string;
    secret: string;
    wallets: string[];
    events: WalletEventType[];
    now: number;
  }): Promise<WatchCreateResult> {
    const hooks = await this.hooks();
    if (hooks.length >= MAX_WALLET_HOOKS)
      return { error: "Mofu is watching as many wallets as it can right now. Try again later." };
    if (hooks.filter((h) => h.url === input.url).length >= 3)
      return { error: "That URL already has 3 wallet webhooks. Delete one first." };
    const watched = new Set(hooks.flatMap((h) => h.wallets));
    const added = input.wallets.filter((w) => !watched.has(w));
    if (watched.size + added.length > MAX_WATCHED_WALLETS)
      return {
        error: `Mofu can watch ${MAX_WATCHED_WALLETS} wallets in total and is near that now. Try later.`,
      };
    const hook: WalletHook = {
      id: input.id,
      url: input.url,
      secret: input.secret,
      wallets: input.wallets,
      events: input.events,
      createdAt: new Date(input.now).toISOString(),
      status: "active",
      disabledAt: null,
      failures: 0,
      delivered: 0,
      lastDeliveryAt: null,
      lastResult: null,
    };
    await this.ctx.storage.put(`hook:${hook.id}`, hook);
    // The baseline check runs right away.
    await this.soon(5_000);
    return { hook: publicWatch(hook) };
  }

  private async owned(id: string, secret: string): Promise<WalletHook | null> {
    const hook = await this.ctx.storage.get<WalletHook>(`hook:${id}`);
    return hook && sameSecret(hook.secret, secret) ? hook : null;
  }

  async get(id: string, secret: string) {
    const hook = await this.owned(id, secret);
    if (!hook) return null;
    const snaps = await this.ctx.storage.get<WalletSnapshot>(hook.wallets.map((w) => `w:${w}`));
    return {
      ...publicWatch(hook),
      watching: hook.wallets.map((address) => {
        const s = snaps.get(`w:${address}`);
        return {
          address,
          lastChecked: s?.polledAt ? new Date(s.polledAt).toISOString() : null,
          riskyApprovals: s?.approvals.length ?? null,
          lookalikes: s?.poison.length ?? null,
          riskyHoldings: s?.risky.length ?? null,
          note: s?.note ?? null,
        };
      }),
    };
  }

  async remove(id: string, secret: string): Promise<boolean> {
    const hook = await this.owned(id, secret);
    if (!hook) return false;
    await this.ctx.storage.delete(`hook:${id}`);
    const left = new Set((await this.hooks()).flatMap((h) => h.wallets));
    const gone = hook.wallets.filter((w) => !left.has(w)).map((w) => `w:${w}`);
    if (gone.length) await this.ctx.storage.delete(gone);
    return true;
  }

  async test(id: string, secret: string, now: number): Promise<DeliveryResult | null> {
    const hook = await this.owned(id, secret);
    if (!hook) return null;
    const res = await deliver(
      fetch,
      hook,
      {
        id: `evt_${randomHex(12)}`,
        type: "test",
        createdAt: new Date(now).toISOString(),
        token: null,
        wallet: hook.wallets[0] ?? null,
        summary: "A test event from Mofu. Your wallet webhook is set up.",
        before: null,
        after: null,
        report: null,
      },
      now,
    );
    await this.ctx.storage.put(`hook:${id}`, this.afterDelivery(hook, res, now));
    return res;
  }

  private afterDelivery(hook: WalletHook, res: DeliveryResult, now: number): WalletHook {
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

  override async alarm(): Promise<void> {
    const now = Date.now();
    let hooks = await this.hooks();
    const expired = hooks.filter(
      (h) =>
        h.status === "disabled" && h.disabledAt && now - Date.parse(h.disabledAt) > DISABLED_TTL_MS,
    );
    if (expired.length) {
      await this.ctx.storage.delete(expired.map((h) => `hook:${h.id}`));
      hooks = hooks.filter((h) => !expired.includes(h));
    }
    const active = hooks.filter((h) => h.status === "active");
    if (!active.length) {
      if (hooks.length) await this.ctx.storage.setAlarm(now + 6 * 60 * 60 * 1000);
      return;
    }
    const wallets = [...new Set(active.flatMap((h) => h.wallets))];
    const snaps = await this.ctx.storage.get<WalletSnapshot>(wallets.map((w) => `w:${w}`));
    const order = wallets
      .map((w) => ({ w, s: snaps.get(`w:${w}`) ?? null }))
      .sort((a, b) => (a.s?.polledAt ?? 0) - (b.s?.polledAt ?? 0));
    const target = order.find((o) => !o.s || now - o.s.polledAt >= WALLET_POLL_MS);

    if (target) {
      let used = 0;
      const counted: typeof fetch = (input, init) => {
        if (++used > BUDGET) return Promise.reject(new Error("budget"));
        return fetch(input, init);
      };
      const apiKey = (this.env as Env & { GOLDRUSH_API_KEY?: string }).GOLDRUSH_API_KEY;
      const urls = parseRpcUrls(this.env.HOLDER_RPC_URL);
      if (apiKey && urls.length) {
        try {
          const report = await walletReport(
            {
              apiKey,
              chain: String(this.env.GOLDRUSH_CHAIN ?? "robinhood-mainnet"),
              rpcUrls: urls,
              fetch: counted,
              now,
            },
            target.w,
            { light: true },
          );
          let verdicts: Record<string, string> = {};
          try {
            verdicts =
              (await tokenIndexFromEnv(this.env).knownVerdicts?.(
                report.holdings.map((h) => h.token),
              )) ?? {};
          } catch {
            verdicts = {};
          }
          // A check cut short by the budget isn't trusted. Approvals that couldn't be read keep
          // their last known state (no event either way) while the rest is still checked.
          const approvalsRead = report.status.approvals === "ok";
          if (used <= BUDGET && (approvalsRead || (target.s && target.s.baseline !== false))) {
            const fresh = walletSnapshot(report, verdicts, now);
            const next: WalletSnapshot = approvalsRead
              ? fresh
              : {
                  ...fresh,
                  approvals: target.s!.approvals,
                  note: "approvals couldn't be read this time",
                };
            const changes =
              target.s && target.s.baseline !== false
                ? walletChanges(target.w, target.s, next, report)
                : [];
            const updated = new Map<string, WalletHook>();
            for (const change of changes)
              for (const h of active) {
                if (!h.wallets.includes(target.w) || !h.events.includes(change.type)) continue;
                const hook = updated.get(h.id) ?? h;
                if (hook.status !== "active") continue;
                const res = await deliver(
                  fetch,
                  hook,
                  {
                    id: `evt_${randomHex(12)}`,
                    createdAt: new Date(now).toISOString(),
                    token: null,
                    wallet: target.w,
                    report: `https://mofu.works/app/?scan=${target.w}`,
                    ...change,
                  },
                  now,
                );
                updated.set(h.id, this.afterDelivery(hook, res, now));
              }
            const writes: Record<string, unknown> = { [`w:${target.w}`]: next };
            for (const [id, h] of updated) writes[`hook:${id}`] = h;
            await this.ctx.storage.put(writes);
          } else {
            // Try this wallet again in ten minutes; without a real baseline, nothing fires yet.
            await this.ctx.storage.put(`w:${target.w}`, {
              ...(target.s ?? { approvals: [], poison: [], risky: [], baseline: false }),
              polledAt: now - WALLET_POLL_MS + RETRY_MS,
              note:
                used > BUDGET
                  ? `the check needed more than ${BUDGET} requests`
                  : "the wallet's approvals couldn't be read",
            });
          }
        } catch (err) {
          // Try again in ten minutes, and say why.
          await this.ctx.storage.put(`w:${target.w}`, {
            ...(target.s ?? { approvals: [], poison: [], risky: [], baseline: false }),
            polledAt: now - WALLET_POLL_MS + RETRY_MS,
            note: (err instanceof Error ? err.message : String(err)).slice(0, 160),
          });
        }
      }
    }
    // Next: soon while other wallets are due, otherwise when the next one comes due.
    const after = await this.ctx.storage.get<WalletSnapshot>(wallets.map((w) => `w:${w}`));
    const nextDue = Math.min(
      ...wallets.map((w) => (after.get(`w:${w}`)?.polledAt ?? 0) + WALLET_POLL_MS),
    );
    await this.ctx.storage.setAlarm(Math.max(now + STEP_MS, nextDue));
  }
}

export const walletWatchFromEnv = (env: Env) =>
  env.WALLET_WATCH.get(env.WALLET_WATCH.idFromName("global"));
