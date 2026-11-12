import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkBeforeBuy, decide, DEFAULT_POLICY, type TokenReport } from "../mofu.ts";
import { handleEvent, verifySignature } from "../webhook-receiver.ts";

const TOKEN = "0xf76593c1c321c2a2f77775025e9677999ce7ea8c";
const clean: TokenReport = {
  address: TOKEN,
  isContract: true,
  token: { name: "Mofu", symbol: "MOFU" },
  verdict: "clean",
  checks: [{ id: "mint", label: "Mint", status: "ok", detail: "No mint function found." }],
  sellTest: { status: "passed", buyTaxPercent: 0, sellTaxPercent: 0, roundTripPercent: 94.86 },
  lookalikes: [],
};

describe("buy rule", () => {
  it("allows a clean token whose sell test passed", () => {
    expect(decide(clean)).toMatchObject({ allowed: true, reasons: [] });
  });

  it("refuses risky verdicts, risk checks, failed or missing sell tests and high taxes", () => {
    expect(decide({ ...clean, verdict: "risky" }).reasons).toContain("Mofu's verdict is risky");
    const mint = decide({
      ...clean,
      checks: [{ id: "mint", label: "Mint", status: "risk", detail: "The owner can mint." }],
    });
    expect(mint.reasons).toContain("Mint: The owner can mint.");
    expect(
      decide({ ...clean, sellTest: { ...clean.sellTest!, status: "failed" } }).reasons[0],
    ).toMatch(/honeypot/);
    expect(decide({ ...clean, sellTest: null }).allowed).toBe(false);
    expect(
      decide({ ...clean, sellTest: null }, { ...DEFAULT_POLICY, requireSellTest: false }).allowed,
    ).toBe(true);
    expect(
      decide({ ...clean, sellTest: { ...clean.sellTest!, sellTaxPercent: 25 } }).reasons,
    ).toEqual(["sell tax 25% is over 10%"]);
    const twin = { ...clean, lookalikes: [{ address: "0x1" }] };
    expect(decide(twin).allowed).toBe(true);
    expect(decide(twin, { ...DEFAULT_POLICY, blockLookalikes: true }).allowed).toBe(false);
  });

  it("says no when Mofu can't be reached", async () => {
    const down = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    const d = await checkBeforeBuy(
      "0x2222222222222222222222222222222222222222",
      DEFAULT_POLICY,
      down,
    );
    expect(d.allowed).toBe(false);
    expect(d.reasons[0]).toMatch(/no answer from Mofu/);
  });

  it("reads the report from the API", async () => {
    let asked = "";
    const api = (async (u: string) => {
      asked = u;
      return Response.json({ report: { ...clean, verdict: "caution" } });
    }) as unknown as typeof fetch;
    const d = await checkBeforeBuy(
      "0x3333333333333333333333333333333333333333",
      DEFAULT_POLICY,
      api,
    );
    expect(asked).toBe(
      "https://mofu.works/api/v1/token/0x3333333333333333333333333333333333333333",
    );
    expect(d.allowed).toBe(true);
  });
});

describe("webhook receiver", () => {
  const body = JSON.stringify({ id: "evt_1", type: "owner_changed" });
  const sign = (t: number, secret = "whsec_k") =>
    `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

  it("accepts a fresh, correct signature only", () => {
    const now = 1_800_000_000;
    expect(verifySignature(sign(now), body, "whsec_k", now)).toBe(true);
    expect(verifySignature(sign(now, "whsec_other"), body, "whsec_k", now)).toBe(false);
    expect(verifySignature(sign(now - 600), body, "whsec_k", now)).toBe(false);
    expect(verifySignature(sign(now), `${body} `, "whsec_k", now)).toBe(false);
    expect(verifySignature(undefined, body, "whsec_k", now)).toBe(false);
    expect(verifySignature("t=1,v1=zz", body, "whsec_k", now)).toBe(false);
  });

  it("pauses tokens on worrying events only", () => {
    const paused: string[] = [];
    const pause = (a: string) => void paused.push(a);
    const token = { address: TOKEN, symbol: "MOFU" };
    const ev = (type: string, after: unknown = null) => ({
      id: "e",
      type,
      summary: "s",
      token,
      before: null,
      after,
    });
    expect(handleEvent(ev("owner_changed"), pause)).toMatch(/^PAUSED/);
    expect(handleEvent(ev("verdict_changed", "clean"), pause)).not.toMatch(/^PAUSED/);
    expect(handleEvent(ev("verdict_changed", "risky"), pause)).toMatch(/^PAUSED/);
    expect(handleEvent({ ...ev("test"), token: null }, pause)).toBe("test: s");
    expect(paused).toEqual([TOKEN, TOKEN]);
  });
});
