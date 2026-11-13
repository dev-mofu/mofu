import { describe, expect, it } from "vitest";
import type { DeployerToken, TokenScanReport } from "../src/shared/api.js";
import { recentTransactions, type TxItem } from "../src/worker/chain-data.js";
import { deployerReputation } from "../src/worker/deployer.js";
import { launchActivity, launchWindow, withLaunchChecks } from "../src/worker/launch.js";
import type { CreatorEntry, LaunchCache, TokenIndex } from "../src/worker/stats.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const CURVE = "0xc2347eda73ddcbc7a1ce29ff140fd6a62d0cf460";
const ROUTER = "0x9247529247529247529247529247529247529247";
const CREATOR = "0x636dd2c0299601df246efbfefcd67f12c9e57d08";
const ZERO = "0x0000000000000000000000000000000000000000";
const RPC = "https://rpc.example";
const SUPPLY = 10n ** 27n; // 1,000,000,000 tokens with 18 decimals
const U = 10n ** 18n;
const w = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const A = w(0xa1),
  B = w(0xb2),
  C = w(0xc3),
  D = w(0xd4),
  FUNDER = w(0xf0);

const T0 = Date.parse("2026-11-11T16:35:09Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const xfer = (from: string, to: string, tokens: bigint) => ({
  sender_address: TOKEN,
  decoded: {
    name: "Transfer",
    params: [
      { name: "from", value: from },
      { name: "to", value: to },
      { name: "value", value: (tokens * U).toString() },
    ],
  },
});
const tx = (s: number, block: number, from: string, events: ReturnType<typeof xfer>[]): TxItem => ({
  block_signed_at: at(s),
  block_height: block,
  tx_offset: 0,
  from_address: from,
  log_events: events,
});

/** The token's first transactions: launch with a dev buy, snipers, a router buy, a late buy. */
const LAUNCH: TxItem[] = [
  tx(0, 100, CREATOR, [xfer(ZERO, CURVE, 1_000_000_000n), xfer(CURVE, CREATOR, 5_000_000n)]),
  tx(1, 108, A, [xfer(CURVE, A, 50_000_000n)]),
  tx(1, 108, B, [xfer(CURVE, B, 20_000_000n)]),
  // Bought through a router that forwards: only the final wallet counts.
  tx(12, 220, C, [xfer(CURVE, ROUTER, 30_000_000n), xfer(ROUTER, C, 30_000_000n)]),
  // The creator buys for another wallet.
  tx(20, 300, CREATOR, [xfer(CURVE, D, 40_000_000n)]),
  // A sell back to the curve: not a buy.
  tx(30, 400, A, [xfer(A, CURVE, 10_000_000n)]),
  // After the window.
  tx(75, 900, w(0xee), [xfer(CURVE, w(0xee), 1_000_000n)]),
];

describe("launchWindow", () => {
  it("finds the buyers, nets out routers, keeps the creator apart and stops after a minute", () => {
    const c = launchWindow(TOKEN, LAUNCH, CURVE, CREATOR)!;
    expect(c.windowSeconds).toBe(60);
    expect(c.creatorBought).toBe((5_000_000n * U).toString());
    expect(c.sameBlock).toBe(2);
    expect(c.buyers.map((b) => b.address)).toEqual([A, B, C, D]);
    expect(c.buyers.find((b) => b.address === D)!.sender).toBe(CREATOR);
    expect(c.buyers.find((b) => b.address === A)!.bought).toBe((50_000_000n * U).toString());
  });

  it("works out the venue when it isn't known", () => {
    const c = launchWindow(TOKEN, LAUNCH, null, CREATOR)!;
    expect(c.buyers.map((b) => b.address)).toEqual([A, B, C, D]);
  });
});

const cacheWith = (funders: Record<string, string | null>): LaunchCache => {
  const c = launchWindow(TOKEN, LAUNCH, CURVE, CREATOR)!;
  for (const b of c.buyers) if (b.address in funders) b.funder = funders[b.address];
  return c;
};
const holding = (m: Record<string, bigint>) =>
  new Map(Object.entries(m).map(([a, n]) => [a, n * U] as const));

