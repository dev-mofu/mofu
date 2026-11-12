import { describe, expect, it } from "vitest";
import type { AddressInfo, TokenScanReport } from "../src/shared/api.js";
import { rpcBatch } from "../src/worker/chain.js";
import { sellTest, TESTER } from "../src/worker/sell-test.js";
import { formatUnits, judgeApproval, walletReport } from "../src/worker/wallet.js";
import { withLookalikes } from "../src/worker/lookalike.js";
import { MOFU_TOKEN } from "../src/worker/known.js";
import { badgeSvg } from "../src/worker/pages.js";
import { revokeData } from "../src/client/lib/wallet.js";
import type { IndexedToken, TokenIndex } from "../src/worker/stats.js";

const RPC = "https://rpc.example";
const RPC2 = "https://rpc2.example";
const TOKEN = "0x1111111111111111111111111111111111111111";
const CURVE = "0x2222222222222222222222222222222222222222";
const POOL = "0x3333333333333333333333333333333333333333";
const SPENDER = "0x4444444444444444444444444444444444444444";
const WALLET = "0x5555555555555555555555555555555555555555";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const w = (v: bigint | string) =>
  `0x${(typeof v === "bigint" ? v.toString(16) : v.replace(/^0x/, "")).padStart(64, "0")}`;
const log = (token: string, from: string, to: string, value: bigint) => ({
  address: token,
  topics: [TRANSFER, w(from), w(to)],
  data: w(value),
});
const json = (body: unknown) => Response.json(body);

type Rpc = { method: string; params: unknown[]; id?: number };

/** A fetch that answers single and batch JSON-RPC calls with `answer`. */
function rpcFetch(answer: (c: Rpc) => unknown, opts: { batch?: boolean } = {}): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Rpc | Rpc[];
    const one = (c: Rpc) => {
      const r = answer(c);
      return r instanceof Error
        ? { jsonrpc: "2.0", id: c.id ?? 1, error: { code: 3, message: "execution reverted" } }
        : { jsonrpc: "2.0", id: c.id ?? 1, result: r };
    };
    if (Array.isArray(body)) {
      if (opts.batch === false)
        return json(
          body.map((c) => ({ id: c.id, error: { code: -32000, message: "Batch not allowed" } })),
        );
      return json(body.map(one));
    }
    return json(one(body));
  }) as unknown as typeof fetch;
}

describe("rpcBatch", () => {
  it("answers in order with reverts as null", async () => {
    const f = rpcFetch((c) =>
      (c.params[0] as { data: string }).data === "0xbad" ? new Error("revert") : "0x01",
    );
    const r = await rpcBatch(
      [RPC],
      [
        { method: "eth_call", params: [{ to: TOKEN, data: "0x01" }, "latest"] },
        { method: "eth_call", params: [{ to: TOKEN, data: "0xbad" }, "latest"] },
      ],
      f,
    );
    expect(r).toEqual(["0x01", null]);
  });

  it("moves on from an endpoint that refuses batches", async () => {
    const seen: string[] = [];
    const ok = rpcFetch(() => "0x02");
    const refuse = rpcFetch(() => "0x02", { batch: false });
    const f = ((url: string, init?: RequestInit) => {
      seen.push(url);
      return url === RPC ? refuse(url, init) : ok(url, init);
    }) as unknown as typeof fetch;
    const r = await rpcBatch([RPC, RPC2], [{ method: "eth_chainId", params: [] }], f);
    expect(r).toEqual(["0x02"]);
    expect(seen).toEqual([RPC, RPC2]);
  });
});

