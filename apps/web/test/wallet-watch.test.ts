import { describe, expect, it } from "vitest";
import type { AddressInfo, WalletReport } from "../src/shared/api.js";
import { walletChanges, walletSnapshot, type WalletSnapshot } from "../src/worker/wallet-watch.js";

const W = "0x4444444444444444444444444444444444444444";
const TOKEN = "0x1111111111111111111111111111111111111111";
const DRAINER = "0x9999999999999999999999999999999999999999";
const ROUTER = "0x8888888888888888888888888888888888888888";
const NFT = "0x6666666666666666666666666666666666666666";
const FAKE = "0x4444ffffffffffffffffffffffffffffffff4444";
const NOW = Date.parse("2026-11-13T12:00:00Z");

const info = (
  address: string,
  kind: AddressInfo["kind"],
  label: string | null = null,
): AddressInfo => ({
  address,
  kind,
  label,
  known: !!label,
  txCount: 10,
  firstSeen: null,
  ageDays: 1,
});

const report = (over: Partial<WalletReport> = {}): WalletReport => ({
  address: W,
  isContract: false,
  eth: "0.1",
  holdings: [{ token: TOKEN, name: "Kitty", symbol: "KITTY", balance: "1,000" }],
  holdingsTotal: 1,
  approvals: [
    {
      token: TOKEN,
      tokenName: "Kitty",
      tokenSymbol: "KITTY",
      balance: "1,000",
      spender: info(ROUTER, "contract", "Uniswap router"),
      unlimited: true,
      allowance: "unlimited",
      approvedAt: null,
      txHash: null,
      risk: "warn",
      reasons: ["Unlimited."],
    },
  ],
  nftApprovals: [],
  poisoning: [],
  status: { holdings: "ok", approvals: "ok" },
  checkedAt: new Date(NOW).toISOString(),
  limits: [],
  ...over,
});

describe("walletSnapshot", () => {
  it("keeps only risky approvals, lookalikes and holdings Mofu rates risky", () => {
    const s = walletSnapshot(report(), { [TOKEN]: "caution" }, NOW);
    expect(s).toEqual({ approvals: [], poison: [], risky: [], polledAt: NOW });
    const r = walletSnapshot(report(), { [TOKEN]: "risky" }, NOW);
    expect(r.risky).toEqual([TOKEN]);
  });
});

describe("walletChanges", () => {
  const base: WalletSnapshot = { approvals: [], poison: [], risky: [], polledAt: NOW - 1 };

  it("reports a new risky approval, a planted lookalike and a holding gone risky", () => {
    const r = report({
      approvals: [
        ...report().approvals,
        {
          ...report().approvals[0]!,
          spender: info(DRAINER, "wallet"),
          risk: "risk",
          reasons: ["The spender is a plain wallet, not a contract."],
        },
      ],
      nftApprovals: [
        {
          collection: NFT,
          name: "Pixel Kittens",
          symbol: "PKIT",
          operator: info(DRAINER, "wallet"),
          approvedAt: null,
          txHash: null,
          risk: "risk",
          reasons: [
            "It can move every NFT you hold in Pixel Kittens.",
            "The operator is a plain wallet.",
          ],
        },
      ],
      poisoning: [
        {
          address: FAKE,
          resembles: null,
          resemblesSelf: true,
          kind: "zero-transfer",
          token: null,
          tokenSymbol: null,
          txHash: "0xabc",
          at: null,
          risk: "risk",
        },
      ],
    });
    const next = walletSnapshot(r, { [TOKEN]: "risky" }, NOW);
    const ev = walletChanges(W, base, next, r);
    expect(ev.map((e) => e.type)).toEqual([
      "risky_approval",
      "risky_approval",
      "poisoning",
      "holding_risky",
    ]);
    expect(ev[0]!.summary).toBe(
      "0x4444…4444 gave a risky approval: 0x9999…9999 (wallet) can spend unlimited $KITTY. The spender is a plain wallet, not a contract.",
    );
    expect(ev[1]!.summary).toBe(
      "0x4444…4444 let 0x9999…9999 move every item in Pixel Kittens. The operator is a plain wallet.",
    );
    expect(ev[2]!.summary).toContain(`never send to ${FAKE}`);
    expect(ev[3]!.summary).toBe("0x4444…4444 holds $KITTY, which Mofu now rates risky.");
    // Seen once, not again.
    expect(walletChanges(W, next, next, r)).toEqual([]);
  });
});
