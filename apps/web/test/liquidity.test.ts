import { describe, expect, it } from "vitest";
import type { AddressInfo, TokenHolder } from "../src/shared/api.js";
import { revokeNftData } from "../src/client/lib/wallet.js";
import { V4_POOL_MANAGER } from "../src/worker/known.js";
import { curveInfo, readLiquidity, v2Info } from "../src/worker/liquidity.js";
import type { HistoryTx } from "../src/worker/poisoning.js";
import { judgeNftApproval, nftApprovalCandidates } from "../src/worker/wallet.js";
import {
  applySnapshot,
  cheapChanges,
  emptySnapshot,
  snapshotCalls,
  type TokenSnapshot,
} from "../src/worker/webhooks.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const CURVE = "0x2222222222222222222222222222222222222222";
const POOL = "0x3333333333333333333333333333333333333333";
const WALLET = "0x4444444444444444444444444444444444444444";
const OP = "0x5555555555555555555555555555555555555555";
const NFT = "0x6666666666666666666666666666666666666666";
const PONS = "0xe33e9e479df8802cb0866d5d05258bec4cf62948";
const RPC = "https://rpc.example";
const hex = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const ETH = 10n ** 18n;

describe("curveInfo", () => {
  it("shows the way to graduation when the curve has no admin functions", () => {
    const l = curveInfo(CURVE, {
      graduated: hex(0n),
      threshold: hex((42n * ETH) / 10n),
      balance: `0x${((508n * ETH) / 1000n).toString(16)}`,
      code: "0x6080604052",
    });
    expect(l.kind).toBe("curve");
    expect(l.status).toBe("ok");
    expect(l.curve).toMatchObject({ raised: 0.508, threshold: 4.2, progressPercent: 12 });
    expect(l.detail).toBe(
      "No. It's still on the Pons launch curve, which has no owner or withdraw function: ETH leaves it only through sells. 0.51 of the 4.2 ETH it needs to graduate is raised (12%).",
    );
  });

  it("warns when the curve's code has a withdraw function", () => {
    // PUSH4 withdraw() = 0x3ccfd60b
    const l = curveInfo(CURVE, {
      graduated: hex(0n),
      threshold: hex(4n * ETH),
      balance: "0x1",
      code: "0x6080633ccfd60b14",
    });
    expect(l.status).toBe("warn");
    expect(l.curve?.adminFunctions).toEqual(["withdraw()"]);
  });

  it("reports a graduated curve", () => {
    const l = curveInfo(CURVE, { graduated: hex(1n), threshold: null, balance: "0x0", code: "0x" });
    expect(l).toMatchObject({ kind: "graduated", status: "info", eth: null });
  });

  it("leaves progress out when the curve is priced in another token", () => {
    const l = curveInfo(CURVE, {
      graduated: hex(0n),
      threshold: hex(40n * ETH),
      balance: "0x0",
      code: "0x60",
    });
    expect(l.curve?.progressPercent).toBeNull();
    expect(l.detail).not.toMatch(/raised/);
  });
});

const holder = (address: string, percent: number, kind: TokenHolder["kind"]): TokenHolder => ({
  address,
  balance: "1",
  percent,
  kind,
});

describe("v2Info", () => {
  it("is risky when one wallet holds most of the LP tokens", () => {
    const l = v2Info(POOL, 321n * ETH, 1000n, 0n, [
      holder(WALLET, 74.2, "wallet"),
      holder(OP, 25.8, "wallet"),
    ]);
    expect(l.status).toBe("risk");
    expect(l.lp?.topWallet).toEqual({ address: WALLET, percent: 74.2 });
    expect(l.detail).toMatch(
      /^Yes\. One wallet \(0x4444…4444\) holds 74\.2% of the LP tokens for 321 ETH/,
    );
  });

  it("is fine when the LP tokens are burned", () => {
    const l = v2Info(POOL, 5n * ETH, 1000n, 990n, [
      holder("0x000000000000000000000000000000000000dead", 99, "burn"),
      holder(WALLET, 1, "wallet"),
    ]);
    expect(l.status).toBe("ok");
    expect(l.lp?.burnedPercent).toBe(99);
  });
});

