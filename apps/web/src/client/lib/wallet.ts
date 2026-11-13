/**
 * Browser wallet (MetaMask, Rabby, Coinbase Wallet, a wallet app's built-in browser…) through
 * the standard EIP-1193 provider. Three things only: read the account, sign the holder message,
 * and send revokes: approve(spender, 0) for a token, setApprovalForAll(operator, false) for an NFT
 * collection. A revoke removes a permission and can't move anything. Nothing here approves a
 * contract or sends funds.
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

/** The calldata that turns off an NFT collection approval: setApprovalForAll(operator, false). */
export const revokeNftData = (operator: string) => `0xa22cb465${word(operator)}${"0".repeat(64)}`;

/** One permission to take back: a token allowance or a whole-collection NFT approval. */
export interface RevokeItem {
  kind: "token" | "nft";
  /** The token or collection contract. */
  contract: string;
  /** The spender or operator. */
  spender: string;
}

const callFor = (i: RevokeItem) => ({
  to: i.contract,
  data: i.kind === "nft" ? revokeNftData(i.spender) : revokeData(i.spender),
  value: "0x0",
});

async function connectedOwner(owner: string): Promise<Eip1193Provider> {
  const eth = injectedWallet();
  if (!eth) throw new WalletError("no-wallet", "No wallet found in this browser.");
  const account = await walletAccount();
  if (account !== owner.toLowerCase()) {
    throw new WalletError(
      "failed",
      `Your wallet is on ${shortAddress(account)}. Switch to ${shortAddress(owner)}, the wallet that gave these approvals.`,
    );
  }
  await useRobinhoodChain(eth);
  return eth;
}

/**
 * Sends several revokes. Wallets that support batched calls (EIP-5792) get one request to
 * confirm; others get one transaction per revoke, in order. `onSent` hears about each one sent
 * (a transaction hash, or a batch id). Stops at the first one the person cancels.
 */
export async function sendRevokes(
  owner: string,
  items: RevokeItem[],
  onSent: (index: number, ref: { hash?: string; batch?: string }) => void,
): Promise<"batch" | "each"> {
  const eth = await connectedOwner(owner);
  const from = owner.toLowerCase();
  if (items.length > 1) {
    try {
      const res = (await eth.request({
        method: "wallet_sendCalls",
        params: [
          {
            version: "2.0.0",
            chainId: CHAIN_ID,
            from,
            atomicRequired: false,
            calls: items.map(callFor),
          },
        ],
      })) as string | { id?: string };
      const batch = typeof res === "string" ? res : res?.id;
      if (batch) {
        items.forEach((_, i) => onSent(i, { batch }));
        return "batch";
      }
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 4001 || code === "ACTION_REJECTED") throw walletError(err);
      // Not supported (4200, -32601, …): fall back to one transaction each.
    }
  }
  for (let i = 0; i < items.length; i++) {
    try {
      const hash = (await eth.request({
        method: "eth_sendTransaction",
        params: [{ from, ...callFor(items[i]!) }],
      })) as string;
      onSent(i, { hash });
    } catch (err) {
      throw walletError(err);
    }
  }
  return "each";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for a transaction or a batch to land. True when it succeeded. */
export async function waitForRevoke(ref: { hash?: string; batch?: string }): Promise<boolean> {
  const eth = injectedWallet();
  if (!eth) return false;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    try {
      if (ref.hash) {
        const r = (await eth.request({
          method: "eth_getTransactionReceipt",
          params: [ref.hash],
        })) as { status?: string } | null;
        if (r) return r.status === "0x1";
      } else if (ref.batch) {
        const s = (await eth.request({
          method: "wallet_getCallsStatus",
          params: [ref.batch],
        })) as { status?: number | string; receipts?: Array<{ status?: string }> } | null;
        const done = s && (s.status === 200 || s.status === "CONFIRMED" || s.status === 600);
        if (done) return (s.receipts ?? []).every((r) => r.status === "0x1");
        if (s && (s.status === 400 || s.status === 500)) return false;
      }
    } catch {
      // keep waiting
    }
  }
  return false;
}

/** Reads the permission back from the chain. True when it's gone. */
export async function isRevoked(owner: string, item: RevokeItem): Promise<boolean | null> {
  const eth = injectedWallet();
  if (!eth) return null;
  const data =
    item.kind === "nft"
      ? `0xe985e9c5${word(owner)}${word(item.spender)}`
      : `0xdd62ed3e${word(owner)}${word(item.spender)}`;
  try {
    const r = (await eth.request({
      method: "eth_call",
      params: [{ to: item.contract, data }, "latest"],
    })) as string;
    return /^0x0*$/.test(r);
  } catch {
    return null;
  }
}

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
