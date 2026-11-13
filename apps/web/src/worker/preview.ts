/**
 * Transaction preview for Mofu Guard: simulates a transaction (or a batch of calls) on Robinhood
 * Chain, Ethereum, Base or Arbitrum with eth_simulateV1 and says what changes for the sender's
 * wallet: ETH, tokens and NFTs out and in, and any approval the transaction sets along the way.
 * Nothing is sent or stored.
 */
import type { PreviewApproval, PreviewChange, TxPreview } from "../shared/api.js";
import { callOf, rpcBatch, rpcCall } from "./chain.js";
import { decodeString } from "./token-scan.js";

const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const APPROVAL_ALL = "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";
const TRANSFER_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const DEPOSIT = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";
const WITHDRAWAL = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";
const UNLIMITED = 1n << 128n;
export const MAX_CALLS = 10;

/**
 * Chains the preview can simulate on, with public RPCs checked to answer eth_simulateV1 with
 * traceTransfers. Robinhood Chain uses the Worker's configured list instead.
 */
export const PREVIEW_CHAINS: Record<number, { name: string; rpcs: string[] }> = {
  4663: { name: "Robinhood Chain", rpcs: [] },
  1: {
    name: "Ethereum",
    rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
  },
  8453: {
    name: "Base",
    rpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.drpc.org"],
  },
  42161: {
    name: "Arbitrum",
    rpcs: [
      "https://arbitrum-one-rpc.publicnode.com",
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum.drpc.org",
    ],
  },
};

export interface PreviewCall {
  to: string;
  data: string;
  value: bigint;
}

interface SimLog {
  address: string;
  topics: string[];
  data: string;
}
interface SimCall {
  status?: string;
  logs?: SimLog[];
  error?: { message?: string };
}

const topicAddr = (t: string | undefined) => (t ? `0x${t.slice(26)}`.toLowerCase() : "");
const big = (h: string | undefined) => {
  const s = (h ?? "").replace(/^0x/, "").slice(0, 64);
  return s ? BigInt(`0x${s}`) : 0n;
};
const hex = (v: bigint) => `0x${v.toString(16)}`;

/** Whole units with up to six decimals, e.g. "1,250,000.5". */
export function formatAmount(units: bigint, decimals: number): string {
  const d = BigInt(Math.max(0, Math.min(36, decimals)));
  const scale = 10n ** d;
  const int = units / scale;
  const frac = units % scale;
  const f =
    d > 0n && frac > 0n
      ? frac
          .toString()
          .padStart(Number(d), "0")
          .slice(0, int > 0n ? 4 : 8)
          .replace(/0+$/, "")
      : "";
  if (f) return `${int.toLocaleString("en-US")}.${f}`;
  return int === 0n && frac > 0n ? "< 0.00000001" : int.toLocaleString("en-US");
}

interface Raw {
  /** asset → net change for the sender (fungible), or token ids in/out (NFT). */
  net: Map<string, bigint>;
  nftIn: Array<{ asset: string; id: string }>;
  nftOut: Array<{ asset: string; id: string }>;
  approvals: Array<{
    token: string;
    spender: string;
    value: bigint;
    kind: "token" | "nft";
    tokenId?: string;
  }>;
}

/** What the logs of the simulated calls mean for `from`. Pure. */
export function readLogs(from: string, calls: SimCall[]): Raw {
  const me = from.toLowerCase();
  const out: Raw = { net: new Map(), nftIn: [], nftOut: [], approvals: [] };
  const add = (asset: string, d: bigint) => out.net.set(asset, (out.net.get(asset) ?? 0n) + d);
  for (const c of calls)
    for (const l of c.logs ?? []) {
      const asset = l.address.toLowerCase();
      const [t0, t1, t2, t3] = l.topics ?? [];
      if (t0 === TRANSFER && l.topics.length === 3) {
        const a = topicAddr(t1);
        const b = topicAddr(t2);
        const v = big(l.data);
        if (a === me) add(asset, -v);
        if (b === me) add(asset, v);
      } else if (t0 === TRANSFER && l.topics.length === 4) {
        const id = BigInt(t3!).toString();
        if (topicAddr(t1) === me) out.nftOut.push({ asset, id });
        if (topicAddr(t2) === me) out.nftIn.push({ asset, id });
      } else if (t0 === TRANSFER_SINGLE && l.topics.length === 4) {
        const id = big(l.data.slice(0, 66)).toString();
        const v = big(`0x${l.data.slice(66, 130)}`);
        const key = `${asset}#${id}`;
        if (topicAddr(t2) === me) add(key, -v);
        if (topicAddr(t3) === me) add(key, v);
      } else if (t0 === APPROVAL && topicAddr(t1) === me) {
        if (l.topics.length === 4)
          out.approvals.push({
            token: asset,
            spender: topicAddr(t2),
            value: 1n,
            kind: "nft",
            tokenId: BigInt(t3!).toString(),
          });
        else
          out.approvals.push({
            token: asset,
            spender: topicAddr(t2),
            value: big(l.data),
            kind: "token",
          });
      } else if (t0 === APPROVAL_ALL && topicAddr(t1) === me) {
        out.approvals.push({
          token: asset,
          spender: topicAddr(t2),
          value: big(l.data),
          kind: "nft",
        });
      } else if (t0 === DEPOSIT && l.topics.length === 2 && topicAddr(t1) === me) {
        // WETH9 (Ethereum's WETH) mints with Deposit, not Transfer.
        add(asset, big(l.data));
      } else if (t0 === WITHDRAWAL && l.topics.length === 2 && topicAddr(t1) === me) {
        add(asset, -big(l.data));
      }
    }
  // An approval set and then used or reset in the same batch: keep the last one per pair.
  const last = new Map<string, Raw["approvals"][number]>();
  for (const a of out.approvals) last.set(`${a.token}:${a.spender}:${a.tokenId ?? ""}`, a);
  out.approvals = [...last.values()];
  return out;
}

