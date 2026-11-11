import { describe, expect, it } from "vitest";
import { analyzeCode, decodeString, scanToken, selector } from "../src/worker/token-scan.js";
import { createApp, type AppDeps, type Limiter } from "../src/worker/app.js";
import { createSessionToken, SESSION_COOKIE } from "../src/worker/session.js";
import { evaluateUsage, type UsageState } from "../src/worker/usage.js";
import type { ApiError, TokenScanResponse } from "../src/shared/api.js";

const RPC = "https://rpc.example";
const TOKEN = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const IMPL = "0x3333333333333333333333333333333333333333";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** Fake runtime code: a dispatcher that compares against these function selectors. */
const codeWith = (...sigs: string[]) =>
  `0x6080604052${sigs.map((s) => `63${selector(s)}14`).join("")}00`;
const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
const addrWord = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const abiString = (s: string) => {
  const hex = Buffer.from(s).toString("hex");
  return `0x${(32).toString(16).padStart(64, "0")}${s.length.toString(16).padStart(64, "0")}${hex.padEnd(64, "0")}`;
};

interface Chain {
  code: Record<string, string>;
  storage?: Record<string, string>;
  /** `${to}:${selector}` → result; anything missing reverts. */
  calls: Record<string, string>;
}

function chainFetch(chain: Chain, calls: string[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url !== RPC) return new Response("no", { status: 404 });
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: [{ to: string; data: string } & string, string] };
    calls.push(method);
    const ok = (result: string) => Response.json({ jsonrpc: "2.0", id: 1, result });
    if (method === "eth_getCode") return ok(chain.code[params[0]] ?? "0x");
    if (method === "eth_getStorageAt")
      return ok(chain.storage?.[`${params[0]}:${params[1]}`] ?? word(0n));
    if (method === "eth_call") {
      const key = `${params[0].to}:${String(params[0].data).slice(0, 10)}`;
      const balKey = `${params[0].to}:${params[0].data}`;
      const r = chain.calls[balKey] ?? chain.calls[key];
      return r
        ? ok(r)
        : Response.json({
            jsonrpc: "2.0",
            id: 1,
            error: { code: 3, message: "execution reverted" },
          });
    }
    return new Response("?", { status: 400 });
  }) as unknown as typeof fetch;
}

const SUPPLY = 1_000_000_000n * 10n ** 18n;
const erc20 = (to: string) => ({
  [`${to}:0x06fdde03`]: abiString("Test Token"),
  [`${to}:0x95d89b41`]: abiString("TEST"),
  [`${to}:0x313ce567`]: word(18n),
  [`${to}:0x18160ddd`]: word(SUPPLY),
});

describe("bytecode analysis", () => {
  it("finds selectors in PUSH4 and skips PUSH data", () => {
    const facts = analyzeCode(codeWith("mint(address,uint256)", "pause()"));
    expect(facts.selectors.has(selector("mint(address,uint256)"))).toBe(true);
    expect(facts.selectors.has(selector("pause()"))).toBe(true);
    // 0xff inside PUSH data is not SELFDESTRUCT.
    expect(analyzeCode("0x63ffffffff00").selfdestruct).toBe(false);
    expect(analyzeCode("0x6000ff").selfdestruct).toBe(true);
  });

  it("knows the standard selectors", () => {
    expect(selector("transfer(address,uint256)")).toBe("a9059cbb");
    expect(selector("mint(address,uint256)")).toBe("40c10f19");
  });

  it("recognizes an EIP-1167 minimal proxy", () => {
    const code = `0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3`;
    expect(analyzeCode(code).minimalProxyTarget).toBe(IMPL);
  });

  it("decodes ABI and bytes32 strings", () => {
    expect(decodeString(abiString("Mofu"))).toBe("Mofu");
    expect(decodeString(`0x${Buffer.from("MKR").toString("hex").padEnd(64, "0")}`)).toBe("MKR");
  });
});