describe("sell test", () => {
  const curveCode = "0x60806359a87bc11463d04c69831463fc0c546a14";
  const holders = [
    { address: CURVE, balance: "700000000", percent: 70, kind: "contract" as const },
    { address: WALLET, balance: "1000", percent: 0.1, kind: "wallet" as const },
  ];

  /** A launch curve: buying 0.001 ETH gives 1000 tokens (minus `buyTax`), selling returns 0.00095 ETH. */
  function curveChain(opts: { sellFails?: boolean; sellTax?: bigint } = {}) {
    const bought = 1000n * 10n ** 18n;
    return rpcFetch((c) => {
      if (c.method === "eth_getCode") return c.params[0] === CURVE ? curveCode : "0x";
      if (c.method === "eth_call") {
        const { to, data } = c.params[0] as { to: string; data: string };
        if (to === CURVE && data === "0xfc0c546a") return w(TOKEN);
        return new Error("revert");
      }
      if (c.method === "eth_simulateV1") {
        const calls = (c.params[0] as { blockStateCalls: Array<{ calls: unknown[] }> })
          .blockStateCalls[0]!.calls;
        const buy = { status: "0x1", logs: [log(TOKEN, CURVE, TESTER, bought)] };
        if (calls.length === 1) return [{ calls: [buy] }];
        const tax = opts.sellTax ?? 0n;
        const sell = opts.sellFails
          ? { status: "0x0", logs: [], error: { message: "execution reverted: TRADING_LOCKED" } }
          : {
              status: "0x1",
              logs: [
                log(TOKEN, TESTER, CURVE, bought - tax),
                ...(tax ? [log(TOKEN, TESTER, WALLET, tax)] : []),
                log(NATIVE, CURVE, TESTER, 95n * 10n ** 13n),
              ],
            };
        return [{ calls: [buy, { status: "0x1", logs: [] }, sell] }];
      }
      return new Error("unknown");
    });
  }

  it("buys and sells on a launch curve and reports the round trip", async () => {
    const r = await sellTest([RPC], curveChain(), TOKEN, holders, 18);
    expect(r).toMatchObject({
      status: "passed",
      method: "curve",
      venue: CURVE,
      buyTaxPercent: 0,
      sellTaxPercent: 0,
      roundTripPercent: 95,
    });
  });

  it("measures a sell tax from the tokens that went elsewhere", async () => {
    const r = await sellTest([RPC], curveChain({ sellTax: 100n * 10n ** 18n }), TOKEN, holders, 18);
    expect(r?.sellTaxPercent).toBe(10);
  });

  it("fails when the sell reverts", async () => {
    const r = await sellTest([RPC], curveChain({ sellFails: true }), TOKEN, holders, 18);
    expect(r?.status).toBe("failed");
    expect(r?.detail).toContain("TRADING_LOCKED");
  });

  it("falls back to pool transfers for a pair", async () => {
    const f = rpcFetch((c) => {
      if (c.method === "eth_getCode") return "0x60806040";
      if (c.method === "eth_call") {
        const { to, data } = c.params[0] as { to: string; data: string };
        if (to === POOL && data === "0x0dfe1681") return w(TOKEN);
        if (to === POOL && data === "0xd21220a7") return w(SPENDER);
        return new Error("revert");
      }
      if (c.method === "eth_simulateV1") {
        const calls = (c.params[0] as { blockStateCalls: Array<{ calls: unknown[] }> })
          .blockStateCalls[0]!.calls;
        const amount = 10_000n * 10n ** 18n;
        const buy = { status: "0x1", logs: [log(TOKEN, POOL, TESTER, amount)] };
        if (calls.length === 1) return [{ calls: [buy] }];
        // A 50% sell tax: half goes back to the pool, half to the "marketing" wallet.
        return [
          {
            calls: [
              buy,
              {
                status: "0x1",
                logs: [
                  log(TOKEN, TESTER, POOL, amount / 2n),
                  log(TOKEN, TESTER, WALLET, amount / 2n),
                ],
              },
            ],
          },
        ];
      }
      return new Error("unknown");
    });
    const r = await sellTest(
      [RPC],
      f,
      TOKEN,
      [{ address: POOL, balance: "100000000", percent: 10, kind: "contract" }],
      18,
    );
    expect(r).toMatchObject({ status: "passed", method: "transfer", sellTaxPercent: 50 });
  });

  it("returns null when no holder is a curve or pool", async () => {
    const f = rpcFetch((c) => (c.method === "eth_getCode" ? "0x6080" : new Error("revert")));
    expect(await sellTest([RPC], f, TOKEN, holders, 18)).toBeNull();
  });
});

