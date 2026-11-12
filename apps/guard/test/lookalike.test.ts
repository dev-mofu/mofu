import { describe, expect, it } from "vitest";
import { analyzeCall } from "../src/decode.js";
import {
  imitates,
  looksLike,
  rememberRecipients,
  sentTo,
  withPoisonCheck,
} from "../src/lookalike.js";
import { addressesIn, isX } from "../src/xlabels.js";

const REAL = "0x1234567890abcdef1234567890abcdef12345678";
const FAKE = "0x1234ffffffffffffffffffffffffffffffff5678"; // same first 4 and last 4
const OTHER = "0x9999567890abcdef1234567890abcdef12345678";
const ME = "0xabcd000000000000000000000000000000004321";
const pad = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");

describe("lookalike addresses", () => {
  it("matches same first and last four characters, different address", () => {
    expect(looksLike(FAKE, REAL)).toBe(true);
    expect(looksLike(FAKE.toUpperCase().replace("0X", "0x"), REAL)).toBe(true);
    expect(looksLike(REAL, REAL)).toBe(false);
    expect(looksLike(OTHER, REAL)).toBe(false);
    expect(looksLike("0x12", REAL)).toBe(false);
    expect(imitates(FAKE, [OTHER, REAL])).toBe(REAL);
    expect(imitates(OTHER, [REAL])).toBeNull();
  });

  it("stops an ETH send to a lookalike of a past recipient", () => {
    const send = analyzeCall({ to: FAKE, value: "0x2386f26fc10000" });
    expect(send.prompt).toBe(false);
    const checked = withPoisonCheck(send, { recipients: [REAL], self: ME });
    expect(checked.prompt).toBe(true);
    expect(checked.findings[0]).toMatchObject({ level: "risk" });
    expect(checked.findings[0]!.text).toContain(`Sending to ${FAKE}, you sent to ${REAL} before`);
    // the real one goes through untouched
    expect(
      withPoisonCheck(analyzeCall({ to: REAL, value: "0x1" }), { recipients: [REAL], self: ME })
        .prompt,
    ).toBe(false);
  });

  it("stops a token transfer to a lookalike of your own address", () => {
    const twinOfMe = "0xabcdeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee4321";
    const transfer = analyzeCall({ to: REAL, data: `0xa9059cbb${pad(twinOfMe)}${pad("64")}` });
    const checked = withPoisonCheck(transfer, { recipients: [], self: ME });
    expect(checked.prompt).toBe(true);
    expect(checked.findings[0]!.text).toContain("looks like your own address");
  });

  it("remembers recipients newest first, without duplicates", () => {
    const sends = [
      analyzeCall({ to: REAL, value: "0x1" }),
      analyzeCall({ to: OTHER, data: "0x095ea7b3" + pad(REAL) + pad("1") }),
    ];
    expect(sentTo(sends)).toEqual([REAL]);
    expect(rememberRecipients([OTHER, REAL], [REAL.toUpperCase().replace("0X", "0x")], 2)).toEqual([
      REAL,
      OTHER,
    ]);
  });
});

describe("labels on X", () => {
  it("runs only on X and finds up to three unique addresses in a post", () => {
    expect(isX("x.com")).toBe(true);
    expect(isX("mobile.twitter.com")).toBe(true);
    expect(isX("notx.com")).toBe(false);
    const text = `CA: ${REAL} again ${REAL.toUpperCase().replace("0X", "0x")} and ${OTHER}, ${ME}, ${FAKE} and 0x${"a".repeat(41)}`;
    expect(addressesIn(text)).toEqual([REAL, OTHER, ME]);
  });
});
