/**
 * Mofu's public API at /api/v1: the Token Scanner, Wallet Health and webhooks for scripts, bots,
 * trading agents and mofu-cli. No login and no browser check; calls are limited per IP per day,
 * sharing one daily allowance with the MCP server.
 */
import { Hono, type Context } from "hono";
import type { TokenScanReport, WalletReport } from "../shared/api.js";
import type { AppDeps } from "./app.js";
import { parseRpcUrls, rpcBatch, callOf } from "./chain.js";
import type { ChainDataOptions } from "./chain-data.js";
import { isAddress } from "./holder.js";
import { withLookalikes } from "./lookalike.js";
import { statsFromEnv, tokenIndexFromEnv, type StatKey } from "./stats.js";
import { decodeString, scanToken, summaryOnly } from "./token-scan.js";
import type { UsageResult } from "./usage.js";
import { walletReport } from "./wallet.js";
import type { CreateResult } from "./webhook-store.js";
import { queueVerdict, type PublisherStatus } from "./verdict-store.js";
import { FLAG } from "./verdicts.js";
import {
  checkWebhookUrl,
  deliver,
  MAX_TOKENS_PER_HOOK,
  newHookId,
  newSecret,
  randomHex,
  WEBHOOK_EVENTS,
  type DeliveryResult,
  type PublicHook,
  type WebhookEventType,
} from "./webhooks.js";

/** The WebhookStore methods the API uses; a fake in tests. */
export interface Webhooks {
  create(input: {
    id: string;
    url: string;
    secret: string;
    tokens: Array<{ address: string; name: string | null; symbol: string | null }>;
    events: WebhookEventType[];
    now: number;
  }): Promise<CreateResult>;
  get(id: string, secret: string): Promise<PublicHook | null>;
  remove(id: string, secret: string): Promise<boolean>;
  test(id: string, secret: string, now: number): Promise<DeliveryResult | null>;
}

export interface PublicApiDeps extends AppDeps {
  getWebhooks?: (env: Env) => Webhooks;
}

const webhooksFromEnv = (env: Env): Webhooks => env.WEBHOOKS.get(env.WEBHOOKS.idFromName("global"));

type Ctx = Context<{ Bindings: Env }>;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Expose-Headers": "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset",
};

const DOCS = "https://mofu.works/docs/#api";

const err = (
  c: Ctx,
  status: 400 | 401 | 404 | 422 | 429 | 500 | 503,
  code: string,
  message: string,
) => c.json({ error: { code, message, docs: DOCS } }, status);

const intVar = (v: unknown) => Math.max(0, Number.parseInt(String(v), 10) || 0);

