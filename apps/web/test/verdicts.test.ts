import { afterEach, describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { TokenScanReport } from "../src/shared/api.js";
import { VerdictPublisher } from "../src/worker/verdict-store.js";
import {
  addressOf,
  encodeSetVerdicts,
  entryFromReport,
  FLAG,
  packVerdict,
  rlp,
  signEip1559,
  verdictKey,
  type VerdictEntry,
} from "../src/worker/verdicts.js";

// Anvil's public test key #1: never holds anything real.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const WRITER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const REGISTRY = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const TOKEN = "0xf76593c1c321c2a2f77775025e9677999ce7ea8c";
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (h: string) =>
  Uint8Array.from(
    h
      .replace(/^0x/, "")
      .match(/../g)!
      .map((x) => Number.parseInt(x, 16)),
  );

/** Decodes one RLP list (enough for a transaction): items are byte strings or nested lists. */
function decodeList(b: Uint8Array): Array<Uint8Array | unknown[]> {
  const read = (at: number): [Uint8Array | unknown[], number] => {
    const p = b[at]!;
    const len = (n: number, from: number) =>
      b.subarray(from, from + n).reduce((a, x) => a * 256 + x, 0);
    if (p < 0x80) return [b.subarray(at, at + 1), at + 1];
    if (p <= 0xb7) return [b.subarray(at + 1, at + 1 + p - 0x80), at + 1 + p - 0x80];
    if (p <= 0xbf) {
      const n = len(p - 0xb7, at + 1);
      const s = at + 1 + (p - 0xb7);
      return [b.subarray(s, s + n), s + n];
    }
    const [s, n] = p <= 0xf7 ? [at + 1, p - 0xc0] : [at + 1 + (p - 0xf7), len(p - 0xf7, at + 1)];
    const out: unknown[] = [];
    let i = s;
    while (i < s + n) {
      const [item, next] = read(i);
      out.push(item);
      i = next;
    }
    return [out, s + n];
  };
  return read(0)[0] as Array<Uint8Array | unknown[]>;
}

const entry = (over: Partial<VerdictEntry> = {}): VerdictEntry => ({
  token: TOKEN,
  verdict: 1,
  flags: 0,
  scannedAt: 1_800_000_000,
  fingerprint: "282e8b47cfc27b4ba0328b0b37e99100",
  ...over,
});

describe("packing and encoding", () => {
  it("packs like MofuVerdicts.sol", () => {
    const p = packVerdict(entry({ verdict: 3, flags: 7 }));
    expect(p & 0xffn).toBe(3n);
    expect((p >> 8n) & 0xffn).toBe(7n);
    expect((p >> 16n) & 0xff_ffff_ffffn).toBe(1_800_000_000n);
    expect((p >> 56n).toString(16)).toBe("282e8b47cfc27b4ba0328b0b37e99100");
    expect(packVerdict(entry({ fingerprint: null })) >> 56n).toBe(0n);
  });

  it("encodes setVerdicts(address[],uint256[])", () => {
    const data = encodeSetVerdicts([entry(), entry({ token: "0x" + "11".repeat(20), verdict: 3 })]);
    const selector = hex(
      keccak_256(new TextEncoder().encode("setVerdicts(address[],uint256[])")),
    ).slice(0, 8);
    expect(data.slice(2, 10)).toBe(selector);
    // head: offsets 0x40 and 0x40 + 32 + 2*32 = 0xa0, then length 2
    expect(data.slice(10, 74)).toBe("40".padStart(64, "0"));
    expect(data.slice(74, 138)).toBe("a0".padStart(64, "0"));
    expect(data.slice(138, 202)).toBe("2".padStart(64, "0"));
    expect((data.length - 10) / 64).toBe(2 + 1 + 2 + 1 + 2);
  });

  it("follows the RLP rules", () => {
    expect(hex(rlp(Uint8Array.of(0x7f)))).toBe("7f");
    expect(hex(rlp(Uint8Array.of(0x80)))).toBe("8180");
    expect(hex(rlp(new Uint8Array(0)))).toBe("80");
    expect(hex(rlp([]))).toBe("c0");
    expect(hex(rlp(new TextEncoder().encode("dog")))).toBe("83646f67");
    expect(hex(rlp([new TextEncoder().encode("cat"), new TextEncoder().encode("dog")]))).toBe(
      "c88363617483646f67",
    );
    expect(hex(rlp(new Uint8Array(56))).slice(0, 4)).toBe("b838");
  });

  it("signs an EIP-1559 transaction that recovers to the writer", () => {
    expect(addressOf(KEY)).toBe(WRITER);
    const raw = signEip1559(
      {
        chainId: 4663,
        nonce: 5n,
        maxPriorityFeePerGas: 0n,
        maxFeePerGas: 20_000_000n,
        gas: 100_000n,
        to: REGISTRY,
        value: 0n,
        data: "0x1234",
      },
      KEY,
    );
    expect(raw.startsWith("0x02")).toBe(true);
    // Rebuild the signing hash and recover: signature fields are the last three list items.
    const unsigned =
      "02" +
      hex(
        rlp([
          Uint8Array.of(0x12, 0x37),
          Uint8Array.of(5),
          new Uint8Array(0),
          bytes("0x01312d00"),
          bytes("0x0186a0"),
          bytes(REGISTRY),
          new Uint8Array(0),
          bytes("0x1234"),
          [],
        ]),
      );
    const hash = keccak_256(bytes(unsigned));
    // Decode the signed list and take its last three items: yParity, r, s.
    const items = decodeList(bytes(raw).subarray(1));
    expect(items).toHaveLength(12);
    const [y, r, s] = items.slice(9) as Uint8Array[];
    const pad32 = (b: Uint8Array) => new Uint8Array([...new Uint8Array(32 - b.length), ...b]);
    const sig = new Uint8Array([y!.length ? y![0]! : 0, ...pad32(r!), ...pad32(s!)]);
    const pub = secp256k1.recoverPublicKey(sig, hash, { prehash: false });
    const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false);
    expect(`0x${hex(keccak_256(uncompressed.subarray(1)).subarray(12))}`).toBe(WRITER);
  });
});

