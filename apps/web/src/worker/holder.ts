/**
 * $MOFU holder perks: a wallet proves it's yours by signing a plain message (EIP-191
 * personal_sign; no transaction, no gas), then its token balance is read from Robinhood Chain.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ethCall, parseRpcUrls } from "./chain.js";

export const HOLDER_COOKIE = "mofu_holder";
/** How long a wallet stays connected before it has to sign again. */
export const HOLDER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a signing challenge stays valid. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Balances are cached briefly per Worker instance so a busy chat doesn't hammer the RPC. */
const BALANCE_CACHE_MS = 60 * 1000;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

export const isAddress = (value: unknown): value is string =>
  typeof value === "string" && ADDRESS_PATTERN.test(value);

export interface HolderConfig {
  token: string;
  /** Tried in order until one answers. */
  rpcUrls: string[];
  decimals: number;
  /** Minimum balance in whole tokens. */
  minTokens: bigint;
  dailyLimit: number;
}

export function holderConfig(env: Env): HolderConfig | null {
  const token = String(env.HOLDER_TOKEN ?? "");
  const rpcUrls = parseRpcUrls(env.HOLDER_RPC_URL);
  const decimals = Number.parseInt(String(env.HOLDER_DECIMALS), 10);
  const dailyLimit = Number.parseInt(String(env.HOLDER_DAILY_LIMIT), 10);
  let minTokens: bigint;
  try {
    minTokens = BigInt(String(env.HOLDER_MIN_TOKENS));
  } catch {
    return null;
  }
  if (!isAddress(token) || rpcUrls.length === 0) return null;
  if (!(decimals >= 0 && decimals <= 36) || !(dailyLimit > 0) || minTokens <= 0n) return null;
  return { token, rpcUrls, decimals, minTokens, dailyLimit };
}

/** The exact text the wallet shows and signs. Rebuilt on the server from the signed challenge. */
export function challengeMessage(host: string, address: string, nonce: string): string {
  return [
    `${host} wants you to confirm you own this wallet.`,
    "",
    "Signing only proves ownership to unlock $MOFU holder perks. It is not a transaction, costs no gas and gives no one access to your funds.",
    "",
    `Wallet: ${address.toLowerCase()}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}

export function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** EIP-191 hash of a personal_sign message. */
export function personalMessageHash(message: string): Uint8Array {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const all = new Uint8Array(prefix.length + body.length);
  all.set(prefix);
  all.set(body, prefix.length);
  return keccak_256(all);
}

/** Address (lowercase 0x…) that signed `message`, or null if the signature is malformed. */
export function recoverSigner(message: string, signature: string): string | null {
  if (!SIGNATURE_PATTERN.test(signature)) return null;
  const sig = hexToBytes(signature);
  let v = sig[64]!;
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return null;
  // noble's "recovered" format puts the recovery bit first: [v, r(32), s(32)].
  const recovered = new Uint8Array(65);
  recovered[0] = v;
  recovered.set(sig.subarray(0, 64), 1);
  try {
    const compressed = secp256k1.recoverPublicKey(recovered, personalMessageHash(message), {
      prehash: false,
    });
    const uncompressed = secp256k1.Point.fromBytes(compressed).toBytes(false);
    return `0x${bytesToHex(keccak_256(uncompressed.subarray(1)).subarray(12))}`;
  } catch {
    return null;
  }
}

const balanceCache = new Map<string, { value: bigint; at: number }>();

/** ERC-20 balanceOf(address) through a plain JSON-RPC eth_call. */
export async function readTokenBalance(
  cfg: HolderConfig,
  address: string,
  fetchFn: typeof fetch,
  now: number,
): Promise<bigint> {
  const key = `${cfg.token}:${address.toLowerCase()}`;
  const hit = balanceCache.get(key);
  if (hit && now - hit.at < BALANCE_CACHE_MS) return hit.value;
  const data = `0x70a08231${address.toLowerCase().slice(2).padStart(64, "0")}`;
  const result = await ethCall(cfg.rpcUrls, cfg.token, data, fetchFn);
  if (!/^0x[0-9a-fA-F]*$/.test(result)) throw new Error("RPC returned no result");
  const value = result === "0x" ? 0n : BigInt(result);
  balanceCache.set(key, { value, at: now });
  if (balanceCache.size > 5_000) balanceCache.clear();
  return value;
}

export const minUnits = (cfg: HolderConfig) => cfg.minTokens * 10n ** BigInt(cfg.decimals);

/** Whole tokens, rounded down, as a plain string (safe for JSON). */
export const wholeTokens = (cfg: HolderConfig, units: bigint) =>
  (units / 10n ** BigInt(cfg.decimals)).toString();

/** Only for tests: forget cached balances. */
export function clearBalanceCache(): void {
  balanceCache.clear();
}
