import { beforeEach, describe, expect, it } from "vitest";
import { clearTownHoldersCache, townHolders } from "../src/worker/town-holders.js";

const TOKEN = "0xf76593c1c321c2a2f77775025e9677999ce7ea8c";
const RPC = "https://rpc.example";
const SUPPLY = "1000000000000000000000000000";
const POOL = "0xc2347eda73ddcbc7a1ce29ff140fd6a62d0cf460";
const WALLET = "0x30d81c4695eddceb53bea0480c6183d24773a98e";

function fetchFn(seen: string[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    seen.push(url);
    if (url.startsWith("https://api.covalenthq.com/")) {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer key");
      return Response.json({
        data: {
          items: [
            {
              address: WALLET,
              balance: "30893356086376932403691214",
              total_supply: SUPPLY,
              contract_decimals: 18,
            },
            {
              address: "0x000000000000000000000000000000000000dEaD",
              balance: "5764000000000000000000000",
              total_supply: SUPPLY,
              contract_decimals: 18,
            },
            {
              address: POOL,
              balance: "703767492818301760501624061",
              total_supply: SUPPLY,
              contract_decimals: 18,
            },
          ],
        },
      });
    }
    const { params } = JSON.parse(String(init?.body)) as { params: [string] };
    return Response.json({ jsonrpc: "2.0", id: 1, result: params[0] === POOL ? "0x6080" : "0x" });
  }) as unknown as typeof fetch;
}

beforeEach(() => clearTownHoldersCache());

describe("townHolders", () => {
  it("is unavailable without a key", async () => {
    expect(
      await townHolders({
        apiKey: undefined,
        chain: "robinhood-mainnet",
        token: TOKEN,
        rpcUrls: [RPC],
        fetch: fetchFn([]),
        now: 0,
      }),
    ).toEqual({ status: "unavailable" });
  });

  it("sorts holders, labels contracts and burns, and computes shares", async () => {
    const seen: string[] = [];
    const r = await townHolders({
      apiKey: "key",
      chain: "robinhood-mainnet",
      token: TOKEN,
      rpcUrls: [RPC],
      fetch: fetchFn(seen),
      now: 1,
    });
    expect(seen[0]).toBe(
      `https://api.covalenthq.com/v1/robinhood-mainnet/tokens/${TOKEN}/token_holders_v2/`,
    );
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.holders.map((h) => [h.address, h.kind, h.percent])).toEqual([
      [POOL, "contract", 70.3767],
      [WALLET, "wallet", 3.0893],
      ["0x000000000000000000000000000000000000dead", "burn", 0.5764],
    ]);
    expect(r.holders[0]!.balance).toBe("703767492");
  });
});