describe("launchActivity", () => {
  it("is risky when wallets tied to the creator still hold a big share", () => {
    const c = cacheWith({ [A]: null, [B]: CREATOR });
    const l = launchActivity(
      c,
      holding({ [A]: 0n, [B]: 20_000_000n, [C]: 0n, [D]: 40_000_000n }),
      SUPPLY,
      CREATOR,
      new Map(),
    );
    expect(l.status).toBe("risk");
    expect(l.groups[0]).toMatchObject({ kind: "creator", holdPercent: 6 });
    expect(l.groups[0]!.wallets.sort()).toEqual([B, D].sort());
    expect(l.detail).toMatch(/^Yes\. 2 wallets funded or bought for by the creator/);
    expect(l.snipers).toBe(2);
  });

  it("ties wallets with the same funder, unless the funder is a busy service", () => {
    const c = cacheWith({ [A]: FUNDER, [B]: FUNDER, [C]: FUNDER });
    const holds = holding({ [A]: 30_000_000n, [B]: 20_000_000n, [C]: 30_000_000n, [D]: 0n });
    const person = launchActivity(c, holds, SUPPLY, CREATOR, new Map([[FUNDER, 12]]));
    expect(person.status).toBe("warn");
    expect(person.groups[0]).toMatchObject({ kind: "funder", via: FUNDER, holdPercent: 8 });
    const exchange = launchActivity(c, holds, SUPPLY, CREATOR, new Map([[FUNDER, 250_000]]));
    expect(exchange.groups.some((g) => g.kind === "funder")).toBe(false);
  });

  it("says plainly when the early buyers are gone", () => {
    const c = launchWindow(TOKEN, LAUNCH.slice(0, 4), CURVE, CREATOR)!;
    const l = launchActivity(c, holding({ [A]: 0n, [B]: 0n, [C]: 0n }), SUPPLY, CREATOR, new Map());
    expect(l.status).toBe("ok");
    expect(l.detail).toBe(
      "No sign of it. 3 wallets bought in the first 60 seconds (2 within 3 seconds, almost always bots), taking 10% of the supply; all of it has been sold since. The creator bought 0.5% at launch.",
    );
  });
});

const report = (over: Partial<TokenScanReport> = {}): TokenScanReport => ({
  address: TOKEN,
  chainName: "Robinhood Chain",
  isContract: true,
  codeSize: 4000,
  token: { name: "Test", symbol: "TST", decimals: 18, totalSupply: "1000000000" },
  owner: { status: "renounced", address: ZERO, holdsPercent: null },
  proxy: { kind: "none", implementation: null },
  burnedPercent: 0,
  checks: [{ id: "mint", label: "Can new tokens be created?", status: "ok", detail: "No." }],
  verdict: "clean",
  distribution: { status: "summary", top10Percent: 20, largestWallet: null, holders: [] },
  origin: {
    creator: CREATOR,
    launcher: null,
    creationTx: "0xabc",
    createdAt: at(0),
    creatorFirstSeen: at(0),
    creatorAgeDays: 0,
    creatorTxCount: 3,
    creatorHolds: "0",
    creatorHoldsPercent: 0,
    otherLaunches: [],
    otherLaunchCount: 0,
    otherLaunchDetails: [],
  },
  sellTest: null,
  lookalikes: [],
  fingerprint: null,
  codeMatch: null,
  limits: [],
  ...over,
});
const tok = (n: number, over: Partial<DeployerToken> = {}): DeployerToken => ({
  address: w(0x500 + n),
  symbol: `T${n}`,
  verdict: "clean",
  honeypot: false,
  ...over,
});

describe("deployerReputation", () => {
  it("flags a creator whose other token was a honeypot", () => {
    const d = deployerReputation(report(), [tok(1), tok(2, { honeypot: true, verdict: "risky" })])!;
    expect(d.status).toBe("risk");
    expect(d.honeypots).toBe(1);
    expect(d.tokens[0]!.address).toBe(w(0x502));
    expect(d.detail).toMatch(/where Mofu's simulated sell failed/);
  });

  it("warns about serial launchers and leaves a first launch alone", () => {
    const serial = report();
    serial.origin!.otherLaunchCount = 13;
    expect(deployerReputation(serial, [])!.status).toBe("warn");
    const first = deployerReputation(report(), [])!;
    expect(first.status).toBe("ok");
    expect(first.detail).toBe(
      "No other launches by 0x636d…7d08 found in its recent history. The wallet was first active the same day.",
    );
  });

  it("ignores the token itself", () => {
    const d = deployerReputation(report(), [{ ...tok(0), address: TOKEN, honeypot: true }])!;
    expect(d.status).toBe("ok");
    expect(d.launches).toBe(0);
  });
});

/** RPC stand-in: every buyer is a plain wallet; balances from the map. */
function rpcFake(balances: Record<string, bigint>, gr: Record<string, unknown>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url === RPC) {
      const one = (c: { method: string; params: unknown[] }, id: number) => {
        if (c.method === "eth_getCode") return { jsonrpc: "2.0", id, result: "0x" };
        const data = (c.params[0] as { data: string }).data;
        const who = `0x${data.slice(-40)}`;
        return {
          jsonrpc: "2.0",
          id,
          result: `0x${((balances[who] ?? 0n) * U).toString(16).padStart(64, "0")}`,
        };
      };
      const body = JSON.parse(String(init?.body)) as unknown;
      return Response.json(
        Array.isArray(body)
          ? body.map((c, i) => one(c as { method: string; params: unknown[] }, i))
          : one(body as { method: string; params: unknown[] }, 1),
      );
    }
    const path = url.replace("https://api.covalenthq.com/v1/robinhood-mainnet/", "");
    const data = gr[path];
    return data
      ? Response.json({ data, error: false })
      : Response.json({ data: null, error: true, error_message: "Not found" }, { status: 404 });
  }) as unknown as typeof fetch;
}

