import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/worker/app.js";
import { createMcpApp } from "../src/worker/mcp.js";
import { createSessionToken, SESSION_COOKIE } from "../src/worker/session.js";
import { evaluateUsage, type UsageState } from "../src/worker/usage.js";
import type { StatKey, Stats } from "../src/worker/stats.js";

const SECRET = "s".repeat(40);
const NOW = Date.UTC(2026, 10, 12, 12);
const RPC = "https://rpc.example";
const TOKEN = "0x1111111111111111111111111111111111111111";
const env = {
  SESSION_SECRET: SECRET,
  HOLDER_RPC_URL: RPC,
  SCAN_FREE_DAILY: "10",
  SCAN_HOLDER_DAILY: "50",
  GUARD_DAILY_LIMIT: "100",
  MCP_DAILY_LIMIT: "100",
  FREE_DAILY_LIMIT: "10",
} as unknown as Env;

function setup() {
  const counts = new Map<string, number>();
  const stats: Stats = {
    async add(key: StatKey, n = 1) {
      counts.set(key, (counts.get(key) ?? 0) + n);
    },
    async all() {
      return { since: "2026-11-12T00:00:00.000Z", counters: Object.fromEntries(counts) };
    },
  };
  const states = new Map<string, UsageState>();
  const deps: AppDeps = {
    createModel: () => {
      throw new Error("no model");
    },
    verifyTurnstile: async () => true,
    getLimiter: () => ({
      async check(key, limit, consume, bucket = "messages") {
        const k = `${key}:${bucket}`;
        const { state, result } = evaluateUsage(states.get(k), NOW, limit, consume);
        if (consume && result.allowed) states.set(k, state);
        return result;
      },
    }),
    // A chain with plain fixed-supply code at TOKEN; every call reverts.
    fetch: (async (_u: string, init?: RequestInit) => {
      const { method } = JSON.parse(String(init?.body)) as { method: string };
      const ok = (result: string) => Response.json({ jsonrpc: "2.0", id: 1, result });
      if (method === "eth_getCode") return ok("0x6080604052600436106100");
      if (method === "eth_getStorageAt") return ok(`0x${"0".repeat(64)}`);
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        error: { code: 3, message: "execution reverted" },
      });
    }) as unknown as typeof fetch,
    now: () => NOW,
    getStats: () => stats,
  };
  return { app: createApp(deps), mcp: createMcpApp(deps), counts };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("public stats", () => {
  it("counts scans, guard checks and stopped signatures, and serves them", async () => {
    const { app, counts } = setup();
    const session = `${SESSION_COOKIE}=${(await createSessionToken(SECRET, NOW, 60_000)).token}`;
    await app.request(
      "http://localhost/api/token-scan",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: session },
        body: JSON.stringify({ address: TOKEN }),
      },
      env,
    );
    await app.request(`http://localhost/api/guard/check?address=${TOKEN}`, {}, env);
    await app.request("http://localhost/api/guard/event?type=stopped", {}, env);
    await app.request("http://localhost/api/guard/event?type=stopped", {}, env);
    const bad = await app.request("http://localhost/api/guard/event?type=hacked", {}, env);
    expect(bad.status).toBe(400);
    await flush();
    expect(Object.fromEntries(counts)).toEqual({ token_scan: 1, guard_check: 1, guard_stopped: 2 });
    const body = (await (await app.request("http://localhost/api/stats", {}, env)).json()) as {
      counters: Record<string, number>;
      since: string;
    };
    expect(body.counters.guard_stopped).toBe(2);
    expect(body.since).toBe("2026-11-12T00:00:00.000Z");
  });

  it("counts MCP tool calls by tool", async () => {
    const { mcp, counts } = setup();
    await mcp.request(
      "http://localhost/mcp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "scan_token", arguments: { address: TOKEN } },
        }),
      },
      env,
    );
    await flush();
    expect(counts.get("mcp_scan_token")).toBe(1);
  });
});
