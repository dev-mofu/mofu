import { DurableObject } from "cloudflare:workers";
import {
  TOKEN_INDEX_MAX,
  type IndexedToken,
  type StatKey,
  type Stats,
  type TokenIndex,
} from "./stats.js";

/**
 * One instance; keys are count:<name>, the time counting started, and token:<address> for the
 * index of scanned tokens.
 */
export class StatsStore extends DurableObject<Env> implements Stats, TokenIndex {
  async add(key: StatKey, n = 1): Promise<void> {
    const k = `count:${key}`;
    const current = (await this.ctx.storage.get<number>(k)) ?? 0;
    const writes: Record<string, unknown> = { [k]: current + n };
    if (!(await this.ctx.storage.get<string>("since"))) writes.since = new Date().toISOString();
    await this.ctx.storage.put(writes);
  }

  async all(): Promise<{ since: string | null; counters: Record<string, number> }> {
    const rows = await this.ctx.storage.list<number>({ prefix: "count:" });
    const counters: Record<string, number> = {};
    for (const [k, v] of rows) counters[k.slice("count:".length)] = v;
    return { since: (await this.ctx.storage.get<string>("since")) ?? null, counters };
  }

  async noteToken(token: IndexedToken): Promise<void> {
    await this.ctx.storage.put(`token:${token.address.toLowerCase()}`, token);
    const all = await this.ctx.storage.list<IndexedToken>({ prefix: "token:" });
    if (all.size <= TOKEN_INDEX_MAX) return;
    const old = [...all.entries()].sort((a, b) => b[1].at - a[1].at).slice(TOKEN_INDEX_MAX);
    for (let i = 0; i < old.length; i += 128)
      await this.ctx.storage.delete(old.slice(i, i + 128).map(([k]) => k));
  }

  async tokens(limit = TOKEN_INDEX_MAX): Promise<IndexedToken[]> {
    const all = await this.ctx.storage.list<IndexedToken>({ prefix: "token:" });
    return [...all.values()].sort((a, b) => b.at - a.at).slice(0, limit);
  }
}
