import { DurableObject } from "cloudflare:workers";
import { evaluateUsage, nextUtcMidnight, type UsageResult, type UsageState } from "./usage.js";

const KEY = "usage";
/** Delete per-IP state an hour after the daily reset, so nothing IP-derived lingers. */
const CLEANUP_DELAY_MS = 60 * 60 * 1000;

/**
 * One instance per client IP. Durable Objects process requests one at a
 * time, so concurrent messages can't slip past the limit.
 */
export class UsageLimiter extends DurableObject<Env> {
  async check(limit: number, consume: boolean): Promise<UsageResult> {
    const now = Date.now();
    const stored = await this.ctx.storage.get<UsageState>(KEY);
    const { state, result } = evaluateUsage(stored, now, limit, consume);
    if (consume && result.allowed) {
      await this.ctx.storage.put(KEY, state);
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(nextUtcMidnight(now) + CLEANUP_DELAY_MS);
      }
    }
    return result;
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
