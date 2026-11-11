import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { simulateReadableStream, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppDeps, type Limiter } from "../src/worker/app.js";
import {
  challengeMessage,
  clearBalanceCache,
  HOLDER_COOKIE,
  personalMessageHash,
  recoverSigner,
} from "../src/worker/holder.js";
import { createSessionToken, createSignedToken, SESSION_COOKIE } from "../src/worker/session.js";
import { evaluateUsage, type UsageState } from "../src/worker/usage.js";
import type {
  ApiError,
  HolderChallengeResponse,
  HolderStatus,
  UsageInfo,
} from "../src/shared/api.js";

const SECRET = "s".repeat(40);
const NOW = Date.UTC(2026, 10, 12, 12);
const TOKEN = "0xf76593c1c321c2a2f77775025e9677999ce7ea8c";
const RPC = "https://rpc.example/robinhood";
const ONE = 10n ** 18n;

function env(): Env {
  return {
    DEFAULT_MODEL: "test/default",
    FREE_DAILY_LIMIT: "2",
    FREE_TIER_ENABLED: "true",
    TURNSTILE_SITE_KEY: "site-key",
    OPENROUTER_API_KEY: "sk-or-owner",
    TURNSTILE_SECRET_KEY: "turnstile-secret",
    SESSION_SECRET: SECRET,
    HOLDER_TOKEN: TOKEN,
    HOLDER_RPC_URL: RPC,
    HOLDER_DECIMALS: "18",
    HOLDER_MIN_TOKENS: "1000000",
    HOLDER_DAILY_LIMIT: "5",
  } as unknown as Env;
}

/** A wallet, signing the way MetaMask's personal_sign does: r || s || v (27/28). */
function wallet() {
  const { secretKey, publicKey } = secp256k1.keygen();
  const full = secp256k1.Point.fromBytes(publicKey).toBytes(false);
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const address = `0x${hex(keccak_256(full.subarray(1)).subarray(12))}`;
  const sign = (message: string) => {
    const rec = secp256k1.sign(personalMessageHash(message), secretKey, {
      prehash: false,
      format: "recovered",
    });
    return `0x${hex(rec.subarray(1))}${(rec[0]! + 27).toString(16)}`;
  };
  return { address, sign };
}

function mockModel(): LanguageModel {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "hi" },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  }) as unknown as LanguageModel;
}

function setup(balances: Map<string, bigint>, rpcDown = false) {
  const states = new Map<string, UsageState>();
  const limiter: Limiter = {
    async check(key, limit, consume, bucket = "messages") {
      const k = `${key}:${bucket}`;
      const { state, result } = evaluateUsage(states.get(k), NOW, limit, consume);
      if (consume && result.allowed) states.set(k, state);
      return result;
    },
  };
  const rpcCalls: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url !== RPC) return new Response("{}", { status: 404 });
    if (rpcDown) return new Response("down", { status: 503 });
    const body = JSON.parse(String(init?.body)) as { params: [{ to: string; data: string }] };
    expect(body.params[0].to).toBe(TOKEN);
    const holder = `0x${body.params[0].data.slice(-40)}`;
    rpcCalls.push(holder);
    const value = balances.get(holder) ?? 0n;
    return Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: `0x${value.toString(16).padStart(64, "0")}`,
    });
  }) as unknown as typeof fetch;
  const deps: AppDeps = {
    createModel: () => mockModel(),
    verifyTurnstile: async () => true,
    getLimiter: () => limiter,
    fetch: fetchFn,
    now: () => NOW,
  };
  return { app: createApp(deps), states, rpcCalls };
}

const session = async () =>
  `${SESSION_COOKIE}=${(await createSessionToken(SECRET, NOW, 60_000)).token}`;

