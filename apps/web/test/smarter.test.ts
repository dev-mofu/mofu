import { describe, expect, it } from "vitest";
import type { CodeMatch, TokenScanReport } from "../src/shared/api.js";
import {
  codeFingerprint,
  codeOutcome,
  codeSkeleton,
  withCodeMatch,
} from "../src/worker/fingerprint.js";
import { curveDepth, depthDetail, poolDepth, TESTER } from "../src/worker/sell-test.js";
import type { CodeEntry, TokenIndex } from "../src/worker/stats.js";

const RPC = "https://rpc.example";
const TOKEN = "0x1111111111111111111111111111111111111111";
const CURVE = "0xc2347eda73ddcbc7a1ce29ff140fd6a62d0cf460";
const POOL = "0x2222222222222222222222222222222222222222";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;

describe("code fingerprint", () => {
  // PUSH20 <address> ... with CBOR metadata (a2 … 0033) at the end
  const body = (addr: string) => `0x6080604052${"73"}${addr.slice(2)}5b6000f3`;
  // {"ipfs": <34 bytes>, "solc": 0.8.20} followed by its length in two bytes
  const meta = (tag: string) => {
    const cbor = `a264697066735822${tag.repeat(34)}64736f6c6343000814`;
    return cbor + (cbor.length / 2).toString(16).padStart(4, "0");
  };

  it("ignores metadata and baked-in addresses, but not real code changes", async () => {
    const a = await codeFingerprint(body(TOKEN) + meta("ab"));
    const b = await codeFingerprint(body(POOL) + meta("cd"));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toBe(a);
    const other = await codeFingerprint(`0x6080604052600160025b6000f3`);
    expect(other).not.toBe(a);
    expect(await codeFingerprint("0x")).toBeNull();
    expect(await codeFingerprint(`0xef0100${TOKEN.slice(2)}`)).toBeNull();
  });

  it("walks over push data instead of reading it as opcodes", () => {
    // PUSH2 0x6060 then STOP: the 0x60s inside the push aren't pushes themselves
    const out = codeSkeleton(new Uint8Array([0x61, 0x60, 0x60, 0x00]));
    expect([...out]).toEqual([0x61, 0x60, 0x60, 0x00]);
    const zeroed = codeSkeleton(new Uint8Array([0x73, ...new Array(20).fill(0xaa), 0x00]));
    expect([...zeroed]).toEqual([0x73, ...new Array(20).fill(0), 0x00]);
  });
});

describe("Seen this code before?", () => {
  const report = (over: Partial<TokenScanReport> = {}): TokenScanReport =>
    ({
      address: TOKEN,
      isContract: true,
      token: { name: "Neko", symbol: "NEKO", decimals: 18, totalSupply: "1" },
      checks: [{ id: "mint", label: "Mint", status: "ok", detail: "none" }],
      verdict: "clean",
      sellTest: null,
      lookalikes: [],
      fingerprint: "ab".repeat(16),
      codeMatch: null,
      ...over,
    }) as TokenScanReport;
  const index = (match: CodeMatch) => {
    const noted: Array<[string, CodeEntry]> = [];
    const idx: TokenIndex = {
      noteToken: async () => {},
      tokens: async () => [],
      rememberTokens: async () => {},
      similar: async () => [],
      noteCode: async (fp, e) => void noted.push([fp, e]),
      codeMatches: async () => match,
    };
    return { idx, noted };
  };
  const failed = {
    status: "failed",
    method: "curve",
    venue: CURVE,
    buyTaxPercent: 0,
    sellTaxPercent: null,
    roundTripPercent: null,
    depth: null,
    detail: "",
  } as const;
  const passed = { ...failed, status: "passed", sellTaxPercent: 0 } as const;

  it("flags code shared with honeypots and turns the verdict risky", async () => {
    const { idx, noted } = index({
      flagged: 2,
      passed: 0,
      examples: [{ address: POOL, symbol: "MOONCAT" }],
    });
    const r = await withCodeMatch(report({ sellTest: { ...failed } }), idx);
    const check = r.checks.find((c) => c.id === "fingerprint")!;
    expect(check.status).toBe("risk");
    expect(check.detail).toContain(
      "matches 2 tokens where Mofu's simulated sell failed, for example $MOONCAT",
    );
    expect(r.verdict).toBe("risky");
    expect(r.codeMatch?.flagged).toBe(2);
    expect(noted).toEqual([
      ["ab".repeat(16), { address: TOKEN, symbol: "NEKO", outcome: "failed" }],
    ]);
  });

  it("only warns when this copy sold fine, and stays quiet for a common template", async () => {
    const warn = await withCodeMatch(
      report({ sellTest: { ...passed } }),
      index({ flagged: 1, passed: 0, examples: [] }).idx,
    );
    expect(warn.checks.find((c) => c.id === "fingerprint")?.status).toBe("warn");
    expect(warn.verdict).toBe("caution");
    const template = await withCodeMatch(
      report({ sellTest: { ...passed } }),
      index({ flagged: 1, passed: 40, examples: [] }).idx,
    );
    expect(template.checks.some((c) => c.id === "fingerprint")).toBe(false);
    expect(template.verdict).toBe("clean");
  });

  it("doesn't remember a token whose sell wasn't simulated", async () => {
    const { idx, noted } = index({ flagged: 0, passed: 0, examples: [] });
    const r = await withCodeMatch(report(), idx);
    expect(noted).toEqual([]);
    expect(r.codeMatch).toBeNull();
    expect(codeOutcome(report({ sellTest: { ...passed, sellTaxPercent: 60 } }))).toBe("failed");
    // no index: report untouched apart from codeMatch
    expect((await withCodeMatch(report(), null)).checks).toHaveLength(1);
  });
});

