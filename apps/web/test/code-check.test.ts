import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";
import { watchSnippet } from "../src/worker/pages.js";
import { customFunctions, dispatcherSelectors, nameOf } from "../src/worker/signatures.js";
import { codeCheck, functionDiff, PONS_TOKEN_FINGERPRINT } from "../src/worker/templates.js";

const sel = (s: string) =>
  Array.from(keccak_256(new TextEncoder().encode(s)).subarray(0, 4), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/** Bytecode with a dispatcher entry (PUSH4 sel, EQ, PUSH2 dest, JUMPI) per signature. */
const dispatcher = (sigs: string[], extraPush4: string[] = []) =>
  "0x" +
  sigs.map((s) => `63${sel(s)}14610100` + "57").join("") +
  // an error selector stored to memory: PUSH4 x, PUSH1 0xe0, SHL — not a function
  extraPush4.map((x) => `63${x}60e01b`).join("") +
  "00";

describe("dispatcherSelectors", () => {
  it("reads the functions the dispatcher compares, not error selectors", () => {
    const code = dispatcher(["transfer(address,uint256)", "mint(address,uint256)"], ["e450d38c"]);
    expect(dispatcherSelectors(code)).toEqual(
      [sel("transfer(address,uint256)"), sel("mint(address,uint256)")].sort(),
    );
  });

  it("names what it knows and counts the rest", () => {
    expect(nameOf(sel("setFee(uint256)"))).toBe("setFee(uint256)");
    const c = customFunctions([
      sel("transfer(address,uint256)"),
      sel("setFee(uint256)"),
      "deadbeef",
    ]);
    expect(c).toEqual({ named: ["setFee(uint256)"], unknown: ["0xdeadbeef"] });
  });
});

describe("codeCheck", () => {
  it("recognizes the standard Pons token code", () => {
    const r = codeCheck(PONS_TOKEN_FINGERPRINT, dispatcher(["transfer(address,uint256)"]), false)!;
    expect(r.check).toMatchObject({ id: "code", status: "ok" });
    expect(r.facts.standard).toBe("pons");
  });

  it("calls a plain token plain", () => {
    const r = codeCheck(
      "ff".repeat(16),
      dispatcher(["transfer(address,uint256)", "approve(address,uint256)"]),
      false,
    )!;
    expect(r.check.detail).toBe("It has only the functions of a plain token.");
  });

  it("lists custom functions and warns about balance rewriting", () => {
    const r = codeCheck(
      null,
      dispatcher(["transfer(address,uint256)", "setFee(uint256)", "setBalance(address,uint256)"]),
      true,
    )!;
    expect(r.check.status).toBe("warn");
    expect(r.check.detail).toMatch(
      /^Custom code\. Its current code \(behind the proxy\) has 2 named functions/,
    );
    expect(r.facts.named).toEqual(["setBalance(address,uint256)", "setFee(uint256)"]);
  });

  it("gives up quietly when no functions can be read", () => {
    expect(codeCheck(null, "0x00", false)).toBeNull();
  });
});

describe("functionDiff", () => {
  it("says what an upgrade added and removed", () => {
    const before = dispatcher(["transfer(address,uint256)", "renounceOwnership()"]);
    const after = dispatcher([
      "transfer(address,uint256)",
      "mint(address,uint256)",
      "blacklist(address,bool)",
    ]);
    expect(functionDiff(before, after)).toEqual({
      added: ["blacklist(address,bool)", "mint(address,uint256)"],
      addedUnknown: 0,
      removed: ["renounceOwnership()"],
      removedUnknown: 0,
    });
  });
});

describe("Creator Watch snippet", () => {
  it("subscribes to creator_launched only, with a working curl", () => {
    const s = watchSnippet("0x636dd2c0299601df246efbfefcd67f12c9e57d08");
    expect(s).toContain("--wallets --events creator_launched");
    expect(s).toContain('"events":["creator_launched"]');
    expect(s).toContain("webhooks \\\n");
  });
});
