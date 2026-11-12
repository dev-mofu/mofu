import { DurableObject } from "cloudflare:workers";
import type { StatKey, Stats } from "./stats.js";

/** One instance; keys are count:<name>, plus the time counting started. */
export class StatsStore extends DurableObject<Env> implements Stats {
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
}
