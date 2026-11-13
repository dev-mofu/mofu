/**
 * On-chain verdicts: Mofu publishes Token Scanner verdicts to its MofuVerdicts registry on
 * Robinhood Chain, so wallets, DEXs and bots can read them with one eth_call. Only changed
 * verdicts are written, in batches, by a dedicated writer key (a Cloudflare secret).
 *
 * Plain functions here: packing, ABI encoding, RLP and EIP-1559 signing (noble), sending.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { TokenScanReport } from "../shared/api.js";
import { rpcCall } from "./chain.js";

export const ROBINHOOD_CHAIN_ID = 4663;
export const VERDICT_CODE = { clean: 1, caution: 2, risky: 3 } as const;
export const FLAG = {
  sellFailed: 1,
  honeypotCode: 2,
  canMint: 4,
  canPause: 8,
  canBlock: 16,
  upgradeable: 32,
  fakeMofu: 64,
} as const;

export interface VerdictEntry {
  token: string;
  verdict: 1 | 2 | 3;
  flags: number;
  /** Unix seconds. */
  scannedAt: number;
  /** 32 hex characters, or null. */
  fingerprint: string | null;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (h: string) => {
  const s = h.replace(/^0x/, "");
  const out = new Uint8Array(s.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** What a report says, as the registry stores it. */
export function entryFromReport(r: TokenScanReport, now: number): VerdictEntry {
  const status = (id: string) => r.checks.find((c) => c.id === id)?.status;
  const flagged = (id: string) => {
    const s = status(id);
    return s === "risk" || s === "warn";
  };
  let flags = 0;
  if (r.sellTest?.status === "failed") flags |= FLAG.sellFailed;
  if (status("fingerprint") === "risk" || status("fingerprint") === "warn")
    flags |= FLAG.honeypotCode;
  if (flagged("mint")) flags |= FLAG.canMint;
  if (flagged("pause")) flags |= FLAG.canPause;
  if (flagged("blacklist")) flags |= FLAG.canBlock;
  if (flagged("upgrade")) flags |= FLAG.upgradeable;
  if (status("lookalike") === "risk") flags |= FLAG.fakeMofu;
  return {
    token: r.address.toLowerCase(),
    verdict: VERDICT_CODE[r.verdict],
    flags,
    scannedAt: Math.floor(now / 1000),
    fingerprint: r.fingerprint ?? null,
  };
}

/** verdict | flags << 8 | scannedAt << 16 | fingerprint << 56, as in MofuVerdicts.sol. */
export function packVerdict(e: VerdictEntry): bigint {
  const fp =
    e.fingerprint && /^[0-9a-f]{32}$/.test(e.fingerprint) ? BigInt(`0x${e.fingerprint}`) : 0n;
  return (
    BigInt(e.verdict) | (BigInt(e.flags & 0xff) << 8n) | (BigInt(e.scannedAt) << 16n) | (fp << 56n)
  );
}

/** The part that matters for "did it change": everything but the scan time. */
export const verdictKey = (e: VerdictEntry) => `${e.verdict}:${e.flags}:${e.fingerprint ?? ""}`;

const word = (v: bigint) => v.toString(16).padStart(64, "0");
const SET_VERDICTS = hex(
  keccak_256(new TextEncoder().encode("setVerdicts(address[],uint256[])")),
).slice(0, 8);

/** Calldata for setVerdicts(address[] tokens, uint256[] packed). */
export function encodeSetVerdicts(entries: VerdictEntry[]): string {
  const n = BigInt(entries.length);
  const tokens = entries.map((e) => word(BigInt(e.token))).join("");
  const packed = entries.map((e) => word(packVerdict(e))).join("");
  // two dynamic arrays: head (2 offsets), then each array as length + items
  const offsetA = 64n;
  const offsetB = offsetA + 32n + 32n * n;
  return `0x${SET_VERDICTS}${word(offsetA)}${word(offsetB)}${word(n)}${tokens}${word(n)}${packed}`;
}

// ---------------------------------------------------------------- RLP and EIP-1559

type Rlp = Uint8Array | Rlp[];

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const lengthBytes = (n: number) => {
  const h = n.toString(16);
  return bytes(h.length % 2 ? `0${h}` : h);
};
export function rlp(item: Rlp): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0]! < 0x80) return item;
    if (item.length <= 55) return concat([Uint8Array.of(0x80 + item.length), item]);
    const len = lengthBytes(item.length);
    return concat([Uint8Array.of(0xb7 + len.length), len, item]);
  }
  const body = concat(item.map(rlp));
  if (body.length <= 55) return concat([Uint8Array.of(0xc0 + body.length), body]);
  const len = lengthBytes(body.length);
  return concat([Uint8Array.of(0xf7 + len.length), len, body]);
}
/** A quantity in RLP: big-endian, no leading zeros, zero is empty. */
const qty = (v: bigint) =>
  v === 0n
    ? new Uint8Array(0)
    : bytes(v.toString(16).length % 2 ? `0${v.toString(16)}` : v.toString(16));

