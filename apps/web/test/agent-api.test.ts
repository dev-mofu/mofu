import { createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  createPublicApi,
  isPublicApiPath,
  type PublicApiDeps,
  type Webhooks,
} from "../src/worker/public-api.js";
import { evaluateUsage, type UsageState } from "../src/worker/usage.js";
import {
  applyScan,
  applySnapshot,
  checkWebhookUrl,
  cheapChanges,
  deliver,
  emptySnapshot,
  publicHook,
  signPayload,
  snapshotCalls,
  verdictStep,
  type StoredHook,
  type TokenSnapshot,
} from "../src/worker/webhooks.js";
import type { TokenScanReport } from "../src/shared/api.js";

const NOW = Date.UTC(2026, 10, 12, 12);
const RPC = "https://rpc.example";
const TOKEN = "0x1111111111111111111111111111111111111111";
const WALLET = "0x4444444444444444444444444444444444444444";
const OWNER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CURVE = "0xc2347eda73ddcbc7a1ce29ff140fd6a62d0cf460";

const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
const abiString = (s: string) => {
  const hex = Buffer.from(s).toString("hex");
  return `0x${word(32n).slice(2)}${word(BigInt(Buffer.byteLength(s))).slice(2)}${hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")}`;
};

describe("webhook URLs", () => {
  it("takes public https URLs only", () => {
    expect(checkWebhookUrl("https://hooks.example.com/mofu#x")).toEqual({
      url: "https://hooks.example.com/mofu",
    });
    for (const bad of [
      "http://hooks.example.com",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://localhost/x",
      "https://box.local/x",
      "https://intranet/x",
      "https://u:p@hooks.example.com",
      "https://hooks.example.com:8443/x",
      "not a url",
      42,
    ]) {
      expect(checkWebhookUrl(bad)).toHaveProperty("error");
    }
  });
});

describe("signing and delivery", () => {
  it("signs t.body with HMAC-SHA256, the way a receiver checks it", async () => {
    const mine = await signPayload("whsec_abc", 1700000000, '{"a":1}');
    const theirs = createHmac("sha256", "whsec_abc").update('1700000000.{"a":1}').digest("hex");
    expect(mine).toBe(theirs);
  });

  it("POSTs a signed event and counts only 2xx as delivered", async () => {
    let seen: { headers: Headers; body: string; redirect?: string } | null = null;
    const ok = (async (_u: string, init: RequestInit) => {
      seen = {
        headers: new Headers(init.headers),
        body: String(init.body),
        redirect: init.redirect,
      };
      return new Response("ok");
    }) as unknown as typeof fetch;
    const event = {
      id: "evt_1",
      type: "owner_changed" as const,
      createdAt: new Date(NOW).toISOString(),
      token: { address: TOKEN, name: "T", symbol: "T" },
      summary: "x",
      before: OWNER_A,
      after: OWNER_B,
      report: null,
    };
    const hook = { id: "wh_1", url: "https://hooks.example.com", secret: "whsec_k" };
    expect(await deliver(ok, hook, event, NOW)).toEqual({ ok: true, result: "200" });
    const s = seen!;
    expect(s.redirect).toBe("manual");
    expect(JSON.parse(s.body)).toMatchObject({
      id: "evt_1",
      webhook: "wh_1",
      type: "owner_changed",
    });
    const [t, v1] = s.headers
      .get("Mofu-Signature")!
      .split(",")
      .map((p) => p.split("=")[1]);
    expect(v1).toBe(createHmac("sha256", "whsec_k").update(`${t}.${s.body}`).digest("hex"));
    expect(s.headers.get("Mofu-Event")).toBe("owner_changed");

    const redirect = (async () => new Response(null, { status: 302 })) as unknown as typeof fetch;
    expect(await deliver(redirect, hook, event, NOW)).toEqual({ ok: false, result: "302" });
    const down = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    expect(await deliver(down, hook, event, NOW)).toEqual({ ok: false, result: "unreachable" });
  });

  it("never shows the secret in the public view", () => {
    const h = { id: "wh_1", secret: "whsec_x", url: "https://a.example" } as StoredHook;
    expect(publicHook(h)).not.toHaveProperty("secret");
  });
});