const info = (over: Partial<AddressInfo> = {}): AddressInfo => ({
  address: SPENDER,
  kind: "contract",
  label: null,
  known: false,
  txCount: 500_000,
  firstSeen: "2026-07-01T00:00:00Z",
  ageDays: 130,
  ...over,
});

describe("approval judgement", () => {
  it("flags a plain wallet as spender", () => {
    const r = judgeApproval(
      { unlimited: false, balance: 10n, symbol: "X" },
      info({ kind: "wallet" }),
    );
    expect(r.risk).toBe("risk");
    expect(r.reasons.join(" ")).toContain("plain wallet");
  });

  it("flags a brand-new, little-used contract", () => {
    const r = judgeApproval(
      { unlimited: true, balance: 10n, symbol: "X" },
      info({ ageDays: 1, txCount: 12 }),
    );
    expect(r.risk).toBe("risk");
  });

  it("asks to check unlimited approvals to busy contracts", () => {
    const r = judgeApproval({ unlimited: true, balance: 0n, symbol: "X" }, info());
    expect(r.risk).toBe("warn");
    expect(r.reasons.join(" ")).toContain("You hold no $X");
  });

  it("is fine with a limited approval to an established contract", () => {
    const r = judgeApproval(
      { unlimited: false, balance: 5n, symbol: "X" },
      info({ known: true, label: "Pons launchpad" }),
    );
    expect(r.risk).toBe("ok");
    expect(r.reasons[0]).toContain("Pons launchpad");
  });

  it("formats units", () => {
    expect(formatUnits(1_234_500_000_000_000_000_000n, 18)).toBe("1,234.5");
    expect(formatUnits(1n, 18)).toBe("< 0.00000001");
    expect(formatUnits(0n, 6)).toBe("0");
  });
});

describe("wallet report", () => {
  it("drops approvals that are already zero and describes the rest", async () => {
    const other = "0x6666666666666666666666666666666666666666";
    const gr = {
      balances: {
        items: [
          {
            contract_address: NATIVE,
            contract_decimals: 18,
            balance: "2000000000000000000",
            contract_ticker_symbol: "ETH",
          },
          {
            contract_address: TOKEN,
            contract_name: " Test ",
            contract_ticker_symbol: "TST",
            contract_decimals: 18,
            balance: "5000000000000000000",
          },
          {
            contract_address: other,
            contract_name: "Dust",
            contract_ticker_symbol: "D",
            contract_decimals: 18,
            balance: "0",
          },
        ],
      },
      approvals: {
        items: [
          {
            token_address: TOKEN,
            balance: "5000000000000000000",
            spenders: [
              {
                spender_address: SPENDER,
                allowance: "UNLIMITED",
                block_signed_at: "2026-11-01T00:00:00Z",
                tx_hash: `0x${"a".repeat(64)}`,
              },
              {
                spender_address: WALLET,
                allowance: "1",
                block_signed_at: "2026-11-02T00:00:00Z",
                tx_hash: `0x${"b".repeat(64)}`,
              },
            ],
          },
          { token_address: other, spenders: [{ spender_address: SPENDER, allowance: "5" }] },
        ],
      },
    };
    const chain = rpcFetch((c) => {
      if (c.method === "eth_getCode") return c.params[0] === SPENDER ? "0x6080" : "0x";
      if (c.method === "eth_call") {
        const { to, data } = c.params[0] as { to: string; data: string };
        if (data.startsWith("0xdd62ed3e")) {
          if (to === other) return w(0n);
          return data.endsWith(SPENDER.slice(2)) ? w((1n << 256n) - 1n) : w(10n ** 18n);
        }
        return new Error("revert");
      }
      return new Error("unknown");
    });
    const f = ((url: string, init?: RequestInit) => {
      if (url.includes("/balances_v2/")) return Promise.resolve(json({ data: gr.balances }));
      if (url.includes("/approvals/")) return Promise.resolve(json({ data: gr.approvals }));
      if (url.includes("/transactions_summary/"))
        return Promise.resolve(
          json({
            data: {
              items: [
                {
                  total_count: 900000,
                  earliest_transaction: { block_signed_at: "2026-06-01T00:00:00Z" },
                },
              ],
            },
          }),
        );
      return chain(url, init);
    }) as unknown as typeof fetch;
    const r = await walletReport(
      {
        apiKey: "k",
        chain: "robinhood-mainnet",
        rpcUrls: [RPC],
        fetch: f,
        now: Date.UTC(2026, 10, 12),
      },
      "0x7777777777777777777777777777777777777777",
    );
    expect(r.eth).toBe("2");
    expect(r.holdings).toEqual([{ token: TOKEN, name: "Test", symbol: "TST", balance: "5" }]);
    expect(r.approvals.map((a) => [a.spender.address, a.risk, a.allowance])).toEqual([
      [WALLET, "risk", "1"],
      [SPENDER, "warn", "unlimited"],
    ]);
    expect(r.approvals[1]!.spender.txCount).toBe(900000);
  });
});