describe("readLiquidity", () => {
  it("calls a token held by the v4 pool manager graduated when Pons launched it", async () => {
    const l = await readLiquidity([RPC], fetch, TOKEN, {
      holders: [holder(V4_POOL_MANAGER, 48, "contract")],
      sold: null,
      origin: {
        creator: WALLET,
        launcher: PONS,
        creationTx: "0x1",
        createdAt: null,
        creatorFirstSeen: null,
        creatorAgeDays: null,
        creatorTxCount: null,
        creatorHolds: null,
        creatorHoldsPercent: null,
        otherLaunches: [],
        otherLaunchCount: 0,
        otherLaunchDetails: [],
      },
    });
    expect(l?.kind).toBe("graduated");
  });

  it("reads a curve through one batch", async () => {
    const answers: Record<string, string> = {
      "0xe7c2b772": hex(0n),
      "0x8b0bc501": hex(4n * ETH),
    };
    const f = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Array<{
        id: number;
        method: string;
        params: [{ data?: string }];
      }>;
      return Response.json(
        body.map((c) => ({
          jsonrpc: "2.0",
          id: c.id,
          result:
            c.method === "eth_getBalance"
              ? `0x${(2n * ETH).toString(16)}`
              : c.method === "eth_getCode"
                ? "0x6080"
                : (answers[c.params[0].data ?? ""] ?? hex(0n)),
        })),
      );
    }) as unknown as typeof fetch;
    const l = await readLiquidity([RPC], f, TOKEN, {
      holders: [],
      sold: {
        status: "passed",
        method: "curve",
        venue: CURVE,
        buyTaxPercent: 0,
        sellTaxPercent: 0,
        roundTripPercent: 98,
        depth: null,
        detail: "",
      },
      origin: null,
    });
    expect(l?.curve).toMatchObject({ raised: 2, threshold: 4, progressPercent: 50 });
  });
});

describe("graduated webhook event", () => {
  const base = (over: Partial<TokenSnapshot>): TokenSnapshot => ({
    ...emptySnapshot(TOKEN),
    symbol: "TST",
    venue: CURVE,
    venueKind: "curve",
    polledAt: 1,
    ...over,
  });

  it("reads graduated() for tokens on a curve", () => {
    expect(snapshotCalls(base({})).map((c) => c.method)).toContain("eth_call");
    const s = applySnapshot(base({}), [null, null, null, null, "0x1", hex(1n)], 2);
    expect(s.graduated).toBe(true);
  });

  it("fires once on graduation and doesn't also call it a liquidity drop", () => {
    const prev = base({ graduated: false, liquidity: (4n * ETH).toString() });
    const next = base({ graduated: true, liquidity: "0", polledAt: 2 });
    expect(cheapChanges(prev, next).map((c) => c.type)).toEqual(["graduated"]);
    expect(cheapChanges(next, { ...next, polledAt: 3 })).toEqual([]);
  });
});

const info = (over: Partial<AddressInfo>): AddressInfo => ({
  address: OP,
  kind: "contract",
  label: null,
  known: false,
  txCount: 50_000,
  firstSeen: null,
  ageDays: 200,
  ...over,
});

describe("NFT approvals", () => {
  it("collects them from the index and from ApprovalForAll events, newest first", () => {
    const history = [
      {
        tx_hash: "0xaa",
        block_signed_at: "2026-11-10T00:00:00Z",
        from_address: WALLET,
        log_events: [
          {
            sender_address: NFT,
            decoded: {
              name: "ApprovalForAll",
              params: [
                { name: "owner", value: WALLET },
                { name: "operator", value: OP },
                { name: "approved", value: true },
              ],
            },
          },
        ],
      },
    ] as HistoryTx[];
    const index = [
      {
        contract_address: POOL,
        contract_name: "Kittens",
        spenders: [
          { spender_address: OP, block_signed_at: "2026-11-01T00:00:00Z", tx_hash: "0xbb" },
        ],
      },
    ];
    const c = nftApprovalCandidates(WALLET, index, history);
    expect(c.map((x) => [x.collection, x.operator])).toEqual([
      [NFT, OP],
      [POOL, OP],
    ]);
    expect(c[1]!.name).toBe("Kittens");
  });

  it("is risky when the operator is a plain wallet", () => {
    expect(judgeNftApproval("Kittens", info({ kind: "wallet" })).risk).toBe("risk");
    expect(judgeNftApproval("Kittens", info({})).risk).toBe("warn");
  });

  it("builds setApprovalForAll(operator, false)", () => {
    expect(revokeNftData(OP)).toBe(`0xa22cb465${"0".repeat(24)}${OP.slice(2)}${"0".repeat(64)}`);
  });
});
