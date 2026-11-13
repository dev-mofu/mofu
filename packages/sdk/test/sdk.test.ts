import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decide,
  Mofu,
  MofuError,
  parseWebhook,
  verifyWebhook,
  type TokenReport,
} from "../src/index.js";

const TOKEN = "0xf76593c1c321c2a2f77775025e9677999ce7ea8c";
const report: TokenReport = {
  address: TOKEN,
  chainName: "Robinhood Chain",
  isContract: true,
  codeSize: 3248,
  token: { name: "Mofu", symbol: "MOFU", decimals: 18, totalSupply: "1000000000" },
  owner: { status: "none", address: null, holdsPercent: null },
  proxy: { kind: "none", implementation: null },
  burnedPercent: 0,
  checks: [{ id: "mint", label: "Can new tokens be created?", status: "ok", detail: "No." }],
  verdict: "clean",
  distribution: { status: "summary", top10Percent: 20, largestWallet: null, holders: [] },
  sellTest: {
    status: "passed",
    method: "curve",
    venue: "0xc2347eda73ddcbc7a1ce29ff140fd6a62d0cf460",
    buyTaxPercent: 0,
    sellTaxPercent: 0,
    roundTripPercent: 94.86,
    depth: { method: "simulated", ethAt10Percent: 0.26, moreThan: false, steps: [], detail: "" },
    detail: "Yes.",
  },
  lookalikes: [],
  fingerprint: "28".repeat(16),
  codeMatch: null,
  limits: [],
};

function client(answer: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer(url, init);
  }) as unknown as typeof fetch;
  return { mofu: new Mofu({ fetch: fetchFn, userAgent: "test-agent" }), calls };
}

describe("Mofu client", () => {
  it("scans a token and checks a wallet", async () => {
    const { mofu, calls } = client((url) =>
      Response.json({
        report: url.includes("/token/") ? report : { approvals: [] },
        url: "u",
        remaining: 49,
        limit: 50,
      }),
    );
    const r = await mofu.scanToken(TOKEN.toUpperCase().replace("0X", "0x"));
    expect(r.report.verdict).toBe("clean");
    expect(r.remaining).toBe(49);
    expect(calls[0]!.url).toBe(`https://mofu.works/api/v1/token/${TOKEN}`);
    expect((calls[0]!.init.headers as Record<string, string>)["User-Agent"]).toBe("test-agent");
    await mofu.checkWallet(TOKEN);
    expect(calls[1]!.url).toContain("/api/v1/wallet/");
  });

  it("turns API errors and network failures into MofuError", async () => {
    const limited = client(() =>
      Response.json({ error: { code: "daily_limit", message: "used up" } }, { status: 429 }),
    );
    const err = await limited.mofu.scanToken(TOKEN).catch((e) => e);
    expect(err).toBeInstanceOf(MofuError);
    expect(err).toMatchObject({ status: 429, code: "daily_limit", message: "used up" });
    const down = client(() => {
      throw new TypeError("offline");
    });
    expect(await down.mofu.scanToken(TOKEN).catch((e) => e.code)).toBe("network");
    expect(() => down.mofu.scanToken("0x12")).toThrow(MofuError);
  });

  it("manages webhooks with the secret as a bearer token", async () => {
    const { mofu, calls } = client((url, init) => {
      if (init.method === "POST" && url.endsWith("/webhooks"))
        return Response.json({ webhook: { id: "wh_1" }, secret: "whsec_s" }, { status: 201 });
      if (init.method === "DELETE") return Response.json({ deleted: true });
      if (url.endsWith("/test")) return Response.json({ delivered: true, result: "200" });
      return Response.json({ webhook: { id: "wh_1", status: "active" } });
    });
    const created = await mofu.webhooks.create({
      url: "https://bot.example.com/h",
      tokens: [TOKEN],
      events: ["owner_changed"],
    });
    expect(created.secret).toBe("whsec_s");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      url: "https://bot.example.com/h",
      tokens: [TOKEN],
      events: ["owner_changed"],
    });
    expect((await mofu.webhooks.get("wh_1", "whsec_s")).status).toBe("active");
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe("Bearer whsec_s");
    expect(await mofu.webhooks.test("wh_1", "whsec_s")).toEqual({ delivered: true, result: "200" });
    await mofu.webhooks.remove("wh_1", "whsec_s");
    expect(calls[3]!.init.method).toBe("DELETE");
  });

  it("says no when Mofu can't be reached", async () => {
    const down = client(() => {
      throw new TypeError("offline");
    });
    const d = await down.mofu.checkBeforeBuy(TOKEN);
    expect(d.allowed).toBe(false);
    expect(d.reasons[0]).toMatch(/no answer from Mofu/);
  });
});

