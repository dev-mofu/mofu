/** Per-IP daily message counting. Pure functions; the Durable Object stores the state. */

export interface UsageState {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  count: number;
}

/** Separate daily counters: user messages, and automatic tool follow-ups. */
export type UsageBucket = "messages" | "followups";

export interface UsageResult {
  allowed: boolean;
  remaining: number;
  /** ISO time of the next reset (UTC midnight). */
  resetAt: string;
}

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/**
 * Decides whether a message is allowed and returns the new state.
 * With consume=false it only reports the current numbers.
 */
export function evaluateUsage(
  state: UsageState | undefined,
  now: number,
  limit: number,
  consume: boolean,
): { state: UsageState; result: UsageResult } {
  const day = utcDay(now);
  const current = state && state.day === day ? state : { day, count: 0 };
  const resetAt = new Date(nextUtcMidnight(now)).toISOString();
  if (!consume) {
    return {
      state: current,
      result: {
        allowed: current.count < limit,
        remaining: Math.max(0, limit - current.count),
        resetAt,
      },
    };
  }
  if (current.count >= limit) {
    return { state: current, result: { allowed: false, remaining: 0, resetAt } };
  }
  const next = { day, count: current.count + 1 };
  return { state: next, result: { allowed: true, remaining: limit - next.count, resetAt } };
}