async function post(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  cookie: string,
) {
  return app.request(
    `http://localhost/api${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "CF-Connecting-IP": "9.9.9.9",
      },
      body: JSON.stringify(body),
    },
    env(),
  );
}

/** Runs the full connect flow and returns the cookie header to use afterwards. */
async function connect(app: ReturnType<typeof createApp>, w: ReturnType<typeof wallet>) {
  const s = await session();
  const ch = (await (
    await post(app, "/holder/challenge", { address: w.address }, s)
  ).json()) as HolderChallengeResponse;
  const res = await post(
    app,
    "/holder/verify",
    { challenge: ch.challenge, signature: w.sign(ch.message) },
    s,
  );
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  const holder = /mofu_holder=([^;]+)/.exec(setCookie)?.[1];
  return { res, cookie: holder ? `${s}; ${HOLDER_COOKIE}=${holder}` : s, setCookie };
}

const chatBody = {
  messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
  mode: "general",
  memory: [],
};

beforeEach(() => clearBalanceCache());

describe("wallet signatures", () => {
  it("recovers the signer of a personal_sign message", () => {
    const w = wallet();
    const msg = challengeMessage("mofu.works", w.address, "abc");
    expect(recoverSigner(msg, w.sign(msg))).toBe(w.address);
    expect(recoverSigner(msg + "x", w.sign(msg))).not.toBe(w.address);
    expect(recoverSigner(msg, "0x1234")).toBeNull();
  });

  it("matches a known Ethereum personal_sign vector", () => {
    // Hardhat account #0 signing "hello"; checked against ethers' verifyMessage.
    const signature =
      "0xf16ea9a3478698f695fd1401bfe27e9e4a7e8e3da94aa72b021125e31fa899cc573c48ea3fe1d4ab61a9db10c19032026e3ed2dbccba5a178235ac27f94504311c";
    expect(recoverSigner("hello", signature)).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  });
});

describe("holder perks", () => {
  it("connects a wallet that holds enough and raises its daily limit", async () => {
    const w = wallet();
    const { app } = setup(new Map([[w.address, 1_500_000n * ONE]]));
    const { res, cookie, setCookie } = await connect(app, w);
    expect(res.status).toBe(200);
    expect((await res.json()) as HolderStatus).toEqual({
      address: w.address,
      balance: "1500000",
      eligible: true,
    });
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);

    const usage = (await (
      await app.request("http://localhost/api/usage", { headers: { Cookie: cookie } }, env())
    ).json()) as UsageInfo;
    expect(usage.limit).toBe(5);
    expect(usage.holder?.eligible).toBe(true);

    for (let i = 0; i < 5; i++)
      expect((await post(app, "/chat", chatBody, cookie)).status).toBe(200);
    const sixth = await post(app, "/chat", chatBody, cookie);
    expect(sixth.status).toBe(429);
    expect(((await sixth.json()) as ApiError).message).toContain("5 holder messages");
  });

  it("counts per wallet, not per IP", async () => {
    const w = wallet();
    const { app, states } = setup(new Map([[w.address, 1_000_000n * ONE]]));
    const { cookie } = await connect(app, w);
    await post(app, "/chat", chatBody, cookie);
    expect([...states.keys()]).toEqual([`holder:${w.address}:messages`]);
  });

  it("keeps the free limit for a wallet below the minimum", async () => {
    const w = wallet();
    const { app } = setup(new Map([[w.address, 999_999n * ONE]]));
    const { res, cookie } = await connect(app, w);
    expect(((await res.json()) as HolderStatus).eligible).toBe(false);
    const usage = (await (
      await app.request("http://localhost/api/usage", { headers: { Cookie: cookie } }, env())
    ).json()) as UsageInfo;
    expect(usage.limit).toBe(2);
  });

  it("falls back to the free limit when the RPC is down", async () => {
    const w = wallet();
    const { app } = setup(new Map(), true);
    const { res, cookie } = await connect(app, w);
    expect((await res.json()) as HolderStatus).toEqual({
      address: w.address,
      balance: null,
      eligible: false,
    });
    expect((await post(app, "/chat", chatBody, cookie)).status).toBe(200);
  });

  it("falls back to the next RPC when one is rate-limited", async () => {
    const w = wallet();
    const { app } = setup(new Map([[w.address, 1_000_000n * ONE]]));
    const e = { ...env(), HOLDER_RPC_URL: `https://limited.example/rpc, ${RPC}` } as unknown as Env;
    const s = await session();
    const req = (path: string, body: unknown, cookie: string) =>
      app.request(
        `http://localhost/api${path}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie },
          body: JSON.stringify(body),
        },
        e,
      );
    const ch = (await (
      await req("/holder/challenge", { address: w.address }, s)
    ).json()) as HolderChallengeResponse;
    const res = await req(
      "/holder/verify",
      { challenge: ch.challenge, signature: w.sign(ch.message) },
      s,
    );
    expect(((await res.json()) as HolderStatus).eligible).toBe(true);
  });

  it("rejects a signature from a different wallet", async () => {
    const owner = wallet();
    const other = wallet();
    const { app } = setup(new Map([[owner.address, 2_000_000n * ONE]]));
    const s = await session();
    const ch = (await (
      await post(app, "/holder/challenge", { address: owner.address }, s)
    ).json()) as HolderChallengeResponse;
    const res = await post(
      app,
      "/holder/verify",
      { challenge: ch.challenge, signature: other.sign(ch.message) },
      s,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("rejects expired or tampered challenges and needs a session", async () => {
    const w = wallet();
    const { app } = setup(new Map());
    expect((await post(app, "/holder/challenge", { address: w.address }, "")).status).toBe(401);
    const s = await session();
    expect((await post(app, "/holder/challenge", { address: "0x123" }, s)).status).toBe(400);
    const stale = await createSignedToken(
      SECRET,
      "holder-challenge",
      { a: w.address, n: "n", h: "localhost" },
      NOW - 10 * 60_000,
      5 * 60_000,
    );
    const msg = challengeMessage("localhost", w.address, "n");
    expect(
      (await post(app, "/holder/verify", { challenge: stale, signature: w.sign(msg) }, s)).status,
    ).toBe(400);
    // A holder cookie can't be used as a challenge (and vice versa): the purpose is signed.
    const wrongPurpose = await createSignedToken(
      SECRET,
      "holder",
      { a: w.address, n: "n", h: "localhost" },
      NOW,
      60_000,
    );
    expect(
      (await post(app, "/holder/verify", { challenge: wrongPurpose, signature: w.sign(msg) }, s))
        .status,
    ).toBe(400);
  });

  it("drops perks once the tokens leave the wallet", async () => {
    const w = wallet();
    const balances = new Map([[w.address, 1_000_000n * ONE]]);
    const { app } = setup(balances);
    const { cookie } = await connect(app, w);
    balances.set(w.address, 0n);
    clearBalanceCache();
    const usage = (await (
      await app.request("http://localhost/api/usage", { headers: { Cookie: cookie } }, env())
    ).json()) as UsageInfo;
    expect(usage.limit).toBe(2);
    expect(usage.holder?.eligible).toBe(false);
  });

  it("disconnects by clearing the cookie", async () => {
    const { app } = setup(new Map());
    const res = await post(app, "/holder/disconnect", {}, await session());
    expect(res.headers.get("Set-Cookie")).toMatch(/mofu_holder=;.*Max-Age=0/i);
  });
});