export function createPublicApi(deps: PublicApiDeps) {
  const app = new Hono<{ Bindings: Env }>().basePath("/api/v1");
  const ip = (c: Ctx) => c.req.header("CF-Connecting-IP") ?? "local";
  const fromCli = (c: Ctx) => (c.req.header("User-Agent") ?? "").startsWith("mofu-cli/");

  const chainData = (env: Env, urls: readonly string[]): ChainDataOptions | undefined => {
    const apiKey = (env as Env & { GOLDRUSH_API_KEY?: string }).GOLDRUSH_API_KEY;
    return apiKey
      ? {
          apiKey,
          chain: String(env.GOLDRUSH_CHAIN ?? "robinhood-mainnet"),
          rpcUrls: urls,
          fetch: deps.fetch,
        }
      : undefined;
  };

  const background = (c: Ctx, p: Promise<unknown>) => {
    try {
      c.executionCtx.waitUntil(p.catch(() => undefined));
    } catch {
      p.catch(() => undefined); // no execution context in tests
    }
  };
  const record = (c: Ctx, key: StatKey) => {
    try {
      background(c, (deps.getStats ?? statsFromEnv)(c.env).add(key));
    } catch {
      // no STATS binding
    }
  };
  const index = (c: Ctx) => {
    try {
      return (deps.getTokenIndex ?? tokenIndexFromEnv)(c.env);
    } catch {
      return null;
    }
  };

  /** One call from the shared MCP/API allowance. Sets the rate-limit headers either way. */
  const spend = async (c: Ctx): Promise<{ usage: UsageResult; limit: number }> => {
    const limit = intVar(c.env.MCP_DAILY_LIMIT);
    const usage = await deps.getLimiter(c.env).check(ip(c), limit, true, "mcp");
    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(usage.remaining));
    c.header("X-RateLimit-Reset", usage.resetAt);
    return { usage, limit };
  };
  const limited = (c: Ctx, limit: number, resetAt: string) =>
    err(
      c,
      429,
      "daily_limit",
      `The daily allowance of ${limit} calls from this network is used up (shared with Mofu's MCP server). It resets at ${resetAt}.`,
    );

  app.use("*", async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(CORS)) c.header(k, v);
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
  });
  app.options("*", (c) => c.body(null, 204));
  app.onError((e, c) => {
    console.error("API error:", e.name);
    return err(c, 500, "server_error", "Something went wrong on Mofu's side. Try again.");
  });
  app.notFound((c) => err(c, 404, "not_found", "No such endpoint. See the docs."));

  app.get("/", (c) =>
    c.json({
      name: "Mofu API",
      docs: DOCS,
      chain: { name: "Robinhood Chain", id: 4663 },
      dailyLimit: intVar(c.env.MCP_DAILY_LIMIT),
      endpoints: {
        "GET /api/v1/token/{address}": "Token Scanner report for a token contract",
        "GET /api/v1/wallet/{address}":
          "Wallet Health: approvals (risky ones flagged) and holdings",
        "POST /api/v1/webhooks": "Watch tokens and get a signed POST when one changes",
        "GET /api/v1/webhooks/{id}": "A webhook's status (Authorization: Bearer <secret>)",
        "POST /api/v1/webhooks/{id}/test": "Send a test event",
        "DELETE /api/v1/webhooks/{id}": "Delete a webhook",
        "GET /api/v1/onchain":
          "Where Mofu publishes verdicts on Robinhood Chain, and how to read them",
      },
      events: WEBHOOK_EVENTS,
    }),
  );

  // On-chain verdicts: where they're published and how far along.
  app.get("/onchain", async (c) => {
    const registry = String(c.env.VERDICTS_CONTRACT ?? "") || null;
    const status: PublisherStatus | null = await Promise.resolve()
      .then(() => c.env.PUBLISHER.get(c.env.PUBLISHER.idFromName("global")).status())
      .catch(() => null);
    return c.json({
      chain: { name: "Robinhood Chain", id: 4663 },
      registry,
      enabled: status?.enabled ?? false,
      writer: status?.writer ?? null,
      read: registry
        ? `cast call ${registry} "verdictOf(address)(uint8,uint8,uint40,bytes16)" <token> --rpc-url https://robinhood-rpc.publicnode.com`
        : null,
      verdicts: { 0: "not scanned", 1: "clean", 2: "caution", 3: "risky" },
      flags: FLAG,
      pending: status?.pending ?? 0,
      publishedToday: status?.publishedToday ?? 0,
      last: status?.last ?? null,
    });
  });

  const tokenCache = new Map<string, { report: TokenScanReport; at: number }>();
  app.get("/token/:address", async (c) => {
    const address = c.req.param("address").toLowerCase();
    if (!isAddress(address))
      return err(c, 400, "bad_address", "The address must be 0x followed by 40 hex characters.");
    const urls = parseRpcUrls(c.env.HOLDER_RPC_URL);
    if (urls.length === 0) return err(c, 503, "unavailable", "The Token Scanner isn't available.");
    const { usage, limit } = await spend(c);
    if (!usage.allowed) return limited(c, limit, usage.resetAt);
    const now = deps.now();
    const hit = tokenCache.get(address);
    let report: TokenScanReport;
    if (hit && now - hit.at < 2 * 60 * 1000) report = hit.report;
    else {
      try {
        const data = chainData(c.env, urls);
        report = summaryOnly(
          await withLookalikes(
            await scanToken(urls, address, deps.fetch, data && { ...data, now }),
            index(c),
            data,
          ),
        );
      } catch {
        return err(
          c,
          503,
          "chain_unreachable",
          "Couldn't reach Robinhood Chain right now. Try again in a minute.",
        );
      }
      tokenCache.set(address, { report, at: now });
      queueVerdict(c.env, report, now, (x) => background(c, x));
      if (tokenCache.size > 500) tokenCache.clear();
      record(c, fromCli(c) ? "cli_scan_token" : "api_scan_token");
      const idx = index(c);
      if (idx && report.isContract && (report.token.name || report.token.symbol)) {
        background(
          c,
          idx.noteToken({
            address,
            name: report.token.name,
            symbol: report.token.symbol,
            verdict: report.verdict,
            at: now,
          }),
        );
      }
    }
    return c.json({
      report,
      url: `https://mofu.works/token/${address}`,
      remaining: usage.remaining,
      limit,
    });
  });

  const walletCache = new Map<string, { report: WalletReport; at: number }>();
  app.get("/wallet/:address", async (c) => {
    const address = c.req.param("address").toLowerCase();
    if (!isAddress(address))
      return err(c, 400, "bad_address", "The address must be 0x followed by 40 hex characters.");
    const data = chainData(c.env, parseRpcUrls(c.env.HOLDER_RPC_URL));
    if (!data) return err(c, 503, "unavailable", "Wallet Health isn't available right now.");
    const { usage, limit } = await spend(c);
    if (!usage.allowed) return limited(c, limit, usage.resetAt);
    const now = deps.now();
    const hit = walletCache.get(address);
    let report: WalletReport;
    if (hit && now - hit.at < 20 * 1000) report = hit.report;
    else {
      report = await walletReport({ ...data, now }, address);
      if (report.status.approvals === "unavailable" && report.status.holdings === "unavailable") {
        return err(
          c,
          503,
          "chain_unreachable",
          "That wallet couldn't be read right now. Try again in a minute.",
        );
      }
      walletCache.set(address, { report, at: now });
      if (walletCache.size > 300) walletCache.clear();
      record(c, fromCli(c) ? "cli_check_wallet" : "api_check_wallet");
    }
    return c.json({
      report,
      url: `https://mofu.works/app/?scan=${address}`,
      remaining: usage.remaining,
      limit,
    });
  });

  // Webhooks ---------------------------------------------------------------------------------

  const hooks = (c: Ctx) => (deps.getWebhooks ?? webhooksFromEnv)(c.env);
  const bearer = (c: Ctx) => {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "");
    return m?.[1] ?? "";
  };
  const validId = (id: string) => /^wh_[0-9a-f]{24}$/.test(id);
  const notYours = (c: Ctx) =>
    err(
      c,
      404,
      "not_found",
      "No webhook with that id and secret. Send the secret as Authorization: Bearer <secret>.",
    );

  app.post("/webhooks", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      url?: unknown;
      tokens?: unknown;
      events?: unknown;
    } | null;
    if (!body)
      return err(c, 400, "bad_request", 'Send JSON: { "url": "https://…", "tokens": ["0x…"] }.');
    const checked = checkWebhookUrl(body.url);
    if ("error" in checked) return err(c, 422, "bad_url", checked.error);
    const list = Array.isArray(body.tokens) ? body.tokens : [];
    const tokens = [...new Set(list.map((t) => String(t).toLowerCase()))];
    if (
      tokens.length === 0 ||
      tokens.length > MAX_TOKENS_PER_HOOK ||
      !tokens.every((t) => isAddress(t))
    ) {
      return err(
        c,
        422,
        "bad_tokens",
        `tokens must be a list of 1 to ${MAX_TOKENS_PER_HOOK} token addresses (0x followed by 40 hex characters).`,
      );
    }
    let events: WebhookEventType[] = [...WEBHOOK_EVENTS];
    if (body.events !== undefined) {
      const wanted = Array.isArray(body.events) ? body.events.map(String) : [];
      const bad = wanted.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
      if (wanted.length === 0 || bad.length) {
        return err(
          c,
          422,
          "bad_events",
          `events must be a list from: ${WEBHOOK_EVENTS.join(", ")}.`,
        );
      }
      events = [...new Set(wanted)] as WebhookEventType[];
    }
    const limit = intVar(c.env.WEBHOOK_DAILY_LIMIT);
    const usage = await deps.getLimiter(c.env).check(ip(c), limit, true, "webhooks");
    if (!usage.allowed) {
      return err(
        c,
        429,
        "daily_limit",
        `You can create ${limit} webhooks a day from one network. It resets at ${usage.resetAt}.`,
      );
    }

    // Every address must be a contract; its name and ticker label the events.
    const urls = parseRpcUrls(c.env.HOLDER_RPC_URL);
    let meta: Array<{ address: string; name: string | null; symbol: string | null }>;
    try {
      const out = await rpcBatch(
        urls,
        tokens.flatMap((t) => [
          { method: "eth_getCode", params: [t, "latest"] },
          callOf(t, "0x06fdde03"),
          callOf(t, "0x95d89b41"),
        ]),
        deps.fetch,
      );
      const notContracts = tokens.filter((_, i) => {
        const code = out[i * 3] ?? "0x";
        return code === "0x" || code.toLowerCase().startsWith("0xef0100");
      });
      if (notContracts.length) {
        return err(
          c,
          422,
          "not_a_token",
          `Not a token contract on Robinhood Chain: ${notContracts.join(", ")}.`,
        );
      }
      meta = tokens.map((address, i) => ({
        address,
        name: decodeString(out[i * 3 + 1] ?? "0x"),
        symbol: decodeString(out[i * 3 + 2] ?? "0x"),
      }));
    } catch {
      return err(
        c,
        503,
        "chain_unreachable",
        "Couldn't reach Robinhood Chain right now. Try again in a minute.",
      );
    }

    // The URL has to answer a signed ping with 2xx: proof it's yours and it's listening.
    const secret = newSecret();
    const id = newHookId();
    const now = deps.now();
    const ping = await deliver(
      deps.fetch,
      { id, url: checked.url, secret },
      {
        id: `evt_${randomHex(12)}`,
        type: "ping",
        createdAt: new Date(now).toISOString(),
        token: null,
        summary: "Mofu is checking that this URL accepts webhooks. Answer with any 2xx status.",
        before: null,
        after: null,
        report: null,
      },
      now,
    );
    if (!ping.ok) {
      return err(
        c,
        422,
        "ping_failed",
        `Your URL didn't answer Mofu's ping with a 2xx status (got: ${ping.result}). Make sure it accepts POST requests, then try again.`,
      );
    }
    const created = await hooks(c).create({
      id,
      url: checked.url,
      secret,
      tokens: meta,
      events,
      now,
    });
    if ("error" in created) return err(c, 503, "full", created.error);
    record(c, "webhook_created");
    return c.json(
      {
        webhook: created.hook,
        secret,
        note: "Keep the secret: it verifies Mofu-Signature on every event and is the only way to manage this webhook. It isn't shown again.",
      },
      201,
    );
  });

  app.get("/webhooks/:id", async (c) => {
    const id = c.req.param("id");
    if (!validId(id) || !bearer(c)) return notYours(c);
    const hook = await hooks(c).get(id, bearer(c));
    return hook ? c.json({ webhook: hook }) : notYours(c);
  });

  app.delete("/webhooks/:id", async (c) => {
    const id = c.req.param("id");
    if (!validId(id) || !bearer(c)) return notYours(c);
    return (await hooks(c).remove(id, bearer(c))) ? c.json({ deleted: true }) : notYours(c);
  });

  app.post("/webhooks/:id/test", async (c) => {
    const id = c.req.param("id");
    if (!validId(id) || !bearer(c)) return notYours(c);
    const limit = intVar(c.env.WEBHOOK_DAILY_LIMIT) * 4;
    const usage = await deps.getLimiter(c.env).check(ip(c), limit, true, "webhook_tests");
    if (!usage.allowed)
      return err(
        c,
        429,
        "daily_limit",
        `Too many webhook calls today. It resets at ${usage.resetAt}.`,
      );
    const res = await hooks(c).test(id, bearer(c), deps.now());
    return res ? c.json({ delivered: res.ok, result: res.result }) : notYours(c);
  });

  return app;
}

export const isPublicApiPath = (path: string) => path === "/api/v1" || path.startsWith("/api/v1/");