describe("what a report publishes", () => {
  it("turns checks into flags", () => {
    const r = {
      address: TOKEN.toUpperCase().replace("0X", "0x"),
      isContract: true,
      verdict: "risky",
      fingerprint: "ab".repeat(16),
      sellTest: { status: "failed" },
      checks: [
        { id: "mint", status: "risk" },
        { id: "pause", status: "ok" },
        { id: "blacklist", status: "warn" },
        { id: "upgrade", status: "ok" },
        { id: "fingerprint", status: "risk" },
        { id: "lookalike", status: "info" },
      ],
    } as unknown as TokenScanReport;
    const e = entryFromReport(r, 1_800_000_000_500);
    expect(e).toEqual({
      token: TOKEN,
      verdict: 3,
      flags: FLAG.sellFailed | FLAG.honeypotCode | FLAG.canMint | FLAG.canBlock,
      scannedAt: 1_800_000_000,
      fingerprint: "ab".repeat(16),
    });
    expect(verdictKey(e)).toBe(verdictKey({ ...e, scannedAt: 1 }));
  });
});

describe("VerdictPublisher", () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup(envOver: Record<string, string> = {}) {
    const data = new Map<string, unknown>();
    let alarm: number | null = null;
    const storage = {
      async get(k: string) {
        return structuredClone(data.get(k));
      },
      async put(k: string | Record<string, unknown>, v?: unknown) {
        if (typeof k === "string") data.set(k, structuredClone(v));
        else for (const [a, b] of Object.entries(k)) data.set(a, structuredClone(b));
      },
      async delete(k: string | string[]) {
        for (const x of Array.isArray(k) ? k : [k]) data.delete(x);
        return true;
      },
      async list({ prefix, limit }: { prefix: string; limit?: number }) {
        return new Map(
          [...data.entries()].filter(([k]) => k.startsWith(prefix)).slice(0, limit ?? 1e9),
        );
      },
      async getAlarm() {
        return alarm;
      },
      async setAlarm(at: number) {
        alarm = at;
      },
    };
    const sent: string[] = [];
    let fail = false;
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      const { method, params, id } = JSON.parse(String(init?.body));
      if (fail)
        return Response.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "insufficient funds for gas" },
        });
      const result =
        method === "eth_getTransactionCount"
          ? "0x3"
          : method === "eth_estimateGas"
            ? "0x186a0"
            : method === "eth_getBlockByNumber"
              ? { baseFeePerGas: "0x989680" }
              : method === "eth_maxPriorityFeePerGas"
                ? "0x0"
                : method === "eth_sendRawTransaction"
                  ? (sent.push(params[0]), "0x" + "ab".repeat(32))
                  : null;
      return Response.json({ jsonrpc: "2.0", id, result });
    });
    const env = {
      HOLDER_RPC_URL: "https://rpc.example",
      VERDICTS_CONTRACT: REGISTRY,
      VERDICT_SIGNER_KEY: KEY,
      VERDICT_DAILY_TXS: "2",
      ...envOver,
    } as unknown as Env;
    const pub = new VerdictPublisher({ storage } as unknown as DurableObjectState, env);
    return { pub, data, sent, setFail: (v: boolean) => (fail = v), alarmAt: () => alarm };
  }

  it("queues changed verdicts and publishes them in one transaction", async () => {
    const { pub, data, sent, alarmAt } = setup();
    await pub.note(entry());
    await pub.note(entry({ token: "0x" + "22".repeat(20), verdict: 3, flags: 1 }));
    expect(alarmAt()).not.toBeNull();
    expect((await pub.status()).pending).toBe(2);
    await pub.alarm();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.startsWith("0x02")).toBe(true);
    const s = await pub.status();
    expect(s).toMatchObject({
      enabled: true,
      contract: REGISTRY,
      writer: WRITER,
      pending: 0,
      publishedToday: 1,
    });
    expect(s.last?.hash).toBe("0x" + "ab".repeat(32));
    expect(data.get(`published:${TOKEN}`)).toBe(verdictKey(entry()));
    // the same verdict again isn't queued; a changed one is
    await pub.note(entry({ scannedAt: 1_900_000_000 }));
    expect((await pub.status()).pending).toBe(0);
    await pub.note(entry({ verdict: 2 }));
    expect((await pub.status()).pending).toBe(1);
  });

  it("keeps the queue and retries when sending fails, and stops at the daily limit", async () => {
    const { pub, sent, setFail } = setup({ VERDICT_DAILY_TXS: "1" });
    await pub.note(entry());
    setFail(true);
    await pub.alarm();
    let s = await pub.status();
    expect(s.pending).toBe(1);
    expect(s.last?.error).toContain("insufficient funds");
    setFail(false);
    await pub.alarm();
    expect(sent).toHaveLength(1);
    await pub.note(entry({ verdict: 3 }));
    await pub.alarm();
    s = await pub.status();
    expect(sent).toHaveLength(1); // daily limit of 1 reached
    expect(s.pending).toBe(1);
  });

  it("does nothing until the registry and key are configured", async () => {
    const { pub } = setup({ VERDICTS_CONTRACT: "" });
    await pub.note(entry());
    expect(await pub.status()).toMatchObject({ enabled: false, pending: 0, writer: null });
  });
});

describe("signer key from the secret", () => {
  it("takes the one 64-hex value, even from the whole cast wallet new output", async () => {
    const { signerKeyFrom } = await import("../src/worker/verdict-store.js");
    const body = "ab".repeat(32);
    expect(signerKeyFrom(`0x${body}`)).toBe(`0x${body}`);
    expect(signerKeyFrom(body.toUpperCase())).toBe(`0x${body}`);
    const pasted = `Successfully created new keypair.\nAddress:     0x${"cd".repeat(20)}\nPrivate key: 0x${body}\n`;
    expect(signerKeyFrom(pasted)).toBe(`0x${body}`);
    expect(signerKeyFrom(`0x${body} 0x${"ef".repeat(32)}`)).toBeNull();
    expect(signerKeyFrom("hello")).toBeNull();
    expect(signerKeyFrom(`0x${body}ff`)).toBeNull();
  });
});
