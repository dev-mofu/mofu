/**
 * mofu-sdk: Mofu's Robinhood Chain checks for agents, bots and scripts.
 * No dependencies; works wherever fetch and WebCrypto exist (Node 18+, browsers, Workers, Deno, Bun).
 */
import type {
  Checked,
  TokenReport,
  Verdict,
  WalletReport,
  Webhook,
  WebhookEvent,
  WebhookEventType,
} from "./types.js";

export * from "./types.js";

export interface MofuOptions {
  /** Defaults to https://mofu.works. */
  baseUrl?: string;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Sent as User-Agent where the runtime allows it. */
  userAgent?: string;
  /** Per request, in milliseconds. Defaults to 90 000 (a first scan can take half a minute). */
  timeoutMs?: number;
}

/** An answer from Mofu that isn't a report: a bad address, the daily limit, the chain unreachable. */
export class MofuError extends Error {
  override name = "MofuError";
  constructor(
    message: string,
    /** HTTP status, or 0 when Mofu couldn't be reached. */
    readonly status: number,
    /** Mofu's error code, e.g. "daily_limit", "bad_address", "network". */
    readonly code: string,
  ) {
    super(message);
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export class Mofu {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: MofuOptions = {}) {
    this.base = (options.baseUrl ?? "https://mofu.works").replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.headers = {
      Accept: "application/json",
      "User-Agent": options.userAgent ?? "mofu-sdk/0.1",
    };
    this.timeoutMs = options.timeoutMs ?? 90_000;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        ...init,
        headers: {
          ...this.headers,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new MofuError(`Couldn't reach Mofu: ${(err as Error).message}`, 0, "network");
    }
    const body = (await res.json().catch(() => null)) as
      (T & { error?: { code?: string; message?: string } }) | null;
    if (!res.ok || !body) {
      throw new MofuError(
        body?.error?.message ?? `Mofu answered HTTP ${res.status}`,
        res.status,
        body?.error?.code ?? "http_error",
      );
    }
    return body;
  }

  private static address(a: string, what: string) {
    if (!ADDRESS.test(a))
      throw new MofuError(`${what} must be 0x followed by 40 hex characters`, 400, "bad_address");
    return a.toLowerCase();
  }

  /** The Token Scanner report for a token contract on Robinhood Chain. */
  scanToken(address: string): Promise<Checked<TokenReport>> {
    return this.call(`/api/v1/token/${Mofu.address(address, "address")}`);
  }

  /** Wallet Health: every active approval (risky ones flagged) and the tokens a wallet holds. */
  checkWallet(address: string): Promise<Checked<WalletReport>> {
    return this.call(`/api/v1/wallet/${Mofu.address(address, "address")}`);
  }

  /** Scans a token and applies a buy rule. Says no, with a reason, when Mofu can't be reached. */
  async checkBeforeBuy(address: string, policy: Partial<Policy> = {}): Promise<Decision> {
    try {
      return decide((await this.scanToken(address)).report, policy);
    } catch (err) {
      return {
        allowed: false,
        reasons: [`no answer from Mofu: ${(err as Error).message}`],
        report: null,
      };
    }
  }

  readonly webhooks = {
    /**
     * Watches up to 10 tokens. Mofu pings the URL first and saves the webhook only if it answers
     * 2xx. The secret comes back once: keep it.
     */
    create: (input: { url: string; tokens: string[]; events?: WebhookEventType[] }) =>
      this.call<{ webhook: Webhook; secret: string }>("/api/v1/webhooks", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    get: async (id: string, secret: string) =>
      (await this.call<{ webhook: Webhook }>(`/api/v1/webhooks/${id}`, { headers: auth(secret) }))
        .webhook,
    test: (id: string, secret: string) =>
      this.call<{ delivered: boolean; result: string }>(`/api/v1/webhooks/${id}/test`, {
        method: "POST",
        headers: auth(secret),
      }),
    remove: async (id: string, secret: string) => {
      await this.call(`/api/v1/webhooks/${id}`, { method: "DELETE", headers: auth(secret) });
    },
  };
}

const auth = (secret: string) => ({ Authorization: `Bearer ${secret}` });

// ---------------------------------------------------------------- buy rule

export interface Policy {
  /** Verdicts that block a buy. Default: ["risky"]. */
  blockVerdicts: Verdict[];
  /** Block when no sell could be simulated. Default: true. */
  requireSellTest: boolean;
  /** Default: 10. */
  maxBuyTaxPercent: number;
  /** Default: 10. */
  maxSellTaxPercent: number;
  /** Block when another token uses the same name or ticker. Default: false. */
  blockLookalikes: boolean;
  /** Block when one sale of this much ETH would move the price more than 10%. Default: off. */
  minSellDepthEth: number | null;
}

export const DEFAULT_POLICY: Policy = {
  blockVerdicts: ["risky"],
  requireSellTest: true,
  maxBuyTaxPercent: 10,
  maxSellTaxPercent: 10,
  blockLookalikes: false,
  minSellDepthEth: null,
};

export interface Decision {
  allowed: boolean;
  /** Why it was blocked; empty when allowed. */
  reasons: string[];
  report: TokenReport | null;
}

/** Applies a buy rule to a report. Pure: test it, tune it, log it. */
export function decide(r: TokenReport, policy: Partial<Policy> = {}): Decision {
  const p = { ...DEFAULT_POLICY, ...policy };
  const reasons: string[] = [];
  if (!r.isContract) reasons.push("not a token contract");
  if (p.blockVerdicts.includes(r.verdict)) reasons.push(`Mofu's verdict is ${r.verdict}`);
  for (const c of r.checks) if (c.status === "risk") reasons.push(`${c.label} ${c.detail}`);
  const t = r.sellTest;
  if (t?.status === "failed") reasons.push("a simulated sell failed (possible honeypot)");
  else if (!t || t.status !== "passed") {
    if (p.requireSellTest) reasons.push("Mofu couldn't test selling it");
  } else {
    if ((t.buyTaxPercent ?? 0) > p.maxBuyTaxPercent)
      reasons.push(`buy tax ${t.buyTaxPercent}% is over ${p.maxBuyTaxPercent}%`);
    if ((t.sellTaxPercent ?? 0) > p.maxSellTaxPercent)
      reasons.push(`sell tax ${t.sellTaxPercent}% is over ${p.maxSellTaxPercent}%`);
    if (p.minSellDepthEth !== null) {
      const d = t.depth;
      if (!d) reasons.push("sell depth couldn't be measured");
      else if (!d.moreThan && (d.ethAt10Percent ?? 0) < p.minSellDepthEth)
        reasons.push(
          `a ${p.minSellDepthEth} ETH sale would move the price more than 10% (depth about ${d.ethAt10Percent ?? 0} ETH)`,
        );
    }
  }
  if (p.blockLookalikes && r.lookalikes.length)
    reasons.push(`${r.lookalikes.length} other token(s) use the same name or ticker`);
  return { allowed: reasons.length === 0, reasons: [...new Set(reasons)], report: r };
}

// ---------------------------------------------------------------- webhooks

/**
 * Checks a Mofu-Signature header (t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">) against
 * the raw request body. Rejects signatures older than `toleranceSeconds` (default 300).
 */
export async function verifyWebhook(
  signatureHeader: string | null | undefined,
  rawBody: string,
  secret: string,
  options: { toleranceSeconds?: number; now?: number } = {},
): Promise<boolean> {
  const parts = Object.fromEntries(
    (signatureHeader ?? "").split(",").map((p) => p.trim().split("=", 2) as [string, string]),
  );
  const t = Number(parts.t);
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (!Number.isFinite(t) || !parts.v1 || Math.abs(now - t) > (options.toleranceSeconds ?? 300))
    return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = parts.v1.toLowerCase();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** Verifies and parses a webhook delivery. Throws MofuError("bad_signature") when it doesn't check out. */
export async function parseWebhook(
  signatureHeader: string | null | undefined,
  rawBody: string,
  secret: string,
  options?: { toleranceSeconds?: number; now?: number },
): Promise<WebhookEvent> {
  if (!(await verifyWebhook(signatureHeader, rawBody, secret, options)))
    throw new MofuError("The webhook signature doesn't match", 401, "bad_signature");
  return JSON.parse(rawBody) as WebhookEvent;
}
