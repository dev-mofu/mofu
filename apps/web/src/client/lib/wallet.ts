/**
 * Browser wallet (MetaMask, Rabby, Coinbase Wallet, a wallet app's built-in browser…) through
 * the standard EIP-1193 provider. Only two calls are used: read the account and sign a message.
 * Nothing here can send a transaction or approve a contract.
 */
import type { HolderStatus } from "../../shared/api.js";
import { holderChallenge, holderVerify } from "./api.js";

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export class WalletError extends Error {
  constructor(
    readonly kind: "no-wallet" | "rejected" | "failed",
    message: string,
  ) {
    super(message);
  }
}

export function injectedWallet(): Eip1193Provider | null {
  const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  return eth && typeof eth.request === "function" ? eth : null;
}

const toHex = (text: string) =>
  `0x${Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("")}`;

function walletError(err: unknown): WalletError {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 4001 || code === "ACTION_REJECTED") {
    return new WalletError("rejected", "You cancelled the request in your wallet.");
  }
  return new WalletError("failed", "Your wallet couldn't complete the request. Please try again.");
}

/** Asks the wallet for its address and a signature, then lets the server check the balance. */
export async function connectHolderWallet(): Promise<HolderStatus> {
  const eth = injectedWallet();
  if (!eth) throw new WalletError("no-wallet", "No wallet found in this browser.");
  let address: string;
  try {
    const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
    if (!accounts?.[0]) throw new Error("no account");
    address = accounts[0];
  } catch (err) {
    throw walletError(err);
  }
  const { message, challenge } = await holderChallenge(address);
  let signature: string;
  try {
    signature = (await eth.request({
      method: "personal_sign",
      params: [toHex(message), address],
    })) as string;
  } catch (err) {
    throw walletError(err);
  }
  return holderVerify(challenge, signature);
}

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export const formatTokens = (whole: string) => BigInt(whole).toLocaleString("en-US");