describe("scanToken", () => {
  it("reports a plain fixed-supply token as clean", async () => {
    const r = await scanToken(
      [RPC],
      TOKEN,
      chainFetch({ code: { [TOKEN]: codeWith("transfer(address,uint256)") }, calls: erc20(TOKEN) }),
    );
    expect(r.token).toEqual({
      name: "Test Token",
      symbol: "TEST",
      decimals: 18,
      totalSupply: "1000000000",
    });
    expect(r.verdict).toBe("clean");
    expect(r.checks.every((c) => c.status === "ok")).toBe(true);
    expect(r.owner.status).toBe("none");
  });

  it("flags owner powers: mint, blacklist and fees with an active owner", async () => {
    const r = await scanToken(
      [RPC],
      TOKEN,
      chainFetch({
        code: {
          [TOKEN]: codeWith(
            "owner()",
            "mint(address,uint256)",
            "setBots(address[],bool)",
            "setTaxes(uint256,uint256)",
          ),
        },
        calls: {
          ...erc20(TOKEN),
          [`${TOKEN}:0x8da5cb5b`]: addrWord(OWNER),
          [`${TOKEN}:0x70a08231${OWNER.slice(2).padStart(64, "0")}`]: word(SUPPLY / 4n),
        },
      }),
    );
    expect(r.verdict).toBe("risky");
    expect(r.owner).toEqual({ status: "active", address: OWNER, holdsPercent: 25 });
    const status = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
    expect(status).toMatchObject({
      mint: "risk",
      blacklist: "risk",
      fees: "risk",
      pause: "ok",
      owner: "warn",
    });
    expect(r.checks.find((c) => c.id === "mint")?.detail).toContain(OWNER);
  });

  it("treats a renounced owner as no owner, but still warns about leftover functions", async () => {
    const r = await scanToken(
      [RPC],
      TOKEN,
      chainFetch({
        code: { [TOKEN]: codeWith("owner()", "setMaxWallet(uint256)") },
        calls: {
          ...erc20(TOKEN),
          [`${TOKEN}:0x8da5cb5b`]: addrWord("0x0000000000000000000000000000000000000000"),
        },
      }),
    );
    expect(r.owner.status).toBe("renounced");
    expect(r.checks.find((c) => c.id === "limits")?.status).toBe("warn");
    expect(r.verdict).toBe("caution");
  });

  it("follows an EIP-1967 proxy to its implementation", async () => {
    const r = await scanToken(
      [RPC],
      TOKEN,
      chainFetch({
        code: { [TOKEN]: "0x6080604052363d3d37f400", [IMPL]: codeWith("pause()") },
        storage: { [`${TOKEN}:${IMPL_SLOT}`]: addrWord(IMPL) },
        calls: erc20(TOKEN),
      }),
    );
    expect(r.proxy).toEqual({ kind: "eip1967", implementation: IMPL });
    expect(r.checks.find((c) => c.id === "upgrade")?.status).toBe("risk");
    expect(r.checks.find((c) => c.id === "pause")?.status).toBe("risk");
  });

  it("says when the address isn't a contract", async () => {
    const r = await scanToken([RPC], TOKEN, chainFetch({ code: {}, calls: {} }));
    expect(r.isContract).toBe(false);
    expect(r.verdict).toBe("risky");
  });

  it("doesn't retry other endpoints when a call simply reverts", async () => {
    const calls: string[] = [];
    await scanToken(
      [RPC, "https://second.example"],
      TOKEN,
      chainFetch(
        { code: { [TOKEN]: codeWith("transfer(address,uint256)") }, calls: erc20(TOKEN) },
        calls,
      ),
    );
    // owner() and getOwner() revert once each, on the first endpoint only.
    expect(calls.filter((m) => m === "eth_call").length).toBeLessThan(12);
  });
});

describe("POST /api/token-scan", () => {
  const NOW = Date.UTC(2026, 10, 12, 12);
  const SECRET = "s".repeat(40);
  const env = {
    SESSION_SECRET: SECRET,
    HOLDER_RPC_URL: RPC,
    HOLDER_TOKEN: "0xf76593c1c321c2a2f77775025e9677999ce7ea8c",
    HOLDER_DECIMALS: "18",
    HOLDER_MIN_TOKENS: "1000000",
    HOLDER_DAILY_LIMIT: "30",
    FREE_DAILY_LIMIT: "10",
    SCAN_FREE_DAILY: "2",
    SCAN_HOLDER_DAILY: "5",
  } as unknown as Env;

  function setup() {
    const states = new Map<string, UsageState>();
    const limiter: Limiter = {
      async check(key, limit, consume, bucket = "messages") {
        const k = `${key}:${bucket}`;
        const { state, result } = evaluateUsage(states.get(k), NOW, limit, consume);
        if (consume && result.allowed) states.set(k, state);
        return result;
      },
    };
    const deps: AppDeps = {
      createModel: () => {
        throw new Error("no model in scans");
      },
      verifyTurnstile: async () => true,
      getLimiter: () => limiter,
      fetch: chainFetch({
        code: { [TOKEN]: codeWith("transfer(address,uint256)") },
        calls: erc20(TOKEN),
      }),
      now: () => NOW,
    };
    return { app: createApp(deps), states };
  }
  const scan = async (app: ReturnType<typeof createApp>, address: unknown, cookie = true) => {
    const session = `${SESSION_COOKIE}=${(await createSessionToken(SECRET, NOW, 60_000)).token}`;
    return app.request(
      "http://localhost/api/token-scan",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "7.7.7.7",
          ...(cookie && { Cookie: session }),
        },
        body: JSON.stringify({ address }),
      },
      env,
    );
  };

  it("scans without a model call and counts toward a daily scan limit", async () => {
    const { app, states } = setup();
    const first = await scan(app, TOKEN);
    expect(first.status).toBe(200);
    const body = (await first.json()) as TokenScanResponse;
    expect(body.report.verdict).toBe("clean");
    expect(body).toMatchObject({ remaining: 1, limit: 2 });
    await scan(app, TOKEN);
    const third = await scan(app, TOKEN);
    expect(third.status).toBe(429);
    expect(((await third.json()) as ApiError).message).toContain("holders get more");
    expect([...states.keys()]).toEqual(["7.7.7.7:scans"]);
  });

  it("needs a session and a valid address", async () => {
    const { app } = setup();
    expect((await scan(app, TOKEN, false)).status).toBe(401);
    expect((await scan(app, "0x123")).status).toBe(400);
    expect((await scan(app, 42)).status).toBe(400);
  });
});