describe("decide", () => {
  it("allows a clean token and blocks on verdicts, failed sells, taxes and depth", () => {
    expect(decide(report).allowed).toBe(true);
    expect(decide({ ...report, verdict: "risky" }).reasons).toContain("Mofu's verdict is risky");
    expect(
      decide({ ...report, sellTest: { ...report.sellTest!, status: "failed" } }).reasons[0],
    ).toMatch(/honeypot/);
    expect(decide({ ...report, sellTest: null }).allowed).toBe(false);
    expect(
      decide({ ...report, sellTest: { ...report.sellTest!, sellTaxPercent: 20 } }).reasons,
    ).toEqual(["sell tax 20% is over 10%"]);
    expect(decide(report, { minSellDepthEth: 0.1 }).allowed).toBe(true);
    expect(decide(report, { minSellDepthEth: 1 }).reasons[0]).toMatch(
      /a 1 ETH sale would move the price more than 10%/,
    );
    const seen = {
      ...report,
      checks: [
        {
          id: "fingerprint",
          label: "Seen this code before?",
          status: "risk" as const,
          detail: "Yes.",
        },
      ],
    };
    expect(decide(seen).reasons).toContain("Seen this code before? Yes.");
  });
});

describe("webhook signatures", () => {
  const body = JSON.stringify({ id: "evt_1", type: "owner_changed", webhook: "wh_1" });
  const sign = (t: number, secret = "whsec_k") =>
    `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  const now = 1_800_000_000_000;

  it("accepts a fresh, correct signature only", async () => {
    const t = now / 1000;
    expect(await verifyWebhook(sign(t), body, "whsec_k", { now })).toBe(true);
    expect(await verifyWebhook(sign(t, "whsec_x"), body, "whsec_k", { now })).toBe(false);
    expect(await verifyWebhook(sign(t - 400), body, "whsec_k", { now })).toBe(false);
    expect(await verifyWebhook(sign(t), body + " ", "whsec_k", { now })).toBe(false);
    expect(await verifyWebhook(null, body, "whsec_k", { now })).toBe(false);
    expect((await parseWebhook(sign(t), body, "whsec_k", { now })).type).toBe("owner_changed");
    await expect(parseWebhook("t=1,v1=00", body, "whsec_k", { now })).rejects.toMatchObject({
      code: "bad_signature",
    });
  });
});

describe("on-chain verdicts", () => {
  const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, "0");
  const result = `0x${word(3)}${word(1 | 4)}${word(1_800_000_000)}${"282e8b47cfc27b4ba0328b0b37e99100".padEnd(64, "0")}`;

  it("decodes verdictOf", async () => {
    const { decodeOnchainVerdict } = await import("../src/index.js");
    const v = decodeOnchainVerdict(result, "0xreg");
    expect(v).toMatchObject({ verdict: "risky", fingerprint: "282e8b47cfc27b4ba0328b0b37e99100" });
    expect(v.flags).toMatchObject({ sellFailed: true, canMint: true, honeypotCode: false });
    expect(v.scannedAt?.getTime()).toBe(1_800_000_000_000);
    const empty = decodeOnchainVerdict(`0x${word(0).repeat(4)}`, "0xreg");
    expect(empty).toMatchObject({ verdict: null, scannedAt: null, fingerprint: null });
  });

  it("finds the registry on mofu.works, then reads the chain", async () => {
    const { mofu, calls } = client((url, init) => {
      if (url.endsWith("/api/v1/onchain"))
        return Response.json({ registry: "0x5fbdb2315678afecb367f032d93f642f64180aa3" });
      const body = JSON.parse(String(init.body));
      expect(body.params[0].data).toBe(`0x371ad2ae${TOKEN.slice(2).padStart(64, "0")}`);
      return Response.json({ jsonrpc: "2.0", id: 1, result });
    });
    const v = await mofu.onchainVerdict(TOKEN);
    expect(v.verdict).toBe("risky");
    expect(calls[1]!.url).toBe("https://robinhood-rpc.publicnode.com");
    const off = client(() => Response.json({ registry: null }));
    await expect(off.mofu.onchainVerdict(TOKEN)).rejects.toMatchObject({ code: "not_published" });
  });
});
