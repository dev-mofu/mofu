import { describe, expect, it } from "vitest";
import { ArgsError, HELP, parseArgs } from "../src/args.js";
import {
  apiBase,
  failsToken,
  failsWallet,
  formatTokenReport,
  formatWalletReport,
} from "../src/chain.js";

const TOKEN = "0xF76593C1C321C2A2F77775025E9677999CE7EA8C";
const WALLET = "0x30d81c4695eddceb53bea0480c6183d24773a98e";
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex

describe("parseArgs: chain commands", () => {
  it("parses scan and wallet with --json and --fail-on", () => {
    expect(parseArgs(["scan", TOKEN])).toEqual({
      command: "scan",
      address: TOKEN.toLowerCase(),
      json: false,
    });
    expect(parseArgs(["wallet", WALLET, "--json", "--fail-on", "risky"])).toEqual({
      command: "wallet",
      address: WALLET,
      json: true,
      failOn: "risky",
    });
    expect(parseArgs(["scan", "--fail-on=caution", TOKEN])).toMatchObject({ failOn: "caution" });
  });

  it("rejects bad chain arguments", () => {
    expect(() => parseArgs(["scan"])).toThrow(ArgsError);
    expect(() => parseArgs(["scan", "0x123"])).toThrow(/40 hex/);
    expect(() => parseArgs(["scan", TOKEN, "--fail-on", "maybe"])).toThrow(/caution or risky/);
    expect(() => parseArgs(["wallet", WALLET, "--nope"])).toThrow(/Unknown option/);
  });

  it("parses the webhook subcommands", () => {
    expect(
      parseArgs([
        "webhook",
        "add",
        "https://bot.example.com/h",
        TOKEN,
        "--events",
        "owner_changed,verdict_changed",
      ]),
    ).toEqual({
      command: "webhook",
      sub: "add",
      json: false,
      url: "https://bot.example.com/h",
      tokens: [TOKEN.toLowerCase()],
      events: ["owner_changed", "verdict_changed"],
    });
    const id = `wh_${"a".repeat(24)}`;
    expect(parseArgs(["webhook", "status", id, "--secret", "whsec_x"])).toEqual({
      command: "webhook",
      sub: "status",
      json: false,
      id,
      secret: "whsec_x",
    });
    expect(parseArgs(["webhook", "remove", id])).toMatchObject({ sub: "remove", id });
    expect(() => parseArgs(["webhook", "add", "http://x.example.com", TOKEN])).toThrow(ArgsError);
    expect(() => parseArgs(["webhook", "add", "https://x.example.com"])).toThrow(ArgsError);
    expect(() => parseArgs(["webhook", "status", "wh_1"])).toThrow(/webhook id/);
    expect(() => parseArgs(["webhook", "nope"])).toThrow(ArgsError);
  });

  it("lists the new commands in --help", () => {
    expect(HELP).toContain("mofu scan <token>");
    expect(HELP).toContain("mofu wallet <address>");
    expect(HELP).toContain("mofu webhook add");
  });
});

describe("chain output", () => {
  const report = {
    address: TOKEN.toLowerCase(),
    isContract: true,
    token: { name: "Mofu", symbol: "MOFU", totalSupply: "1000000000" },
    owner: { status: "none" as const, address: null },
    checks: [
      { id: "mint", label: "Mint", status: "ok" as const, detail: "No mint function found." },
      { id: "fees", label: "Fees", status: "warn" as const, detail: "The owner can change fees." },
    ],
    verdict: "caution" as const,
    sellTest: {
      status: "passed" as const,
      buyTaxPercent: 0,
      sellTaxPercent: 0,
      roundTripPercent: 94.86,
    },
    lookalikes: [{ address: WALLET, symbol: "MOFU" }],
    limits: [],
  };

  it("prints the verdict, each check, the sell test and the report link", () => {
    const text = strip(formatTokenReport(report, "https://mofu.works/token/x").join("\n"));
    expect(text).toContain("$MOFU  Mofu");
    expect(text).toContain("Verdict: CAUTION");
    expect(text).toContain("✓ Mint");
    expect(text).toContain("! Fees");
    expect(text).toContain("Sell test: passed · buy tax 0% · sell tax 0% · 94.86% of the ETH back");
    // With the server's "Can you sell it?" check, the summary isn't repeated.
    const withCheck = {
      ...report,
      checks: [
        ...report.checks,
        { id: "sell", label: "Can you sell it?", status: "ok" as const, detail: "Yes." },
      ],
    };
    expect(strip(formatTokenReport(withCheck, "u").join("\n"))).not.toContain("Sell test:");
    expect(text).toContain("1 other token(s)");
    expect(text).toContain("https://mofu.works/token/x");
    const wallet = strip(formatTokenReport({ ...report, isContract: false }, "u").join("\n"));
    expect(wallet).toContain("mofu wallet");
  });

  it("fails only when asked, at the chosen level", () => {
    expect(failsToken(report, undefined)).toBe(false);
    expect(failsToken(report, "risky")).toBe(false);
    expect(failsToken(report, "caution")).toBe(true);
    expect(failsToken({ ...report, verdict: "risky" }, "risky")).toBe(true);
    expect(failsToken({ ...report, verdict: "risky", isContract: false }, "risky")).toBe(false);
  });

  const wallet = {
    address: WALLET,
    isContract: false,
    eth: "0.12",
    holdings: [{ token: TOKEN, name: "Mofu", symbol: "MOFU", balance: "1,000" }],
    holdingsTotal: 1,
    approvals: [
      {
        token: TOKEN,
        tokenName: "Mofu",
        tokenSymbol: "MOFU",
        spender: { address: "0x" + "b".repeat(40), kind: "wallet", label: null },
        unlimited: true,
        allowance: "unlimited",
        risk: "warn" as const,
        reasons: ["Unlimited allowance."],
      },
    ],
    limits: [],
  };

  it("prints approvals with the spender and the revoke link", () => {
    const text = strip(formatWalletReport(wallet, "https://mofu.works/app/?scan=x").join("\n"));
    expect(text).toContain("Approvals: 1 · risky 0 · unlimited 1");
    expect(text).toContain("WARN  $MOFU");
    expect(text).toContain("0xbbbb…bbbb (wallet)");
    expect(text).toContain("Unlimited allowance.");
    expect(text).toContain("$MOFU          1,000");
    expect(text).toContain("Revoke approvals in your browser");
    expect(failsWallet(wallet, "risky")).toBe(false);
    expect(failsWallet(wallet, "caution")).toBe(true);
  });

  it("talks to mofu.works unless told otherwise, over https only", () => {
    expect(apiBase({})).toBe("https://mofu.works");
    expect(apiBase({ MOFU_API_URL: "http://localhost:5173/" })).toBe("http://localhost:5173");
    expect(() => apiBase({ MOFU_API_URL: "http://evil.example.com" })).toThrow();
  });
});