describe("change detection", () => {
  const base = (over: Partial<TokenSnapshot> = {}): TokenSnapshot => ({
    ...emptySnapshot(TOKEN),
    symbol: "TKN",
    decimals: 18,
    owner: OWNER_A,
    supply: (1000n * 10n ** 18n).toString(),
    paused: false,
    venue: CURVE,
    venueKind: "curve",
    liquidity: (2n * 10n ** 18n).toString(),
    polledAt: NOW - 300_000,
    ...over,
  });

  it("reads owner, supply, implementation, paused, the venue's liquidity and graduation", () => {
    const calls = snapshotCalls(base());
    expect(calls).toHaveLength(6);
    expect(calls[4]).toEqual({ method: "eth_getBalance", params: [CURVE, "latest"] });
    expect(calls[5]).toEqual({
      method: "eth_call",
      params: [{ to: CURVE, data: "0xe7c2b772" }, "latest"],
    });
    const pool = snapshotCalls(base({ venueKind: "pool" }));
    expect(pool[4]!.method).toBe("eth_call");
    expect(snapshotCalls(base({ venue: null, venueKind: null }))).toHaveLength(4);
  });

  it("keeps the old value when a read doesn't come back", () => {
    const s = base();
    const next = applySnapshot(s, [null, null, null, null, null], NOW);
    expect(next).toMatchObject({
      owner: OWNER_A,
      supply: s.supply,
      paused: false,
      liquidity: s.liquidity,
      polledAt: NOW,
    });
    const read = applySnapshot(
      s,
      [word(BigInt(OWNER_B)), word(5n), word(0n), word(1n), word(7n)],
      NOW,
    );
    expect(read).toMatchObject({
      owner: OWNER_B,
      supply: "5",
      implementation: null,
      paused: true,
      liquidity: "7",
    });
  });

  it("reports nothing on the first read", () => {
    expect(cheapChanges(base({ polledAt: 0 }), base({ owner: OWNER_B, polledAt: NOW }))).toEqual(
      [],
    );
  });

  it("reports owner changes, renounces, mints, pauses and upgrades", () => {
    const prev = base();
    const types = (n: Partial<TokenSnapshot>) => cheapChanges(prev, base({ ...n, polledAt: NOW }));
    expect(types({ owner: OWNER_B })[0]).toMatchObject({
      type: "owner_changed",
      before: OWNER_A,
      after: OWNER_B,
    });
    expect(types({ owner: "0x0000000000000000000000000000000000000000" })[0]!.summary).toContain(
      "renounced",
    );
    const mint = types({ supply: (2000n * 10n ** 18n).toString() })[0]!;
    expect(mint.type).toBe("supply_changed");
    expect(mint.summary).toContain("from 1,000 to 2,000");
    expect(mint.summary).toContain("minted");
    expect(types({ paused: true })[0]).toMatchObject({ type: "pause_changed", after: true });
    expect(types({ implementation: OWNER_B })[0]!.type).toBe("upgraded");
    expect(types({})).toEqual([]);
  });

  it("reports a liquidity drop of 30% or more, and ignores small or tiny ones", () => {
    const prev = base();
    const drop = cheapChanges(
      prev,
      base({ liquidity: (12n * 10n ** 17n).toString(), polledAt: NOW }),
    );
    expect(drop[0]).toMatchObject({ type: "liquidity_dropped" });
    expect(drop[0]!.summary).toContain("40.0%");
    expect(
      cheapChanges(prev, base({ liquidity: (15n * 10n ** 17n).toString(), polledAt: NOW })),
    ).toEqual([]);
    const dust = base({ liquidity: "1000" });
    expect(cheapChanges(dust, base({ liquidity: "1", polledAt: NOW }))).toEqual([]);
    // A new venue (graduated) isn't a drop.
    expect(cheapChanges(prev, base({ venue: OWNER_B, liquidity: "0", polledAt: NOW }))).toEqual([]);
  });

  it("takes the venue from a scan and resets the liquidity baseline when it moves", () => {
    const r = {
      token: { name: "Token", symbol: "TKN", decimals: 18, totalSupply: "1" },
      sellTest: { method: "transfer", venue: OWNER_B.toUpperCase().replace("0X", "0x") },
    } as unknown as TokenScanReport;
    const s = applyScan(base(), r, NOW);
    expect(s).toMatchObject({ venue: OWNER_B, venueKind: "pool", liquidity: null, scannedAt: NOW });
  });

  it("sends a verdict change only after two scans agree", () => {
    let s = base({ verdict: "clean" });
    let step = verdictStep(s, "risky");
    expect(step.change).toBeNull();
    expect(step.confirmSoon).toBe(true);
    s = step.snapshot;
    step = verdictStep(s, "risky");
    expect(step.change).toMatchObject({ type: "verdict_changed", before: "clean", after: "risky" });
    expect(step.snapshot.verdict).toBe("risky");
    // A one-off blip goes away.
    const blip = verdictStep(verdictStep(base({ verdict: "clean" }), "caution").snapshot, "clean");
    expect(blip.change).toBeNull();
    expect(blip.snapshot.pendingVerdict).toBeNull();
    // First verdict is just stored.
    expect(verdictStep(base(), "clean").change).toBeNull();
  });
});