describe("sell depth", () => {
  /** A constant-product curve holding RT tokens and RE wei; TOKEN's balances live in slot 0. */
  const RT = 500_000_000n * 10n ** 18n;
  const RE = 2n * 10n ** 18n;
  const SUPPLY = 1_000_000_000n * 10n ** 18n;
  const MARK = 123_456_789n;
  const curveChain = (async (_u: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Array<{
      id: number;
      method: string;
      params: unknown[];
    }>;
    const answer = (c: { id: number; method: string; params: unknown[] }) => {
      if (c.method === "eth_call") {
        const [call, , overrides] = c.params as [
          { data: string },
          string,
          Record<string, { stateDiff: Record<string, string> }>?,
        ];
        if (call.data === "0x18160ddd") return { id: c.id, result: word(SUPPLY) };
        // only one of the probed keys is the real slot-0 key; accept the first probe (slot 0)
        const key = Object.keys(overrides?.[TOKEN]?.stateDiff ?? {})[0];
        return { id: c.id, result: key && c.id === 1 ? word(MARK) : word(0n) };
      }
      if (c.method === "eth_simulateV1") {
        const block = (
          c.params[0] as { blockStateCalls: Array<{ calls: Array<{ data: string }> }> }
        ).blockStateCalls[0]!;
        const amount = BigInt(`0x${block.calls[1]!.data.slice(10, 74)}`);
        const out = (amount * RE) / (RT + amount);
        const native = {
          address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          topics: [
            "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
            word(BigInt(CURVE)),
            word(BigInt(TESTER)),
          ],
          data: word(out),
        };
        return {
          id: c.id,
          result: [
            {
              calls: [
                { status: "0x1", logs: [] },
                { status: "0x1", logs: [native] },
              ],
            },
          ],
        };
      }
      return { id: c.id, error: { code: 3, message: "execution reverted" } };
    };
    return Response.json(body.map((c) => ({ jsonrpc: "2.0", ...answer(c) })));
  }) as unknown as typeof fetch;

  it("simulates growing sells on a curve and finds the 10% point", async () => {
    const d = (await curveDepth([RPC], curveChain, TOKEN, CURVE))!;
    expect(d.method).toBe("simulated");
    // x·y=k: a sale of s tokens moves the average price by s/(RT+s); 10% ≈ RT/9 ≈ 11% of supply
    const at5 = d.steps.find((s) => s.supplyPercent === 5)!;
    expect(at5.impactPercent).toBeGreaterThan(8);
    expect(at5.impactPercent).toBeLessThan(10);
    expect(d.steps.find((s) => s.supplyPercent === 10)!.impactPercent).toBeGreaterThan(10);
    const at10 = d.steps.find((s) => s.supplyPercent === 10)!;
    // interpolated between the 5% and 10%-of-supply sales
    expect(d.ethAt10Percent!).toBeGreaterThan(at5.ethOut);
    expect(d.ethAt10Percent!).toBeLessThan(at10.ethOut);
    expect(d.moreThan).toBe(false);
    expect(d.detail).toContain(`about ${d.ethAt10Percent} ETH moves the price 10%`);
  });

  it("gives up when the balance slot can't be found", async () => {
    const noSlot = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Array<{ id: number }>;
      return Response.json(
        body.map((c) => ({ jsonrpc: "2.0", id: c.id, result: word(c.id === 0 ? SUPPLY : 0n) })),
      );
    }) as unknown as typeof fetch;
    expect(await curveDepth([RPC], noSlot, TOKEN, CURVE)).toBeNull();
  });

  it("works out a WETH pool's depth from its reserves", async () => {
    const pool = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Array<{
        id: number;
        params: [{ data: string }];
      }>;
      const r = (data: string) =>
        data === "0x0dfe1681"
          ? word(BigInt(TOKEN))
          : data === "0xd21220a7"
            ? word(BigInt(WETH))
            : `${word(RT)}${word(RE).slice(2)}${word(0n).slice(2)}`;
      return Response.json(
        body.map((c) => ({ jsonrpc: "2.0", id: c.id, result: r(c.params[0].data) })),
      );
    }) as unknown as typeof fetch;
    const d = (await poolDepth([RPC], pool, TOKEN, POOL))!;
    expect(d.method).toBe("reserves");
    // a = RT·1000·10/(997·90) tokens returns about 0.1993 ETH of a 2 ETH pool
    expect(d.ethAt10Percent).toBeCloseTo(0.1999, 2);
    expect(d.detail).toContain("from the pool's reserves");
  });

  it("describes the edges", () => {
    expect(
      depthDetail({
        method: "simulated",
        ethAt10Percent: null,
        moreThan: false,
        steps: [],
        detail: "",
      }),
    ).toContain("even a small sale");
    expect(
      depthDetail({
        method: "simulated",
        ethAt10Percent: 4.2,
        moreThan: true,
        steps: [],
        detail: "",
      }),
    ).toContain("more than 4.2 ETH");
  });
});