describe("withLaunchChecks", () => {
  it("adds both checks, files the token under its creator and keeps the window", async () => {
    const noted: CreatorEntry[] = [];
    const saved = new Map<string, LaunchCache>();
    const index: TokenIndex = {
      noteToken: async () => undefined,
      tokens: async () => [],
      rememberTokens: async () => undefined,
      similar: async () => [],
      noteCreator: async (_c, e) => void noted.push(e),
      creatorTokens: async () => [tok(1, { honeypot: true, verdict: "risky" })],
      launchCache: async (t) => saved.get(t) ?? null,
      saveLaunch: async (t, c) => void saved.set(t, c),
    };
    const fundedBy = (funder: string) => ({
      items: [{ to_address: "", from_address: funder, value: "1000000000000000" }],
    });
    const gr = {
      [`address/${TOKEN}/transactions_v3/page/0/`]: { items: LAUNCH },
      [`address/${B}/transactions_v3/page/0/?no-logs=true`]: {
        items: [{ ...fundedBy(CREATOR).items[0], to_address: B }],
      },
      [`address/${D}/transactions_v3/page/0/?no-logs=true`]: {
        items: [{ ...fundedBy(FUNDER).items[0], to_address: D }],
      },
    };
    const f = rpcFake({ [B]: 20_000_000n, [D]: 40_000_000n }, gr);
    const data = { apiKey: "k", chain: "robinhood-mainnet", rpcUrls: [RPC], fetch: f };
    const out = await withLaunchChecks(report(), index, data, T0 + 3_600_000);

    expect(out.checks.map((c) => c.id)).toEqual(["mint", "deployer", "bundle"]);
    expect(out.verdict).toBe("risky");
    expect(out.deployer?.honeypots).toBe(1);
    expect(out.launch?.groups[0]).toMatchObject({ kind: "creator", holdPercent: 6 });
    // Filed with the verdict from before these checks.
    expect(noted).toEqual([
      expect.objectContaining({ address: TOKEN, verdict: "clean", honeypot: false }),
    ]);
    expect(saved.get(TOKEN)?.buyers.find((b) => b.address === B)?.funder).toBe(CREATOR);

    // A second scan reuses the window: no GoldRush call for the buyers.
    const noGoldRush = rpcFake({ [B]: 20_000_000n, [D]: 40_000_000n }, {});
    const again = await withLaunchChecks(
      report(),
      index,
      { ...data, fetch: noGoldRush },
      T0 + 7_200_000,
    );
    expect(again.launch?.status).toBe("risk");
  });

  it("does nothing for a wallet address", async () => {
    const r = report({ isContract: false });
    expect(await withLaunchChecks(r, null, undefined)).toBe(r);
  });
});

describe("recentTransactions", () => {
  it("reads the latest page and the one before it when the latest is short", async () => {
    const f = rpcFake(
      {},
      {
        [`address/${A}/transactions_v3/`]: {
          current_page: 5,
          items: [{ block_height: 50, tx_hash: "0x5" }],
        },
        [`address/${A}/transactions_v3/page/4/`]: {
          current_page: 4,
          items: [
            { block_height: 40, tx_hash: "0x4" },
            { block_height: 45, tx_hash: "0x45" },
          ],
        },
      },
    );
    const txs = await recentTransactions(
      { apiKey: "k", chain: "robinhood-mainnet", rpcUrls: [RPC], fetch: f },
      A,
    );
    expect(txs.map((t) => t.tx_hash)).toEqual(["0x5", "0x45", "0x4"]);
  });
});
