import { createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebhookStore } from "../src/worker/webhook-store.js";

const RPC = "https://rpc.example";
const TOKEN = "0x1111111111111111111111111111111111111111";
const OWNER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HOOK_URL = "https://hooks.example.com/mofu";

const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
const abiString = (s: string) => {
  const hex = Buffer.from(s).toString("hex");
  return `0x${word(32n).slice(2)}${word(BigInt(Buffer.byteLength(s))).slice(2)}${hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")}`;
};

/** In-memory Durable Object storage: the calls WebhookStore makes. */
function fakeState() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const clone = <T>(v: T): T => structuredClone(v);
  const storage = {
    async get(key: string | string[]) {
      if (Array.isArray(key)) {
        const out = new Map<string, unknown>();
        for (const k of key) if (data.has(k)) out.set(k, clone(data.get(k)));
        return out;
      }
      return clone(data.get(key));
    },
    async put(key: string | Record<string, unknown>, value?: unknown) {
      if (typeof key === "string") data.set(key, clone(value));
      else for (const [k, v] of Object.entries(key)) data.set(k, clone(v));
    },
    async delete(key: string | string[]) {
      for (const k of Array.isArray(key) ? key : [key]) data.delete(k);
      return true;
    },
    async list({ prefix }: { prefix: string }) {
      return new Map(
        [...data.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, clone(v)]),
      );
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(at: number) {
      alarm = at;
    },
  };
  return { state: { storage } as unknown as DurableObjectState, data, alarmAt: () => alarm };
}

describe("WebhookStore", () => {
  afterEach(() => vi.unstubAllGlobals());

  function world() {
    const chain = { owner: OWNER_A, receiver: 200 };
    const deliveries: Array<{ headers: Headers; body: string }> = [];
    const answer = (c: { method: string; params: [{ to: string; data: string } & string] }) => {
      if (c.method === "eth_getCode") return "0x6080604052600436106100";
      if (c.method === "eth_getStorageAt") return word(0n);
      if (c.method === "eth_call") {
        const sel = String(c.params[0].data).slice(0, 10);
        return (
          {
            "0x06fdde03": abiString("Test Token"),
            "0x95d89b41": abiString("TST"),
            "0x313ce567": word(18n),
            "0x18160ddd": word(1_000_000n * 10n ** 18n),
            "0x8da5cb5b": word(BigInt(chain.owner)),
            "0x5c975abb": word(0n),
          } as Record<string, string>
        )[sel];
      }
      return undefined;
    };
    vi.stubGlobal("fetch", async (u: string, init?: RequestInit) => {
      if (String(u) === HOOK_URL) {
        deliveries.push({ headers: new Headers(init?.headers), body: String(init?.body) });
        return new Response("ok", { status: chain.receiver });
      }
      const body = JSON.parse(String(init?.body));
      const one = (c: {
        id?: number;
        method: string;
        params: [{ to: string; data: string } & string];
      }) => {
        const r = answer(c);
        return r === undefined
          ? { jsonrpc: "2.0", id: c.id ?? 1, error: { code: 3, message: "execution reverted" } }
          : { jsonrpc: "2.0", id: c.id ?? 1, result: r };
      };
      return Response.json(Array.isArray(body) ? body.map(one) : one(body));
    });
    const fake = fakeState();
    const store = new WebhookStore(fake.state, { HOLDER_RPC_URL: RPC } as unknown as Env);
    return { chain, deliveries, store, ...fake };
  }

  const create = (store: WebhookStore, id: string, events: string[]) =>
    store.create({
      id,
      url: HOOK_URL,
      secret: `whsec_${id}`,
      tokens: [{ address: TOKEN, name: "Test Token", symbol: "TST" }],
      events: events as never,
      now: Date.now(),
    });

  it("sets a baseline first, then sends a signed event only to hooks that asked for it", async () => {
    const w = world();
    const a = `wh_${"a".repeat(24)}`;
    const b = `wh_${"b".repeat(24)}`;
    await create(w.store, a, ["owner_changed"]);
    await create(w.store, b, ["supply_changed"]);
    expect(w.alarmAt()).not.toBeNull();

    await w.store.alarm(); // full scan + baseline read
    expect(w.deliveries).toHaveLength(0);
    const status = await w.store.get(a, `whsec_${a}`);
    expect(status!.watching![0]).toMatchObject({ address: TOKEN, symbol: "TST" });
    expect(status!.watching![0]!.lastChecked).not.toBeNull();
    expect(status!.watching![0]!.verdict).not.toBeNull();

    w.chain.owner = OWNER_B;
    await w.store.alarm();
    expect(w.deliveries).toHaveLength(1);
    const d = w.deliveries[0]!;
    const event = JSON.parse(d.body);
    expect(event).toMatchObject({
      type: "owner_changed",
      webhook: a,
      before: OWNER_A,
      after: OWNER_B,
      token: { address: TOKEN, symbol: "TST" },
      report: `https://mofu.works/token/${TOKEN}`,
    });
    const [t, v1] = d.headers
      .get("Mofu-Signature")!
      .split(",")
      .map((p) => p.split("=")[1]);
    expect(v1).toBe(createHmac("sha256", `whsec_${a}`).update(`${t}.${d.body}`).digest("hex"));
    expect((await w.store.get(a, `whsec_${a}`))!.delivered).toBe(1);

    // Nothing changed: nothing sent.
    await w.store.alarm();
    expect(w.deliveries).toHaveLength(1);
  });

  it("checks the secret, switches a failing hook off and back on, and forgets unwatched tokens", async () => {
    const w = world();
    const a = `wh_${"c".repeat(24)}`;
    await create(w.store, a, ["owner_changed"]);
    expect(await w.store.get(a, "whsec_wrong")).toBeNull();
    expect(await w.store.remove(a, "whsec_wrong")).toBe(false);

    w.chain.receiver = 500;
    for (let i = 0; i < 20; i++) await w.store.test(a, `whsec_${a}`, Date.now());
    let s = await w.store.get(a, `whsec_${a}`);
    expect(s).toMatchObject({ status: "disabled", failures: 20, lastResult: "500" });
    w.chain.receiver = 200;
    expect(await w.store.test(a, `whsec_${a}`, Date.now())).toEqual({ ok: true, result: "200" });
    s = await w.store.get(a, `whsec_${a}`);
    expect(s).toMatchObject({ status: "active", failures: 0 });

    expect(w.data.has(`watch:${TOKEN}`)).toBe(true);
    expect(await w.store.remove(a, `whsec_${a}`)).toBe(true);
    expect(w.data.has(`watch:${TOKEN}`)).toBe(false);
  });

  it("refuses a fourth hook for the same URL", async () => {
    const w = world();
    for (const c of "def")
      expect(await create(w.store, `wh_${c.repeat(24)}`, ["upgraded"])).toHaveProperty("hook");
    expect(await create(w.store, `wh_${"0".repeat(24)}`, ["upgraded"])).toHaveProperty("error");
  });
});
