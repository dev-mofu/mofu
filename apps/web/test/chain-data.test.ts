import { describe, expect, it } from "vitest";
import { explainTransaction, tokenOrigin, topHolders } from "../src/worker/chain-data.js";
import { summaryOnly } from "../src/worker/token-scan.js";
import type { TokenScanReport } from "../src/shared/api.js";

const TOKEN = "0xf76593c1c321c2a2f77775025e9677999ce7ea8c";
const CURVE = "0xc2347eda73ddcbc7a1ce29ff140fd6a62d0cf460";
const CREATOR = "0x636dd2c0299601df246efbfefcd67f12c9e57d08";
const LAUNCHER = "0xe33e9e479df8802cb0866d5d05258bec4cf62948";
const ZERO = "0x0000000000000000000000000000000000000000";
const RPC = "https://rpc.example";
const SUPPLY = 10n ** 27n;
const CONTRACTS = new Set([CURVE, LAUNCHER, TOKEN]);

/** GoldRush and RPC stand-ins keyed by URL path. */
function fake(gr: Record<string, unknown>, balances: Record<string, bigint> = {}): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url === RPC) {
      const { method, params } = JSON.parse(String(init?.body)) as {
        method: string;
        params: [unknown];
      };
      if (method === "eth_getCode") {
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: CONTRACTS.has(String(params[0])) ? "0x6080" : "0x",
        });
      }
      const data = (params[0] as { data: string }).data;
      const who = `0x${data.slice(-40)}`;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: `0x${(balances[who] ?? 0n).toString(16).padStart(64, "0")}`,
      });
    }
    const path = url.replace("https://api.covalenthq.com/v1/robinhood-mainnet/", "");
    const data = gr[path];
    return data
      ? Response.json({ data, error: false })
      : Response.json({ data: null, error: true, error_message: "Not found" }, { status: 404 });
  }) as unknown as typeof fetch;
}
const opts = (f: typeof fetch) => ({
  apiKey: "k",
  chain: "robinhood-mainnet",
  rpcUrls: [RPC],
  fetch: f,
});

const transfer = (token: string, from: string, to: string, value: bigint, symbol = "MOFU") => ({
  sender_address: token,
  sender_contract_ticker_symbol: symbol,
  sender_contract_decimals: 18,
  decoded: {
    name: "Transfer",
    params: [
      { name: "from", value: from },
      { name: "to", value: to },
      { name: "value", value: value.toString() },
    ],
  },
});

describe("topHolders", () => {
  it("sorts by balance and labels contracts and burns", async () => {
    const f = fake({
      [`tokens/${TOKEN}/token_holders_v2/`]: {
        items: [
          {
            address: "0x2222222222222222222222222222222222222222",
            balance: (3n * 10n ** 25n).toString(),
            total_supply: SUPPLY.toString(),
            contract_decimals: 18,
          },
          {
            address: CURVE,
            balance: (7n * 10n ** 26n).toString(),
            total_supply: SUPPLY.toString(),
            contract_decimals: 18,
          },
          {
            address: "0x000000000000000000000000000000000000dEaD",
            balance: (5n * 10n ** 24n).toString(),
            total_supply: SUPPLY.toString(),
            contract_decimals: 18,
          },
        ],
      },
    });
    const h = await topHolders(opts(f), TOKEN);
    expect(h.map((x) => [x.kind, x.percent])).toEqual([
      ["contract", 70],
      ["wallet", 3],
      ["burn", 0.5],
    ]);
  });
});

describe("tokenOrigin", () => {
  it("finds the creator from the earliest transaction and counts other launches", async () => {
    const other = "0x9999999999999999999999999999999999999999";
    const f = fake(
      {
        [`address/${TOKEN}/transactions_summary/`]: {
          items: [{ total_count: 300, earliest_transaction: { tx_hash: "0xaaa" } }],
        },
        "transaction_v2/0xaaa/": {
          items: [
            {
              from_address: CREATOR,
              to_address: LAUNCHER,
              block_signed_at: "2026-11-11T16:35:09Z",
              log_events: [transfer(TOKEN, ZERO, CURVE, SUPPLY)],
            },
          ],
        },
        [`address/${CREATOR}/transactions_summary/`]: {
          items: [
            { total_count: 34, earliest_transaction: { block_signed_at: "2026-11-01T00:00:00Z" } },
          ],
        },
        [`address/${CREATOR}/transactions_v3/page/0/`]: {
          items: [
            { to_address: LAUNCHER, log_events: [transfer(other, ZERO, CURVE, SUPPLY, "OTHER")] },
            { to_address: LAUNCHER, log_events: [transfer(TOKEN, ZERO, CURVE, SUPPLY)] },
          ],
        },
      },
      { [CREATOR]: SUPPLY / 50n },
    );
    const o = await tokenOrigin(opts(f), TOKEN, SUPPLY, 18, Date.parse("2026-11-12T00:00:00Z"));
    expect(o).toMatchObject({
      creator: CREATOR,
      launcher: LAUNCHER,
      creatorAgeDays: 11,
      creatorTxCount: 34,
      creatorHoldsPercent: 2,
      otherLaunchCount: 1,
      otherLaunches: [other],
    });
  });
});

describe("explainTransaction", () => {
  it("decodes transfers and flags unlimited approvals to plain wallets", async () => {
    const drainer = "0x1111111111111111111111111111111111111111";
    const f = fake({
      "transaction_v2/0xbbb/": {
        items: [
          {
            from_address: CREATOR,
            to_address: TOKEN,
            successful: true,
            value: "0",
            fees_paid: "1000000000000",
            block_signed_at: "2026-11-11T17:00:00Z",
            log_events: [
              transfer(
                TOKEN,
                CREATOR,
                "0x000000000000000000000000000000000000dEaD",
                5n * 10n ** 24n,
              ),
              {
                sender_address: TOKEN,
                sender_contract_ticker_symbol: "MOFU",
                sender_contract_decimals: 18,
                decoded: {
                  name: "Approval",
                  params: [
                    { name: "owner", value: CREATOR },
                    { name: "spender", value: drainer },
                    { name: "value", value: ((1n << 256n) - 1n).toString() },
                  ],
                },
              },
            ],
          },
        ],
      },
    });
    const r = await explainTransaction(opts(f), "0xbbb");
    expect(r.transfers[0]).toMatchObject({ amount: "5,000,000", symbol: "MOFU", burn: true });
    expect(r.approvals[0]).toMatchObject({
      amount: "unlimited",
      unlimited: true,
      spenderIsContract: false,
    });
    expect(r.flags.map((x) => x.level)).toEqual(["risk", "risk"]);
    expect(r.feeEth).toBe("0.000001");
  });

  it("reports an unknown hash as not found", async () => {
    await expect(explainTransaction(opts(fake({})), "0xccc")).rejects.toThrow(/not found/i);
  });
});

describe("summaryOnly", () => {
  it("keeps the summary and drops the holder list and origin", () => {
    const full = {
      distribution: {
        status: "full",
        top10Percent: 90,
        largestWallet: { address: CREATOR, percent: 3 },
        holders: [{ address: CURVE, balance: "1", percent: 70, kind: "contract" }],
      },
      origin: { creator: CREATOR },
    } as unknown as TokenScanReport;
    const s = summaryOnly(full);
    expect(s.distribution).toMatchObject({ status: "summary", top10Percent: 90, holders: [] });
    expect(s.origin).toBeNull();
  });
});