describe("public API", () => {
  /** TOKEN is a fixed-supply token; WALLET has no code. Hooks at hooks.example answer 200. */
  const deliveries: Array<{ url: string; body: string }> = [];
  const fetchFn = (async (u: string, init?: RequestInit) => {
    if (String(u).startsWith("https://hooks.example.com")) {
      deliveries.push({ url: String(u), body: String(init?.body) });
      return new Response("ok");
    }
    if (String(u).startsWith("https://down.example.com"))
      return new Response("no", { status: 500 });
    const body = JSON.parse(String(init?.body));
    const answer = (c: { method: string; params: [{ to: string; data: string } & string] }) => {
      if (c.method === "eth_getCode")
        return c.params[0] === WALLET ? "0x" : "0x6080604052600436106100";
      if (c.method === "eth_getStorageAt") return word(0n);
      if (c.method === "eth_call") {
        const sel = String(c.params[0].data).slice(0, 10);
        return (
          {
            "0x06fdde03": abiString("Test Token"),
            "0x95d89b41": abiString("TST"),
            "0x313ce567": word(18n),
            "0x18160ddd": word(1_000_000n * 10n ** 18n),
          } as Record<string, string>
        )[sel];
      }
      return undefined;
    };
    const one = (c: {
      id?: number;
      method: string;
      params: [{ to: string; data: string } & string];
    }) => {
      const r = answer(c);
      return r === undefined
        ? { jsonrpc: "2.0", id: c.id ?? 1, error: { code: 3, message: "execution reverted" } }
        : { jsonrpc: "2.0", id: c.id ?? 1, result: r };
    };
    return Response.json(Array.isArray(body) ? body.map(one) : one(body));
  }) as unknown as typeof fetch;

  function setup(limit = "50") {
    const states = new Map<string, UsageState>();
    const stored = new Map<string, StoredHook>();
    const webhooks: Webhooks = {
      async create(i) {
        const hook: StoredHook = {
          id: i.id,
          url: i.url,
          secret: i.secret,
          tokens: i.tokens.map((t) => t.address),
          events: i.events,
          createdAt: new Date(i.now).toISOString(),
          status: "active",
          disabledAt: null,
          failures: 0,
          delivered: 0,
          lastDeliveryAt: null,
          lastResult: null,
        };
        stored.set(hook.id, hook);
        return { hook: publicHook(hook) };
      },
      async get(id, secret) {
        const h = stored.get(id);
        return h && h.secret === secret ? publicHook(h) : null;
      },
      async remove(id, secret) {
        const h = stored.get(id);
        if (!h || h.secret !== secret) return false;
        return stored.delete(id);
      },
      async test(id, secret) {
        const h = stored.get(id);
        return h && h.secret === secret ? { ok: true, result: "200" } : null;
      },
    };
    const deps: PublicApiDeps = {
      createModel: () => {
        throw new Error("no model");
      },
      verifyTurnstile: async () => true,
      getLimiter: () => ({
        async check(key, lim, consume, bucket = "messages") {
          const k = `${key}:${bucket}`;
          const { state, result } = evaluateUsage(states.get(k), NOW, lim, consume);
          if (consume && result.allowed) states.set(k, state);
          return result;
        },
      }),
      fetch: fetchFn,
      now: () => NOW,
      getStats: () => ({ add: async () => {}, all: async () => ({ since: null, counters: {} }) }),
      getTokenIndex: () => ({
        noteToken: async () => {},
        tokens: async () => [],
        rememberTokens: async () => {},
        similar: async () => [],
      }),
      getWebhooks: () => webhooks,
    };
    const env = {
      HOLDER_RPC_URL: RPC,
      MCP_DAILY_LIMIT: limit,
      WEBHOOK_DAILY_LIMIT: "5",
    } as unknown as Env;
    const app = createPublicApi(deps);
    const call = (path: string, init?: RequestInit) =>
      app.fetch(new Request(`https://mofu.works${path}`, init), env);
    return { call, stored };
  }

  it("routes /api/v1 only", () => {
    expect(isPublicApiPath("/api/v1")).toBe(true);
    expect(isPublicApiPath("/api/v1/token/0x1")).toBe(true);
    expect(isPublicApiPath("/api/v10")).toBe(false);
    expect(isPublicApiPath("/api/token-scan")).toBe(false);
  });

  it("lists the endpoints, with CORS open", async () => {
    const { call } = setup();
    const res = await call("/api/v1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = (await res.json()) as { endpoints: Record<string, string>; events: string[] };
    expect(Object.keys(body.endpoints)).toContain("GET /api/v1/token/{address}");
    expect(body.events).toContain("verdict_changed");
    expect((await call("/api/v1/nope")).status).toBe(404);
  });

  it("scans a token with rate-limit headers, and stops at the daily limit", async () => {
    const { call } = setup("2");
    const res = await call(`/api/v1/token/${TOKEN.toUpperCase().replace("0X", "0x")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("1");
    const body = (await res.json()) as { report: TokenScanReport; url: string; remaining: number };
    expect(body.report.token.symbol).toBe("TST");
    expect(body.report.verdict).toBeTruthy();
    expect(body.url).toBe(`https://mofu.works/token/${TOKEN}`);
    expect((await call(`/api/v1/token/${TOKEN}`)).status).toBe(200);
    const over = await call(`/api/v1/token/${TOKEN}`);
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe("daily_limit");
    expect((await call("/api/v1/token/0x123")).status).toBe(400);
  });

  it("says Wallet Health is unavailable without the indexer key", async () => {
    const { call } = setup();
    expect((await call(`/api/v1/wallet/${WALLET}`)).status).toBe(503);
  });

  it("creates a webhook only after the URL answers a signed ping", async () => {
    const { call, stored } = setup();
    const post = (body: unknown) =>
      call("/api/v1/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ url: "http://hooks.example.com", tokens: [TOKEN] })).status).toBe(422);
    expect((await post({ url: "https://hooks.example.com/x", tokens: [] })).status).toBe(422);
    expect(
      (await post({ url: "https://hooks.example.com/x", tokens: [TOKEN], events: ["nope"] }))
        .status,
    ).toBe(422);
    const wallet = await post({ url: "https://hooks.example.com/x", tokens: [WALLET] });
    expect(((await wallet.json()) as { error: { code: string } }).error.code).toBe("not_a_token");
    const down = await post({ url: "https://down.example.com/x", tokens: [TOKEN] });
    expect(
      ((await down.json()) as { error: { code: string; message: string } }).error.message,
    ).toContain("got: 500");
    expect(stored.size).toBe(0);

    deliveries.length = 0;
    const ok = await post({
      url: "https://hooks.example.com/x",
      tokens: [TOKEN],
      events: ["owner_changed"],
    });
    expect(ok.status).toBe(201);
    const created = (await ok.json()) as {
      webhook: { id: string; events: string[] };
      secret: string;
    };
    expect(created.webhook.id).toMatch(/^wh_[0-9a-f]{24}$/);
    expect(created.secret).toMatch(/^whsec_/);
    expect(created.webhook.events).toEqual(["owner_changed"]);
    expect(created.webhook).not.toHaveProperty("secret");
    // The ping carried the same id the webhook got.
    expect(JSON.parse(deliveries[0]!.body)).toMatchObject({
      type: "ping",
      webhook: created.webhook.id,
    });

    const auth = { Authorization: `Bearer ${created.secret}` };
    const path = `/api/v1/webhooks/${created.webhook.id}`;
    expect((await call(path)).status).toBe(404);
    expect((await call(path, { headers: { Authorization: "Bearer whsec_wrong" } })).status).toBe(
      404,
    );
    const got = await call(path, { headers: auth });
    expect(((await got.json()) as { webhook: { tokens: string[] } }).webhook.tokens).toEqual([
      TOKEN,
    ]);
    const test = await call(`${path}/test`, { method: "POST", headers: auth });
    expect(await test.json()).toEqual({ delivered: true, result: "200" });
    expect((await call(path, { method: "DELETE", headers: auth })).status).toBe(200);
    expect((await call(path, { headers: auth })).status).toBe(404);
  });

  it("limits webhook creation per network", async () => {
    const { call } = setup();
    const post = () =>
      call("/api/v1/webhooks", {
        method: "POST",
        body: JSON.stringify({ url: "https://hooks.example.com/x", tokens: [TOKEN] }),
      });
    for (let i = 0; i < 5; i++) expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(429);
  });
});
