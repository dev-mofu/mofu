import { describe, expect, it } from "vitest";
import { analyzeCall, analyzeRequest, analyzeTypedData, enrich } from "../src/decode.js";

const TOKEN = "0xf76593c1c321c2a2f77775025e9677999ce7ea8c";
const SPENDER = "0x1111111111111111111111111111111111111111";
const ME = "0x636dd2c0299601df246efbfefcd67f12c9e57d08";
const pad = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
const MAX = "f".repeat(64);

describe("transactions", () => {
  it("flags an unlimited approve", () => {
    const a = analyzeCall({ to: TOKEN, data: `0x095ea7b3${pad(SPENDER)}${MAX}` });
    expect(a).toMatchObject({
      kind: "approval",
      token: TOKEN,
      spender: SPENDER,
      unlimited: true,
      prompt: true,
    });
    expect(a.findings[0]!.level).toBe("risk");
  });

  it("treats approve(…, 0) as a safe revoke", () => {
    const a = analyzeCall({ to: TOKEN, data: `0x095ea7b3${pad(SPENDER)}${pad("0")}` });
    expect(a.title).toBe("Remove an approval");
    expect(a.prompt).toBe(false);
    expect(a.findings[0]!.level).toBe("ok");
  });

  it("warns on a limited approve and on setApprovalForAll", () => {
    const limited = analyzeCall({
      to: TOKEN,
      data: `0x095ea7b3${pad(SPENDER)}${pad("de0b6b3a7640000")}`,
    });
    expect(limited).toMatchObject({ unlimited: false, prompt: true });
    expect(limited.findings[0]!.level).toBe("warn");
    const all = analyzeCall({ to: TOKEN, data: `0xa22cb465${pad(SPENDER)}${pad("1")}` });
    expect(all).toMatchObject({ kind: "approval-all", spender: SPENDER, prompt: true });
  });

  it("describes sends and transfers without stopping them", () => {
    const send = analyzeCall({ to: SPENDER, value: "0xde0b6b3a7640000" });
    expect(send.lines[0]).toContain("1 ETH");
    expect(send.prompt).toBe(false);
    const transfer = analyzeCall({ to: TOKEN, data: `0xa9059cbb${pad(SPENDER)}${pad("64")}` });
    expect(transfer).toMatchObject({ kind: "transfer", prompt: false });
  });

  it("reads every call in wallet_sendCalls", () => {
    const r = analyzeRequest("wallet_sendCalls", [
      {
        calls: [
          { to: TOKEN, data: `0x095ea7b3${pad(SPENDER)}${MAX}` },
          { to: SPENDER, value: "0x1" },
        ],
      },
    ]);
    expect(r.map((a) => a.kind)).toEqual(["approval", "send"]);
  });
});

describe("signatures", () => {
  const permit = (value: string, spender = SPENDER) =>
    JSON.stringify({
      primaryType: "Permit",
      domain: { name: "Mofu", verifyingContract: TOKEN, chainId: 4663 },
      message: { owner: ME, spender, value, nonce: 0, deadline: 9999999999 },
    });

  it("flags an unlimited EIP-2612 permit", () => {
    const [a] = analyzeRequest("eth_signTypedData_v4", [ME, permit(`0x${MAX}`)]);
    expect(a).toMatchObject({
      kind: "permit",
      token: TOKEN,
      spender: SPENDER,
      unlimited: true,
      prompt: true,
    });
    expect(a!.findings[0]!.level).toBe("risk");
  });

  it("reads Permit2 single and transfer signatures", () => {
    const single = analyzeTypedData({
      primaryType: "PermitSingle",
      domain: { name: "Permit2" },
      message: {
        details: { token: TOKEN, amount: "1461501637330902918203684832716283019655932542975" },
        spender: SPENDER,
      },
    });
    expect(single).toMatchObject({ kind: "permit", unlimited: true, prompt: true });
    const transfer = analyzeTypedData({
      primaryType: "PermitTransferFrom",
      message: { permitted: { token: TOKEN, amount: "1000" }, spender: SPENDER },
    });
    expect(transfer).toMatchObject({ kind: "permit", spender: SPENDER, prompt: true });
  });

  it("calls out marketplace orders that ask for nothing", () => {
    const a = analyzeTypedData({
      primaryType: "OrderComponents",
      domain: { name: "Seaport" },
      message: { offer: [{}], consideration: [] },
    });
    expect(a.findings[0]!.level).toBe("risk");
  });

  it("stops blind eth_sign and lets unknown typed data through with a note", () => {
    expect(analyzeRequest("eth_sign", [ME, "0x" + "ab".repeat(32)])[0]).toMatchObject({
      kind: "blind-sign",
      prompt: true,
    });
    const unknown = analyzeTypedData({
      primaryType: "Login",
      domain: { name: "Some app" },
      message: {},
    });
    expect(unknown.prompt).toBe(false);
  });
});

describe("enrich", () => {
  it("adds a drainer warning when the spender is a plain wallet", () => {
    const a = analyzeCall({ to: TOKEN, data: `0x095ea7b3${pad(SPENDER)}${pad("64")}` });
    const e = enrich(a, { spender: { address: SPENDER, isContract: false } });
    expect(e.findings[0]).toMatchObject({ level: "risk" });
    expect(e.findings[0]!.text).toContain("plain wallet");
  });

  it("adds the token's scan verdict", () => {
    const a = analyzeCall({ to: TOKEN, data: `0xa9059cbb${pad(SPENDER)}${pad("64")}` });
    const risky = enrich(a, {
      token: {
        symbol: "BAD",
        name: "Bad",
        verdict: "risky",
        isContract: true,
        risks: ["Yes. The owner can mint."],
      },
    });
    expect(risky.prompt).toBe(true);
    const clean = enrich(a, {
      token: { symbol: "MOFU", name: "Mofu", verdict: "clean", isContract: true, risks: [] },
    });
    expect(clean.findings.at(-1)!.level).toBe("ok");
    expect(clean.prompt).toBe(false);
  });
});