const str = (h: string | null | undefined) => {
  if (!h || h === "0x") return null;
  try {
    return decodeString(h);
  } catch {
    return null;
  }
};

/** Simulates the calls from `from` and describes the result. Throws when the chain can't simulate. */
export async function previewTransaction(
  urls: readonly string[],
  fetchFn: typeof fetch,
  from: string,
  calls: PreviewCall[],
): Promise<TxPreview> {
  const result = await rpcCall<Array<{ calls?: SimCall[] }>>(
    urls,
    "eth_simulateV1",
    [
      {
        blockStateCalls: [
          {
            calls: calls.map((c) => ({
              from,
              to: c.to,
              data: c.data,
              ...(c.value > 0n ? { value: hex(c.value) } : {}),
              gas: hex(5_000_000n),
            })),
          },
        ],
        traceTransfers: true,
        validation: false,
      },
      "latest",
    ],
    fetchFn,
    10_000,
  );
  const sims = result?.[0]?.calls ?? [];
  const failed = sims.findIndex((c) => c.status !== "0x1");
  const raw = readLogs(from, sims);

  // Names and decimals for the contracts involved.
  const contracts = [
    ...new Set([
      ...[...raw.net.keys()].map((k) => k.split("#")[0]!),
      ...raw.nftIn.map((n) => n.asset),
      ...raw.nftOut.map((n) => n.asset),
      ...raw.approvals.map((a) => a.token),
    ]),
  ]
    .filter((a) => a !== NATIVE)
    .slice(0, 12);
  const meta = await rpcBatch(
    urls,
    contracts.flatMap((a) => [
      callOf(a, "0x95d89b41"),
      callOf(a, "0x313ce567"),
      callOf(a, "0x06fdde03"),
    ]),
    fetchFn,
  ).catch(() => contracts.flatMap(() => [null, null, null]));
  const info = new Map(
    contracts.map((a, i) => {
      const d = meta[i * 3 + 1];
      const decimals = d && /^0x[0-9a-f]+$/i.test(d) && BigInt(d) <= 36n ? Number(BigInt(d)) : null;
      return [a, { symbol: str(meta[i * 3]), name: str(meta[i * 3 + 2]), decimals }] as const;
    }),
  );
  const label = (a: string) =>
    a === NATIVE ? "ETH" : (info.get(a)?.symbol ?? info.get(a)?.name ?? null);

  const changes: PreviewChange[] = [];
  for (const [key, d] of raw.net) {
    if (d === 0n) continue;
    const [asset, id] = key.split("#") as [string, string | undefined];
    const decimals = asset === NATIVE ? 18 : id ? 0 : (info.get(asset)?.decimals ?? 18);
    changes.push({
      asset,
      kind: asset === NATIVE ? "eth" : id ? "nft" : "token",
      symbol: label(asset),
      direction: d < 0n ? "out" : "in",
      amount: formatAmount(d < 0n ? -d : d, decimals),
      tokenId: id ?? null,
    });
  }
  for (const n of raw.nftOut)
    changes.push({
      asset: n.asset,
      kind: "nft",
      symbol: label(n.asset),
      direction: "out",
      amount: "1",
      tokenId: n.id,
    });
  for (const n of raw.nftIn)
    changes.push({
      asset: n.asset,
      kind: "nft",
      symbol: label(n.asset),
      direction: "in",
      amount: "1",
      tokenId: n.id,
    });
  // Out first (what you give), ETH before tokens.
  changes.sort(
    (a, b) =>
      (a.direction === "out" ? 0 : 1) - (b.direction === "out" ? 0 : 1) ||
      (a.kind === "eth" ? 0 : 1) - (b.kind === "eth" ? 0 : 1),
  );

  const approvals: PreviewApproval[] = raw.approvals.map((a) => {
    const revoke = a.value === 0n;
    const unlimited = a.kind === "nft" ? !revoke && !a.tokenId : a.value >= UNLIMITED;
    return {
      token: a.token,
      symbol: label(a.token),
      spender: a.spender,
      kind: a.kind,
      revoke,
      unlimited,
      amount: revoke
        ? "0"
        : a.kind === "nft"
          ? a.tokenId
            ? `item #${a.tokenId}`
            : "every item"
          : unlimited
            ? "unlimited"
            : formatAmount(a.value, info.get(a.token)?.decimals ?? 18),
    };
  });

  return {
    status: failed === -1 ? "ok" : "reverted",
    error:
      failed === -1 ? null : (sims[failed]?.error?.message ?? "The call reverted.").slice(0, 200),
    failedCall: failed === -1 ? null : failed,
    changes: changes.slice(0, 20),
    approvals: approvals.slice(0, 10),
  };
}
