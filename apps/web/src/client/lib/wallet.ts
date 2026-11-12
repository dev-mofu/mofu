/**
 * Browser wallet (MetaMask, Rabby, Coinbase Wallet, a wallet app's built-in browser…) through
 * the standard EIP-1193 provider. Three things only: read the account, sign the holder message,
 * and send a revoke, approve(spender, 0), which removes a permission and can't move tokens.
 * Nothing here approves a contract or sends funds.
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

const CHAIN_ID = "0x1237"; // 4663, Robinhood Chain

/** The connected account, asking the wallet for access if needed. */
export async function walletAccount(): Promise<string> {
  const eth = injectedWallet();
  if (!eth) throw new WalletError("no-wallet", "No wallet found in this browser.");
  try {
    const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
    if (!accounts?.[0]) throw new Error("no account");
    return accounts[0].toLowerCase();
  } catch (err) {
    throw walletError(err);
  }
}

async function useRobinhoodChain(eth: Eip1193Provider) {
  const current = (await eth.request({ method: "eth_chainId" }).catch(() => null)) as string | null;
  if (current?.toLowerCase() === CHAIN_ID) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID }] });
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 4902) throw walletError(err);
    try {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: CHAIN_ID,
            chainName: "Robinhood Chain",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
            blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
          },
        ],
      });
    } catch (e) {
      throw walletError(e);
    }
  }
}

const word = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** The calldata of a revoke: approve(spender, 0). Exported for tests. */
export const revokeData = (spender: string) => `0x095ea7b3${word(spender)}${"0".repeat(64)}`;

/**
 * Sends approve(spender, 0) on `token` from `owner`. The wallet shows it before anything is sent;
 * returns the transaction hash.
 */
export async function revokeApproval(
  owner: string,
  token: string,
  spender: string,
): Promise<string> {
  const eth = injectedWallet();
  if (!eth) throw new WalletError("no-wallet", "No wallet found in this browser.");
  const account = await walletAccount();
  if (account !== owner.toLowerCase()) {
    throw new WalletError(
      "failed",
      `Your wallet is on ${shortAddress(account)}. Switch to ${shortAddress(owner)}, the wallet that gave this approval.`,
    );
  }
  await useRobinhoodChain(eth);
  try {
    return (await eth.request({
      method: "eth_sendTransaction",
      params: [{ from: account, to: token, data: revokeData(spender), value: "0x0" }],
    })) as string;
  } catch (err) {
    throw walletError(err);
  }
}
