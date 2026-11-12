import { describe, expect, it } from "vitest";
import type { AppDeps, Limiter } from "../src/worker/app.js";
import { createMcpApp } from "../src/worker/mcp.js";
import { evaluateUsage, type UsageState } from "../src/worker/usage.js";

const NOW = Date.UTC(2026, 10, 12, 12);
const RPC = "https://rpc.example";
const TOKEN = "0xf76593c1c321c2a2f77775025e9677999ce7ea8c";

function setup(limit = "3") {
  const states = new Map<string, UsageState>();
  const limiter: Limiter = {
    async check(key, l, consume, bucket = "messages") {
      const k = `${key}:${bucket}`;
      const { state, result } = evaluateUsage(states.get(k), NOW, l, consume);
      if (consume && result.allowed) states.set(k, state);
      return result;
    },
  };
  // A chain where the token is plain code with no owner functions; every call reverts.
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url !== RPC) return new Response("no", { status: 404 });
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    const ok = (result: string) => Response.json({ jsonrpc: "2.0", id: 1, result });
    if (method === "eth_getCode") return ok("0x6080604052600436106100");
    if (method === "eth_getStorageAt") return ok(`0x${"0".repeat(64)}`);
    return Response.json({
      jsonrpc: "2.0",
      id: 1,
      error: { code: 3, message: "execution reverted" },
    });
  }) as unknown as typeof fetch;
  const deps: AppDeps = {
    createModel: () => {
      throw new Error("MCP never calls a model");
    },
    verifyTurnstile: async () => false,
    getLimiter: () => limiter,
    fetch: fetchFn,
    now: () => NOW,
  };
  const env = { HOLDER_RPC_URL: RPC, MCP_DAILY_LIMIT: limit } as unknown as Env;
  const app = createMcpApp(deps);
  const post = (body: unknown, ip = "5.5.5.5") =>
    app.request(
      "http://localhost/mcp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "CF-Connecting-IP": ip,
        },
        body: JSON.stringify(body),
      },
      env,
    );
  return { app, env, post, states };
}

const req = (id: number, method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

describe("MCP server", () => {
  it("negotiates the protocol version and advertises tools", async () => {
    const { post } = setup();
    const init = (await (
      await post(
        req(1, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        }),
      )
    ).json()) as {
      result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string } };
    };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(init.result.serverInfo.name).toBe("mofu");
    const odd = (await (
      await post(req(2, "initialize", { protocolVersion: "1999-01-01" }))
    ).json()) as {
      result: { protocolVersion: string };
    };
    expect(odd.result.protocolVersion).toBe("2025-06-18");
    const list = (await (await post(req(3, "tools/list"))).json()) as {
      result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> };
    };
    expect(list.result.tools.map((t) => t.name)).toEqual([
      "check_wallet",
      "scan_token",
      "check_dependencies",
      "explain_transaction",
    ]);
    expect(list.result.tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });

  it("accepts notifications with 202 and answers unknown methods with -32601", async () => {
    const { post } = setup();
    const note = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    const unknown = (await (await post(req(4, "sampling/whatever"))).json()) as {
      error: { code: number };
    };
    expect(unknown.error.code).toBe(-32601);
    const bad = await post("not json-rpc");
    expect([200, 202, 400]).toContain(bad.status);
  });

  it("runs scan_token without a model and returns text plus structured data", async () => {
    const { post } = setup();
    const res = (await (
      await post(req(5, "tools/call", { name: "scan_token", arguments: { address: TOKEN } }))
    ).json()) as {
      result: {
        content: Array<{ text: string }>;
        structuredContent: { verdict: string };
        isError?: boolean;
      };
    };
    expect(res.result.isError).toBeUndefined();
    expect(res.result.structuredContent.verdict).toBe("clean");
    expect(res.result.content[0]!.text).toContain(`mofu.works/token/${TOKEN}`);
  });

  it("reports bad input and unsupported files as tool errors", async () => {
    const { post } = setup("10");
    const badAddr = (await (
      await post(req(6, "tools/call", { name: "scan_token", arguments: { address: "0x1" } }))
    ).json()) as {
      result: { isError: boolean };
    };
    expect(badAddr.result.isError).toBe(true);
    const badFile = (await (
      await post(
        req(7, "tools/call", {
          name: "check_dependencies",
          arguments: { files: [{ path: "Gemfile", content: "x" }] },
        }),
      )
    ).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(badFile.result.isError).toBe(true);
    expect(badFile.result.content[0]!.text).toContain("Unsupported file");
  });

  it("limits tool calls per IP per day", async () => {
    const { post, states } = setup("2");
    const call = () =>
      post(req(8, "tools/call", { name: "scan_token", arguments: { address: TOKEN } }));
    await call();
    await call();
    const third = (await (await call()).json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(third.result.isError).toBe(true);
    expect(third.result.content[0]!.text).toContain("daily limit");
    expect([...states.keys()]).toEqual(["5.5.5.5:mcp"]);
  });

  it("answers GET with 405, preflight with CORS, and handles batches", async () => {
    const { app, env, post } = setup();
    const get = await app.request("http://localhost/mcp", { method: "GET" }, env);
    expect(get.status).toBe(405);
    const sse = await app.request(
      "http://localhost/mcp",
      { headers: { Accept: "text/event-stream" } },
      env,
    );
    expect(sse.status).toBe(405);
    const browser = await app.request(
      "http://localhost/mcp",
      { headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" } },
      env,
    );
    expect(browser.status).toBe(302);
    expect(browser.headers.get("Location")).toBe("/docs/#mcp");
    const pre = await app.request("http://localhost/mcp", { method: "OPTIONS" }, env);
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Headers")).toContain("Mcp-Protocol-Version");
    const batch = (await (
      await post([
        req(9, "ping"),
        { jsonrpc: "2.0", method: "notifications/initialized" },
        req(10, "tools/list"),
      ])
    ).json()) as Array<{ id: number }>;
    expect(batch.map((r) => r.id)).toEqual([9, 10]);
  });
});
