import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/worker/app.js";
import { formatAmount, readLogs } from "../src/worker/preview.js";
import { evaluateUsage, type UsageState } from "../src/worker/usage.js";

const ME = "0x636dd2c0299601df246efbfefcd67f12c9e57d08";
const CURVE = "0xc2347eda73ddcbc7a1ce29ff140fd6a62d0cf460";
const TOKEN = "0xf76593c1c321c2a2f77775025e9677999ce7ea8c";
const THIEF = "0x9999999999999999999999999999999999999999";
const NFT = "0x6666666666666666666666666666666666666666";
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const topic = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const ETH = 10n ** 18n;

/** A buy on the curve: ETH out, tokens in, plus a sneaky approval to THIEF, plus an NFT out. */
const LOGS = [
  { address: NATIVE, topics: [TRANSFER, topic(ME), topic(CURVE)], data: word(ETH / 1000n) },
  { address: TOKEN, topics: [TRANSFER, topic(CURVE), topic(ME)], data: word(342_356n * ETH) },
  { address: TOKEN, topics: [APPROVAL, topic(ME), topic(THIEF)], data: word((1n << 256n) - 1n) },
  { address: NFT, topics: [TRANSFER, topic(ME), topic(THIEF), word(12n)], data: "0x" },
];

describe("readLogs", () => {
  it("nets what the sender gives and gets, and the approvals it sets", () => {
    const r = readLogs(ME, [{ status: "0x1", logs: LOGS }]);
    expect(r.net.get(NATIVE)).toBe(-(ETH / 1000n));
    expect(r.net.get(TOKEN)).toBe(342_356n * ETH);
    expect(r.nftOut).toEqual([{ asset: NFT, id: "12" }]);
    expect(r.approvals).toEqual([
      { token: TOKEN, spender: THIEF, value: (1n << 256n) - 1n, kind: "token" },
    ]);
  });

  it("ignores transfers between other wallets", () => {
    const r = readLogs(THIEF.replace("9", "8"), [{ status: "0x1", logs: LOGS }]);
    expect(r.net.size).toBe(0);
  });
});

describe("formatAmount", () => {
  it("shows whole units with a few decimals", () => {
    expect(formatAmount(ETH / 1000n, 18)).toBe("0.001");
    expect(formatAmount(1_250_000n * ETH + ETH / 2n, 18)).toBe("1,250,000.5");
    expect(formatAmount(1n, 18)).toBe("< 0.00000001");
  });
});

const env = { HOLDER_RPC_URL: "https://rpc.example", GUARD_DAILY_LIMIT: "100" } as unknown as Env;

function app() {
  const states = new Map<string, UsageState>();
  const deps: AppDeps = {
    createModel: () => {
      throw new Error("no model");
    },
    verifyTurnstile: async () => true,
    getLimiter: () => ({
      async check(key, limit, consume, bucket = "messages") {
        const k = `${key}:${bucket}`;
        const { state, result } = evaluateUsage(states.get(k), Date.now(), limit, consume);
        if (consume && result.allowed) states.set(k, state);
        return result;
      },
    }),
    fetch: (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as unknown;
      if (Array.isArray(body))
        return Response.json(
          body.map((c: { id: number; params: [{ data: string }] }) => ({
            jsonrpc: "2.0",
            id: c.id,
            // symbol() → "MOFU", decimals() → 18, name() → "Mofu"
            result: c.params[0].data.startsWith("0x313ce567")
              ? word(18n)
              : `0x${"20".padStart(64, "0")}${"4".padStart(64, "0")}${Buffer.from(
                  c.params[0].data.startsWith("0x95d89b41") ? "MOFU" : "Mofu",
                )
                  .toString("hex")
                  .padEnd(64, "0")}`,
          })),
        );
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: [{ calls: [{ status: "0x1", logs: LOGS.slice(0, 3) }] }],
      });
    }) as unknown as typeof fetch,
    now: () => Date.now(),
  };
  return createApp(deps);
}

describe("POST /api/guard/preview", () => {
  const post = (body: unknown, origin = "chrome-extension://abcdefghijklmnop") =>
    app().request(
      "http://localhost/api/guard/preview",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(body),
      },
      env,
    );

  it("answers the extension with what changes in the wallet", async () => {
    const res = await post({ from: ME, calls: [{ to: CURVE, data: "0x59a87bc1", value: "0x1" }] });
    expect(res.status).toBe(200);
    const p = (await res.json()) as {
      status: string;
      changes: Array<{ direction: string; amount: string; symbol: string }>;
      approvals: Array<{ amount: string; spender: string }>;
    };
    expect(p.status).toBe("ok");
    expect(p.changes.map((c) => `${c.direction} ${c.amount} ${c.symbol}`)).toEqual([
      "out 0.001 ETH",
      "in 342,356 MOFU",
    ]);
    expect(p.approvals).toEqual([expect.objectContaining({ spender: THIEF, amount: "unlimited" })]);
  });

  it("refuses other websites and bad bodies", async () => {
    expect((await post({ from: ME, calls: [{ to: CURVE }] }, "https://evil.example")).status).toBe(
      403,
    );
    expect((await post({ from: "nope", calls: [] })).status).toBe(400);
    expect((await post({ from: ME, calls: [{ to: CURVE, data: "0xzz" }] })).status).toBe(400);
  });
});
