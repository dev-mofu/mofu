import { describe, expect, it } from "vitest";
import { analyzeCall, analyzeRequest } from "../src/decode.js";
import { changeText, judgePreview, previewRequest, type TxPreview } from "../src/preview.js";

const ME = "0x636dd2c0299601df246efbfefcd67f12c9e57d08";
const CURVE = "0xc2347eda73ddcbc7a1ce29ff140fd6a62d0cf460";
const TOKEN = "0xf76593c1c321c2a2f77775025e9677999ce7ea8c";
const THIEF = "0x9999999999999999999999999999999999999999";
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const preview = (over: Partial<TxPreview>): TxPreview => ({
  status: "ok",
  error: null,
  failedCall: null,
  changes: [],
  approvals: [],
  ...over,
});
const ethOut = {
  asset: NATIVE,
  kind: "eth" as const,
  symbol: "ETH",
  direction: "out" as const,
  amount: "0.5",
  tokenId: null,
};
const tokensIn = {
  asset: TOKEN,
  kind: "token" as const,
  symbol: "MOFU",
  direction: "in" as const,
  amount: "342,356.2371",
  tokenId: null,
};

describe("previewRequest", () => {
  it("builds the body for a transaction and for a batch", () => {
    expect(
      previewRequest("eth_sendTransaction", [
        { from: ME, to: CURVE, data: "0x59a87bc1", value: "0x38d7ea4c68000" },
      ]),
    ).toEqual({ from: ME, calls: [{ to: CURVE, data: "0x59a87bc1", value: "0x38d7ea4c68000" }] });
    expect(
      previewRequest("wallet_sendCalls", [
        { from: ME, calls: [{ to: CURVE, data: "0x1" }, { to: TOKEN }] },
      ])?.calls.map((c) => c.value),
    ).toEqual(["0x0", "0x0"]);
  });

  it("skips what it can't simulate", () => {
    expect(previewRequest("eth_signTypedData_v4", [ME, "{}"])).toBeNull();
    expect(previewRequest("eth_sendTransaction", [{ to: CURVE }])).toBeNull(); // no from
    expect(previewRequest("eth_sendTransaction", [{ from: ME, data: "0x60" }])).toBeNull(); // deploy
  });
});

describe("judgePreview", () => {
  const buy = analyzeCall({ to: CURVE, data: "0x59a87bc1" });

  it("says nothing extra for a normal buy", () => {
    expect(judgePreview([buy], preview({ changes: [ethOut, tokensIn] }))).toEqual({
      findings: [],
      prompt: false,
    });
  });

  it("catches an approval the request doesn't show", () => {
    const j = judgePreview(
      [buy],
      preview({
        changes: [ethOut, tokensIn],
        approvals: [
          {
            token: TOKEN,
            symbol: "MOFU",
            spender: THIEF,
            kind: "token",
            revoke: false,
            unlimited: true,
            amount: "unlimited",
          },
        ],
      }),
    );
    expect(j.prompt).toBe(true);
    expect(j.findings[0]).toEqual({
      level: "risk",
      text: "This transaction also lets 0x9999…9999 spend unlimited of your MOFU. The request itself doesn't say so.",
    });
  });

  it("doesn't repeat an approval the request already shows", () => {
    const [approve] = analyzeRequest("eth_sendTransaction", [
      { to: TOKEN, data: `0x095ea7b3${THIEF.slice(2).padStart(64, "0")}${"f".repeat(64)}` },
    ]);
    const j = judgePreview(
      [approve!],
      preview({
        approvals: [
          {
            token: TOKEN,
            symbol: "MOFU",
            spender: THIEF,
            kind: "token",
            revoke: false,
            unlimited: true,
            amount: "unlimited",
          },
        ],
      }),
    );
    expect(j.findings).toEqual([]);
  });

  it("warns when you give and get nothing back", () => {
    const j = judgePreview([buy], preview({ changes: [ethOut] }));
    expect(j.findings[0]?.text).toBe("You give 0.5 ETH and get nothing back in this transaction.");
    expect(j.prompt).toBe(true);
  });

  it("warns when it would fail", () => {
    const j = judgePreview([buy], preview({ status: "reverted", error: "execution reverted" }));
    expect(j.findings[0]?.level).toBe("warn");
    expect(j.findings[0]?.text).toMatch(/would fail \(execution reverted\)/);
  });
});

describe("changeText", () => {
  it("reads like a wallet statement", () => {
    expect(changeText(ethOut)).toBe("− 0.5 ETH");
    expect(changeText(tokensIn)).toBe("+ 342,356.2371 MOFU");
    expect(
      changeText({
        asset: TOKEN,
        kind: "nft",
        symbol: "PKIT",
        direction: "out",
        amount: "1",
        tokenId: "12",
      }),
    ).toBe("− NFT #12 of PKIT");
  });
});
