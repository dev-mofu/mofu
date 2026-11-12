import { inflateSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/worker/app.js";
import { createPagesApp, escapeHtml, isPagesPath, tokenTitle } from "../src/worker/pages.js";
import { createSessionToken, SESSION_COOKIE } from "../src/worker/session.js";
import { evaluateUsage, type UsageState } from "../src/worker/usage.js";
import type { IndexedToken, TokenIndex } from "../src/worker/stats.js";
import { PixelCanvas, fontSafe } from "../src/worker/pixel-png.js";

const SECRET = "s".repeat(40);
const NOW = Date.UTC(2026, 10, 12, 12);
const RPC = "https://rpc.example";
const TOKEN = "0x1111111111111111111111111111111111111111";
const WALLET = "0x4444444444444444444444444444444444444444";
const OTHER = "0x5555555555555555555555555555555555555555";
const EVIL = `<script>alert("x")</script>&Co`;

const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
const abiString = (s: string) => {
  const hex = Buffer.from(s).toString("hex");
  return `0x${word(32n).slice(2)}${word(BigInt(Buffer.byteLength(s))).slice(2)}${hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")}`;
};

/** TOKEN and OTHER are plain fixed-supply tokens; TOKEN's name is hostile markup. */
const chain: typeof fetch = (async (_u: string, init?: RequestInit) => {
  const { method, params } = JSON.parse(String(init?.body)) as {
    method: string;
    params: [{ to: string; data: string } & string, string];
  };
  const ok = (result: string) => Response.json({ jsonrpc: "2.0", id: 1, result });
  if (method === "eth_getCode") return ok(params[0] === WALLET ? "0x" : "0x6080604052600436106100");
  if (method === "eth_getStorageAt") return ok(word(0n));
  if (method === "eth_call") {
    const sel = String(params[0].data).slice(0, 10);
    const name = params[0].to === TOKEN ? EVIL : "Other Token";
    const r = {
      "0x06fdde03": abiString(name),
      "0x95d89b41": abiString("EVL"),
      "0x313ce567": word(18n),
      "0x18160ddd": word(1_000_000_000n * 10n ** 18n),
    }[sel];
    if (r) return ok(r);
  }
  return Response.json({
    jsonrpc: "2.0",
    id: 1,
    error: { code: 3, message: "execution reverted" },
  });
}) as unknown as typeof fetch;

function setup(limit = "300") {
  const states = new Map<string, UsageState>();
  const listed = new Map<string, IndexedToken>();
  const index: TokenIndex = {
    async noteToken(t) {
      listed.set(t.address, t);
    },
    async tokens(n = 1000) {
      return [...listed.values()].sort((a, b) => b.at - a.at).slice(0, n);
    },
    async rememberTokens() {},
    async similar() {
      return [];
    },
  };
  const deps: AppDeps = {
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
    fetch: chain,
    now: () => NOW,
    getStats: () => ({ add: async () => {}, all: async () => ({ since: null, counters: {} }) }),
    getTokenIndex: () => index,
  };
  const env = {
    SESSION_SECRET: SECRET,
    HOLDER_RPC_URL: RPC,
    SCAN_FREE_DAILY: "10",
    SCAN_HOLDER_DAILY: "50",
    PAGE_DAILY_LIMIT: limit,
  } as unknown as Env;
  return { pages: createPagesApp(deps), app: createApp(deps), env, listed, states };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("token pages", () => {
  it("routes only its own paths", () => {
    expect(isPagesPath("/token/")).toBe(true);
    expect(isPagesPath(`/token/${TOKEN}.png`)).toBe(true);
    expect(isPagesPath("/sitemap-tokens.xml")).toBe(true);
    expect(isPagesPath("/tokens")).toBe(false);
    expect(isPagesPath("/api/token-scan")).toBe(false);
  });

  it("renders a scan with the name escaped and a card as og:image", async () => {
    const { pages, env } = setup();
    const res = await pages.request(`http://localhost/token/${TOKEN}`, {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62;&#38;Co ($EVL)");
    expect(html).toContain(`<link rel="canonical" href="https://mofu.works/token/${TOKEN}" />`);
    expect(html).toContain(
      `<meta property="og:image" content="https://mofu.works/token/${TOKEN}.png" />`,
    );
    expect(html).toContain("No red flags in the code");
    expect(html).not.toContain('content="noindex"');
  });

  it("sends mixed-case addresses to the lowercase page", async () => {
    const { pages, env } = setup();
    // An upper-case 0X prefix isn't an address; a checksummed one redirects.
    const res = await pages.request(`http://localhost/token/${TOKEN.replace("0x", "0X")}`, {}, env);
    expect(res.status).toBe(404);
    const mixed = "0xAbCdEf0000000000000000000000000000000001";
    const r2 = await pages.request(`http://localhost/token/${mixed}.png`, {}, env);
    expect(r2.status).toBe(301);
    expect(r2.headers.get("Location")).toBe(`/token/${mixed.toLowerCase()}.png`);
  });

  it("draws the share card as a 1200×630 PNG", async () => {
    const { pages, env } = setup();
    const res = await pages.request(`http://localhost/token/${TOKEN}.png`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    const png = Buffer.from(await res.arrayBuffer());
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    const idatAt = png.indexOf("IDAT");
    const raw = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + png.readUInt32BE(idatAt - 4)));
    expect(raw.length).toBe(1201 * 630);
  });

  it("404s wallets and junk, without indexing them", async () => {
    const { pages, env } = setup();
    const wallet = await pages.request(`http://localhost/token/${WALLET}`, {}, env);
    expect(wallet.status).toBe(404);
    expect(await wallet.text()).toContain('content="noindex"');
    expect((await pages.request("http://localhost/token/hello", {}, env)).status).toBe(404);
    expect((await pages.request("http://localhost/token/hello.png", {}, env)).status).toBe(404);
  });

  it("falls back to the site card and a busy page when the daily page limit is used", async () => {
    const { pages, env } = setup("1");
    expect((await pages.request(`http://localhost/token/${TOKEN}`, {}, env)).status).toBe(200);
    // Cached: no new scan.
    expect((await pages.request(`http://localhost/token/${TOKEN}.png`, {}, env)).status).toBe(200);
    expect((await pages.request(`http://localhost/token/${OTHER}`, {}, env)).status).toBe(429);
    const card = await pages.request(`http://localhost/token/${OTHER}.png`, {}, env);
    expect(card.status).toBe(302);
    expect(card.headers.get("Location")).toBe("/og-card.png");
  });

  it("lists tokens scanned in the app, on /token/ and in the sitemap", async () => {
    const { pages, app, env, listed } = setup();
    const session = `${SESSION_COOKIE}=${(await createSessionToken(SECRET, NOW, 60_000)).token}`;
    for (const address of [TOKEN, WALLET]) {
      await app.request(
        "http://localhost/api/token-scan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session },
          body: JSON.stringify({ address }),
        },
        env,
      );
    }
    await flush();
    expect([...listed.keys()]).toEqual([TOKEN]);
    const index = await (await pages.request("http://localhost/token/", {}, env)).text();
    expect(index).toContain(`href="/token/${TOKEN}"`);
    expect(index).not.toContain("<script>alert");
    const map = await pages.request("http://localhost/sitemap-tokens.xml", {}, env);
    expect(map.headers.get("Content-Type")).toContain("application/xml");
    const xml = await map.text();
    expect(xml).toContain(
      `<loc>https://mofu.works/token/${TOKEN}</loc><lastmod>2026-11-12</lastmod>`,
    );
    const go = await pages.request(
      `http://localhost/token/?address=${TOKEN.toUpperCase().replace("0X", "0x")}`,
      {},
      env,
    );
    expect(go.status).toBe(302);
    expect(go.headers.get("Location")).toBe(`/token/${TOKEN}`);
  });
});

describe("token scan quota", () => {
  it("doesn't count a scan of a wallet address (Wallet Health counts instead)", async () => {
    const { app, env, states } = setup();
    const session = `${SESSION_COOKIE}=${(await createSessionToken(SECRET, NOW, 60_000)).token}`;
    const scan = (address: string) =>
      app.request(
        "http://localhost/api/token-scan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session },
          body: JSON.stringify({ address }),
        },
        env,
      );
    const wallet = (await (await scan(WALLET)).json()) as { remaining: number };
    expect(wallet.remaining).toBe(10);
    expect([...states.keys()].some((k) => k.endsWith(":scans"))).toBe(false);
    const token = (await (await scan(TOKEN)).json()) as { remaining: number };
    expect(token.remaining).toBe(9);
  });
});

describe("pixel png helpers", () => {
  it("escapes markup and strips control characters from names", () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe("&#60;a href=&#34;x&#34;&#62;&#39;&#38;");
    expect(tokenTitle({ name: "Mo‮fu\u0000", symbol: null }, TOKEN)).toBe("Mofu");
    expect(tokenTitle({ name: null, symbol: null }, TOKEN)).toBe("Contract 0x1111...1111");
  });

  it("maps characters the font lacks", () => {
    expect(fontSafe("Mofu · 🐱…")).toBe("MOFU - ?.");
  });

  it("keeps drawing inside the canvas", () => {
    const c = new PixelCanvas(10, 10, ["#000000", "#ffffff"]);
    c.rect(-5, -5, 100, 100, 1);
    expect(c.data.every((v) => v === 1)).toBe(true);
  });
});
