import { DurableObject } from "cloudflare:workers";
import type { TokenScanReport } from "../shared/api.js";
import { parseRpcUrls } from "./chain.js";
import {
  addressOf,
  entryFromReport,
  publishBatch,
  verdictKey,
  type VerdictEntry,
} from "./verdicts.js";

const BATCH = 25;
const INTERVAL_MS = 10 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const MAX_PENDING = 500;

export interface PublisherStatus {
  enabled: boolean;
  /** Why it's off, when it is. */
  problem: string | null;
  contract: string | null;
  writer: string | null;
  pending: number;
  publishedToday: number;
  dailyLimit: number;
  last: { hash: string | null; at: string; count: number; error: string | null } | null;
}

type Env2 = Env & { VERDICT_SIGNER_KEY?: string };

/**
 * The signer key from the secret. Pasting the whole `cast wallet new` output (with "Private key:"
 * and the 40-character address) still works: exactly one 64-hex-character value is the key.
 */
export function signerKeyFrom(secret: string): string | null {
  const found = secret.match(/(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/g) ?? [];
  if (found.length !== 1) return null;
  const key = found[0]!.replace(/^0x/, "");
  return `0x${key.toLowerCase()}`;
}

/** Why publishing is off, in words that never include the key itself. */
const problem = (env: Env2): string | null => {
  const contract = String(env.VERDICTS_CONTRACT ?? "").trim();
  const secret = String(env.VERDICT_SIGNER_KEY ?? "").trim();
  if (!contract) return "no registry address (VERDICTS_CONTRACT)";
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract))
    return "the registry address isn't 0x + 40 hex characters";
  if (!secret) return "no VERDICT_SIGNER_KEY secret";
  const found = secret.match(/(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/g) ?? [];
  if (found.length === 0)
    return `no 64-character private key found in the secret (${secret.length} characters)`;
  if (found.length > 1)
    return "the secret has more than one 64-character value; put only the private key in it";
  return null;
};

const config = (env: Env2) => {
  const contract = String(env.VERDICTS_CONTRACT ?? "")
    .trim()
    .toLowerCase();
  const key = signerKeyFrom(String(env.VERDICT_SIGNER_KEY ?? ""));
  return /^0x[0-9a-f]{40}$/.test(contract) && key ? { contract, key } : null;
};
export const publishingEnabled = (env: Env) => config(env as Env2) !== null;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * One instance. Scans queue their verdict here; the alarm publishes changed ones to the
 * MofuVerdicts registry in batches, at most VERDICT_DAILY_TXS transactions a day.
 */
export class VerdictPublisher extends DurableObject<Env> {
  async note(entry: VerdictEntry): Promise<void> {
    if (!config(this.env as Env2)) return;
    const published = await this.ctx.storage.get<string>(`published:${entry.token}`);
    if (published === verdictKey(entry)) {
      await this.ctx.storage.delete(`pending:${entry.token}`);
      return;
    }
    const pending = (await this.ctx.storage.get<number>("pendingCount")) ?? 0;
    const already = await this.ctx.storage.get(`pending:${entry.token}`);
    if (!already && pending >= MAX_PENDING) return;
    await this.ctx.storage.put({
      [`pending:${entry.token}`]: entry,
      ...(already ? {} : { pendingCount: pending + 1 }),
    });
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + INTERVAL_MS);
  }

  async status(): Promise<PublisherStatus> {
    const c = config(this.env as Env2);
    const now = Date.now();
    return {
      enabled: !!c,
      problem: c ? null : problem(this.env as Env2),
      contract: c?.contract ?? null,
      writer: c ? addressOf(c.key) : null,
      pending: (await this.ctx.storage.get<number>("pendingCount")) ?? 0,
      publishedToday: (await this.ctx.storage.get<number>(`day:${day(now)}`)) ?? 0,
      dailyLimit: Math.max(0, Number.parseInt(String(this.env.VERDICT_DAILY_TXS), 10) || 0),
      last: (await this.ctx.storage.get<PublisherStatus["last"]>("last")) ?? null,
    };
  }

  override async alarm(): Promise<void> {
    const c = config(this.env as Env2);
    if (!c) return;
    const now = Date.now();
    const limit = Math.max(0, Number.parseInt(String(this.env.VERDICT_DAILY_TXS), 10) || 0);
    const today = (await this.ctx.storage.get<number>(`day:${day(now)}`)) ?? 0;
    if (today >= limit) {
      const tomorrow = Date.UTC(
        new Date(now).getUTCFullYear(),
        new Date(now).getUTCMonth(),
        new Date(now).getUTCDate() + 1,
      );
      await this.ctx.storage.setAlarm(tomorrow + 5 * 60 * 1000);
      return;
    }
    const rows = await this.ctx.storage.list<VerdictEntry>({ prefix: "pending:", limit: BATCH });
    const entries = [...rows.values()];
    if (entries.length === 0) return;
    try {
      const hash = await publishBatch(
        {
          rpcUrls: parseRpcUrls(this.env.HOLDER_RPC_URL),
          fetch,
          contract: c.contract,
          privateKey: c.key,
        },
        entries,
      );
      const pending = (await this.ctx.storage.get<number>("pendingCount")) ?? entries.length;
      const writes: Record<string, unknown> = {
        [`day:${day(now)}`]: today + 1,
        pendingCount: Math.max(0, pending - entries.length),
        last: { hash, at: new Date(now).toISOString(), count: entries.length, error: null },
      };
      for (const e of entries) writes[`published:${e.token}`] = verdictKey(e);
      await this.ctx.storage.put(writes);
      await this.ctx.storage.delete(entries.map((e) => `pending:${e.token}`));
      if (pending - entries.length > 0) await this.ctx.storage.setAlarm(now + INTERVAL_MS);
    } catch (err) {
      // Most likely the writer is out of gas money or an RPC hiccup: keep the queue, try later.
      await this.ctx.storage.put("last", {
        hash: null,
        at: new Date(now).toISOString(),
        count: 0,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
      await this.ctx.storage.setAlarm(now + RETRY_MS);
    }
  }
}

/** Queues a fresh scan's verdict for publishing, in the background. Does nothing when off. */
export function queueVerdict(
  env: Env,
  report: TokenScanReport,
  now: number,
  background: (p: Promise<unknown>) => void,
): void {
  if (!report.isContract || !publishingEnabled(env)) return;
  try {
    const stub = env.PUBLISHER.get(env.PUBLISHER.idFromName("global"));
    background(stub.note(entryFromReport(report, now)).catch(() => undefined));
  } catch {
    // no binding (tests, local runs)
  }
}