export interface Eip1559Tx {
  chainId: number;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gas: bigint;
  to: string;
  value: bigint;
  data: string;
}

const fields = (t: Eip1559Tx): Rlp[] => [
  qty(BigInt(t.chainId)),
  qty(t.nonce),
  qty(t.maxPriorityFeePerGas),
  qty(t.maxFeePerGas),
  qty(t.gas),
  bytes(t.to),
  qty(t.value),
  bytes(t.data),
  [],
];

export function addressOf(privateKey: string): string {
  const pub = secp256k1.getPublicKey(bytes(privateKey), false);
  return `0x${hex(keccak_256(pub.subarray(1)).subarray(12))}`;
}

/** The signed transaction, ready for eth_sendRawTransaction. */
export function signEip1559(t: Eip1559Tx, privateKey: string): string {
  const unsigned = concat([Uint8Array.of(2), rlp(fields(t))]);
  const hash = keccak_256(unsigned);
  // "recovered" format: [recovery, r(32), s(32)]
  const sig = secp256k1.sign(hash, bytes(privateKey), { prehash: false, format: "recovered" });
  const recovery = sig[0]!;
  const r = BigInt(`0x${hex(sig.subarray(1, 33))}`);
  const s = BigInt(`0x${hex(sig.subarray(33, 65))}`);
  const signed = concat([
    Uint8Array.of(2),
    rlp([...fields(t), qty(BigInt(recovery)), qty(r), qty(s)]),
  ]);
  return `0x${hex(signed)}`;
}

export interface PublishOptions {
  rpcUrls: readonly string[];
  fetch: typeof fetch;
  contract: string;
  privateKey: string;
  chainId?: number;
}

/** Sends one setVerdicts transaction for the batch. Returns its hash. */
export async function publishBatch(o: PublishOptions, entries: VerdictEntry[]): Promise<string> {
  if (entries.length === 0) throw new Error("nothing to publish");
  const from = addressOf(o.privateKey);
  const data = encodeSetVerdicts(entries);
  const call = (method: string, params: unknown[]) =>
    rpcCall<string>(o.rpcUrls, method, params, o.fetch);
  const [nonce, estimate, block, tip] = await Promise.all([
    call("eth_getTransactionCount", [from, "pending"]),
    call("eth_estimateGas", [{ from, to: o.contract, data }]),
    rpcCall<{ baseFeePerGas?: string }>(
      o.rpcUrls,
      "eth_getBlockByNumber",
      ["latest", false],
      o.fetch,
    ),
    call("eth_maxPriorityFeePerGas", []).catch(() => "0x0"),
  ]);
  const baseFee = BigInt(block.baseFeePerGas ?? "0x0");
  const priority = BigInt(tip);
  const raw = signEip1559(
    {
      chainId: o.chainId ?? ROBINHOOD_CHAIN_ID,
      nonce: BigInt(nonce),
      maxPriorityFeePerGas: priority,
      maxFeePerGas: baseFee * 2n + priority,
      gas: (BigInt(estimate) * 12n) / 10n,
      to: o.contract,
      value: 0n,
      data,
    },
    o.privateKey,
  );
  return call("eth_sendRawTransaction", [raw]);
}
