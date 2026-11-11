import { beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/worker/app.js";
import { clearBalanceCache, HOLDER_COOKIE } from "../src/worker/holder.js";
import { createSessionToken, createSignedToken, SESSION_COOKIE } from "../src/worker/session.js";
import { evaluateUsage, type UsageState } from "../src/worker/usage.js";
import { ROUND, type Votes } from "../src/worker/vote.js";
import type { ApiError, VoteResponse } from "../src/shared/api.js";

const SECRET = "s".repeat(40);
const NOW = Date.UTC(2026, 10, 12, 12);
const TOKEN = "0xf76593c1c321c2a2f77775025e9677999ce7ea8c";
const RPC = "https://rpc.example";
const ONE = 10n ** 18n;
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const env = {
  SESSION_SECRET: SECRET,
  HOLDER_TOKEN: TOKEN,
  HOLDER_RPC_URL: RPC,
  HOLDER_DECIMALS: "18",
  HOLDER_MIN_TOKENS: "1000000",
  HOLDER_DAILY_LIMIT: "30",
  FREE_DAILY_LIMIT: "10",
} as unknown as Env;

function setup(balances: Map<string, bigint>) {
  const store = new Map<string, string>();
  const votes: Votes = {
    async cast(round, address, option) {
      store.set(`${round}:${address}`, option);
    },
    async mine(round, address) {
      return store.get(`${round}:${address}`) ?? null;
    },
    async all(round) {
      return [...store]
        .filter(([k]) => k.startsWith(`${round}:`))
        .map(([k, option]) => ({ address: k.split(":")[1]!, option }));
    },
  };
  const states = new Map<string, UsageState>();
  const deps: AppDeps = {
    createModel: () => {
      throw new Error("no model");
    },
    verifyTurnstile: async () => true,
    getLimiter: () => ({
      async check(key, limit, consume, bucket = "messages") {
        const k = `${key}:${bucket}`;
        const { state, result } = evaluateUsage(states.get(k), NOW, limit, consume);
        if (consume && result.allowed) states.set(k, state);
        return result;
      },
    }),
    fetch: (async (_url: string, init?: RequestInit) => {
      const { params } = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      const who = `0x${params[0].data.slice(-40)}`;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: `0x${(balances.get(who) ?? 0n).toString(16).padStart(64, "0")}`,
      });
    }) as unknown as typeof fetch,
    now: () => NOW,
    getVotes: () => votes,
  };
  return { app: createApp(deps), store };
}

const cookies = async (wallet?: string) => {
  const parts = [`${SESSION_COOKIE}=${(await createSessionToken(SECRET, NOW, 60_000)).token}`];
  if (wallet)
    parts.push(
      `${HOLDER_COOKIE}=${await createSignedToken(SECRET, "holder", { a: wallet }, NOW, 60_000)}`,
    );
  return parts.join("; ");
};
const get = async (app: ReturnType<typeof createApp>, wallet?: string) =>
  (await (
    await app.request(
      "http://localhost/api/vote",
      { headers: { Cookie: await cookies(wallet) } },
      env,
    )
  ).json()) as VoteResponse;
const post = async (app: ReturnType<typeof createApp>, option: string, wallet?: string) =>
  app.request(
    "http://localhost/api/vote",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await cookies(wallet) },
      body: JSON.stringify({ option }),
    },
    env,
  );

beforeEach(() => clearBalanceCache());

describe("holder roadmap vote", () => {
  it("shows results to everyone but only lets holders vote", async () => {
    const { app } = setup(new Map([[A, 2_000_000n * ONE]]));
    const anon = await get(app);
    expect(anon.round.options.length).toBe(ROUND.options.length);
    expect(anon.canVote).toBe(false);
    const res = await post(app, "approvals");
    expect(res.status).toBe(403);
    expect(((await res.json()) as ApiError).code).toBe("holder_only");
    expect((await get(app, A)).canVote).toBe(true);
  });

  it("weights votes by balance and lets a holder change their vote", async () => {
    const { app } = setup(
      new Map([
        [A, 3_000_000n * ONE],
        [B, 1_000_000n * ONE],
      ]),
    );
    await post(app, "approvals", A);
    const r = (await (await post(app, "multiplayer", B)).json()) as VoteResponse;
    expect(r.mine).toBe("multiplayer");
    expect(r.results.find((x) => x.id === "approvals")).toMatchObject({
      voters: 1,
      weight: "3000000",
      percent: 75,
    });
    expect(r.totalWeight).toBe("4000000");
    const changed = (await (await post(app, "multiplayer", A)).json()) as VoteResponse;
    expect(changed.results.find((x) => x.id === "multiplayer")).toMatchObject({
      voters: 2,
      weight: "4000000",
      percent: 100,
    });
  });

  it("drops votes from wallets that no longer hold enough", async () => {
    const balances = new Map([
      [A, 1_000_000n * ONE],
      [B, 1_000_000n * ONE],
    ]);
    const { app } = setup(balances);
    await post(app, "telegram", A);
    // A sends its tokens to B, and B votes too: A's vote no longer counts.
    balances.set(B, 2_000_000n * ONE);
    balances.set(A, 0n);
    clearBalanceCache();
    const r = (await (await post(app, "telegram", B)).json()) as VoteResponse;
    expect(r.results.find((x) => x.id === "telegram")).toMatchObject({
      voters: 1,
      weight: "2000000",
    });
  });

  it("rejects unknown options and needs a session", async () => {
    const { app } = setup(new Map([[A, 2_000_000n * ONE]]));
    expect((await post(app, "moon", A)).status).toBe(400);
    const noSession = await app.request(
      "http://localhost/api/vote",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ option: "approvals" }),
      },
      env,
    );
    expect(noSession.status).toBe(401);
  });
});
