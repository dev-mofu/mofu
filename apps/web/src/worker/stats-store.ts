import { DurableObject } from "cloudflare:workers";
import type { CodeMatch, DeployerToken } from "../shared/api.js";
import {
  type CodeEntry,
  type CreatorEntry,
  type CreatorSummary,
  type LaunchCache,
  nameKeys,
  summarizeCreators,
  normalizeName,
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
    await this.rememberTokens([token]);
    const all = await this.ctx.storage.list<IndexedToken>({ prefix: "token:" });
    if (all.size <= TOKEN_INDEX_MAX) return;
    const old = [...all.entries()].sort((a, b) => b[1].at - a[1].at).slice(TOKEN_INDEX_MAX);
    for (let i = 0; i < old.length; i += 128)
      await this.ctx.storage.delete(old.slice(i, i + 128).map(([k]) => k));
  }

  async rememberTokens(tokens: IndexedToken[]): Promise<void> {
    const entries = tokens.slice(0, 60).flatMap((t) => nameKeys(t).map((k) => [k, t] as const));
    // Keep the first time Mofu saw each one: what "came first" falls back to.
    for (let i = 0; i < entries.length; i += 64) {
      const part = entries.slice(i, i + 64);
      const existing = await this.ctx.storage.get<IndexedToken>(part.map(([k]) => k));
      const writes: Record<string, IndexedToken> = {};
      for (const [k, t] of part) {
        const prev = existing.get(k);
        writes[k] = prev ? { ...t, at: Math.min(prev.at, t.at) } : t;
      }
      await this.ctx.storage.put(writes);
    }
  }

  async similar(
    name: string | null,
    symbol: string | null,
    exclude: string,
  ): Promise<IndexedToken[]> {
    const found = new Map<string, IndexedToken>();
    for (const [prefix, value] of [
      ["sym", normalizeName(symbol)],
      ["nam", normalizeName(name)],
    ] as const) {
      if (!value) continue;
      const rows = await this.ctx.storage.list<IndexedToken>({
        prefix: `${prefix}:${value}:`,
        limit: 50,
      });
      for (const t of rows.values())
        if (t.address !== exclude.toLowerCase() && !found.has(t.address)) found.set(t.address, t);
    }
    return [...found.values()].sort((a, b) => a.at - b.at).slice(0, 10);
  }

  async noteCode(fingerprint: string, entry: CodeEntry): Promise<void> {
    if (!/^[0-9a-f]{32}$/.test(fingerprint)) return;
    await this.ctx.storage.put(`code:${fingerprint}:${entry.address.toLowerCase()}`, {
      ...entry,
      address: entry.address.toLowerCase(),
      at: Date.now(),
    });
  }

  async codeMatches(fingerprint: string, exclude: string): Promise<CodeMatch> {
    const rows = await this.ctx.storage.list<CodeEntry>({
      prefix: `code:${fingerprint}:`,
      limit: 500,
    });
    const others = [...rows.values()].filter((e) => e.address !== exclude.toLowerCase());
    const failed = others.filter((e) => e.outcome === "failed");
    return {
      flagged: failed.length,
      passed: others.length - failed.length,
      examples: failed.slice(0, 3).map((e) => ({ address: e.address, symbol: e.symbol })),
    };
  }

  async noteCreator(creator: string, entry: CreatorEntry): Promise<void> {
    const c = creator.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(c)) return;
    await this.ctx.storage.put(`creator:${c}:${entry.address.toLowerCase()}`, {
      ...entry,
      address: entry.address.toLowerCase(),
    });
  }

  async creatorTokens(creator: string, also: string[]): Promise<DeployerToken[]> {
    const c = creator.toLowerCase();
    const rows = await this.ctx.storage.list<CreatorEntry>({ prefix: `creator:${c}:`, limit: 200 });
    const out = new Map<string, DeployerToken>();
    for (const e of rows.values())
      out.set(e.address, {
        address: e.address,
        symbol: e.symbol,
        verdict: e.verdict,
        honeypot: e.honeypot,
      });
    const rest = [...new Set(also.map((a) => a.toLowerCase()))].filter((a) => !out.has(a));
    const known = rest.length
      ? await this.ctx.storage.get<IndexedToken>(rest.slice(0, 100).map((a) => `token:${a}`))
      : new Map<string, IndexedToken>();
    for (const a of rest) {
      const t = known.get(`token:${a}`);
      out.set(a, {
        address: a,
        symbol: t?.symbol ?? null,
        verdict: t?.verdict ?? null,
        honeypot: false,
      });
    }
    return [...out.values()];
  }

  async creatorBoard(): Promise<CreatorSummary[]> {
    const rows = await this.ctx.storage.list<CreatorEntry>({ prefix: "creator:", limit: 20_000 });
    return summarizeCreators([...rows.entries()]);
  }

  async creatorRecords(creator: string): Promise<CreatorEntry[]> {
    const rows = await this.ctx.storage.list<CreatorEntry>({
      prefix: `creator:${creator.toLowerCase()}:`,
      limit: 200,
    });
    return [...rows.values()].sort((a, b) => b.at - a.at);
  }

  async launchCache(token: string): Promise<LaunchCache | null> {
    return (await this.ctx.storage.get<LaunchCache>(`launch:${token.toLowerCase()}`)) ?? null;
  }

  async saveLaunch(token: string, cache: LaunchCache): Promise<void> {
    await this.ctx.storage.put(`launch:${token.toLowerCase()}`, cache);
  }

  async tokens(limit = TOKEN_INDEX_MAX): Promise<IndexedToken[]> {
    const all = await this.ctx.storage.list<IndexedToken>({ prefix: "token:" });
    return [...all.values()].sort((a, b) => b.at - a.at).slice(0, limit);
  }
}