describe("lookalikes", () => {
  const report = (over: Partial<TokenScanReport["token"]>, address = TOKEN): TokenScanReport =>
    ({
      address,
      isContract: true,
      token: { name: "Mofu", symbol: "MOFU", decimals: 18, totalSupply: "1", ...over },
      checks: [{ id: "mint", label: "Mint?", status: "ok", detail: "No." }],
      verdict: "clean",
      origin: null,
      lookalikes: [],
    }) as unknown as TokenScanReport;

  const index = (list: IndexedToken[]): TokenIndex => ({
    noteToken: async () => {},
    tokens: async () => [],
    rememberTokens: async () => {},
    similar: async () => list,
  });

  it("calls out a token using the $MOFU name", async () => {
    const r = await withLookalikes(report({}), null, undefined);
    expect(r.verdict).toBe("risky");
    expect(r.checks.at(-1)).toMatchObject({ id: "lookalike", status: "risk" });
    expect(r.checks.at(-1)!.detail).toContain(MOFU_TOKEN);
  });

  it("leaves the official $MOFU alone", async () => {
    const r = await withLookalikes(report({}, MOFU_TOKEN), null, undefined);
    expect(r.verdict).toBe("clean");
    expect(r.checks.some((c) => c.id === "lookalike")).toBe(false);
  });

  it("warns when a token with the same ticker came first", async () => {
    const older = { address: POOL, name: "Pepe", symbol: "PEPE", verdict: "clean" as const, at: 1 };
    const f = ((url: string) =>
      Promise.resolve(
        json({
          data: {
            items: [
              {
                earliest_transaction: {
                  block_signed_at: url.includes(POOL)
                    ? "2026-09-01T00:00:00Z"
                    : "2026-11-01T00:00:00Z",
                },
              },
            ],
          },
        }),
      )) as unknown as typeof fetch;
    const r = await withLookalikes(report({ name: "Pepe", symbol: "PEPE" }), index([older]), {
      apiKey: "k",
      chain: "c",
      rpcUrls: [RPC],
      fetch: f,
    });
    expect(r.checks.at(-1)).toMatchObject({ id: "lookalike", status: "warn" });
    expect(r.lookalikes).toEqual([
      {
        address: POOL,
        name: "Pepe",
        symbol: "PEPE",
        verdict: "clean",
        at: 1,
        createdAt: "2026-09-01T00:00:00Z",
      },
    ]);
    expect(r.verdict).toBe("caution");
  });
});

describe("badge and revoke", () => {
  it("draws only fixed words", () => {
    expect(badgeSvg("clean")).toContain("no red flags");
    expect(badgeSvg(null)).toContain("not available");
    expect(badgeSvg("risky")).not.toContain("<script");
  });

  it("builds approve(spender, 0)", () => {
    expect(revokeData(SPENDER)).toBe(
      `0x095ea7b3${"0".repeat(24)}${SPENDER.slice(2)}${"0".repeat(64)}`,
    );
  });
});
