/**
 * Wallet Health: what a wallet holds and which token approvals it has given, with each approval
 * re-checked on the chain and its spender described. Approvals and balances come from GoldRush;
 * live allowances, token names and spender facts from batched RPC calls.
 */
import type { AddressInfo, WalletApproval, WalletHolding, WalletReport } from "../shared/api.js";
import { findPoisoning, type HistoryTx } from "./poisoning.js";
import { callOf, rpcBatch, rpcCall } from "./chain.js";
import { recentTransactions, type ChainDataOptions } from "./chain-data.js";
import { decodeString } from "./token-scan.js";
import { describeActivity, describeAddresses } from "./known.js";

const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
/** At or above this, an allowance is treated as unlimited (2^128 tokens of the smallest unit). */
const UNLIMITED = 1n << 128n;
const MAX_APPROVALS = 40;
const MAX_HOLDINGS = 25;

interface BalanceItem {
  contract_address?: string;
  contract_name?: string | null;
  contract_ticker_symbol?: string | null;
  contract_decimals?: number | null;
  balance?: string | null;
  quote?: number | null;
  type?: string;
  is_spam?: boolean;
}

interface ApprovalItem {
  token_address?: string;
  ticker_symbol?: string | null;
  contract_decimals?: number | null;
  balance?: string | null;
  spenders?: Array<{
    spender_address?: string;
    allowance?: string;
    block_signed_at?: string;
    tx_hash?: string;
  }>;
}

async function gr<T>(o: ChainDataOptions, path: string): Promise<T | null> {
  try {
    const res = await o.fetch(`https://api.covalenthq.com/v1/${o.chain}/${path}`, {
      headers: { Authorization: `Bearer ${o.apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { data?: T; error?: boolean };
    return res.ok && !body.error && body.data ? body.data : null;
  } catch {
    return null;
  }
}

const isUint = (s: unknown): s is string => typeof s === "string" && /^\d+$/.test(s);

/** Whole tokens with up to four decimals, e.g. "1,234.5". */
export function formatUnits(units: bigint, decimals: number): string {
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
  const head = int.toLocaleString("en-US");
  if (f) return `${head}.${f}`;
  return int === 0n && frac > 0n ? "< 0.00000001" : head;
}

const str = (h: string | null | undefined) => {
  if (!h || h === "0x") return null;
  try {
    return decodeString(h);
  } catch {
    return null;
  }
};

const pad = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** Plain-English reasons and a level for one approval. */
export function judgeApproval(
  a: { unlimited: boolean; balance: bigint | null; symbol: string | null },
  spender: AddressInfo,
): { risk: WalletApproval["risk"]; reasons: string[] } {
  const reasons: string[] = [];
  let risk: WalletApproval["risk"] = "ok";
  const sym = a.symbol ? `$${a.symbol}` : "this token";
  const activity = describeActivity(spender);
  if (spender.kind === "wallet") {
    risk = "risk";
    reasons.push(
      "The spender is a plain wallet, not a contract. Apps never need that: it's how drainers take tokens.",
    );
  } else if (
    !spender.known &&
    spender.ageDays !== null &&
    spender.ageDays < 7 &&
    (spender.txCount ?? 0) < 1_000
  ) {
    risk = "risk";
    reasons.push(`The spender is a new contract with little use (${activity}).`);
  }
  if (a.unlimited) {
    if (risk === "ok") risk = "warn";
    reasons.push(`Unlimited: it can take all the ${sym} you hold, now and later.`);
  }
  if (spender.kind !== "wallet" && !spender.known && spender.txCount === null && risk === "ok") {
    risk = "warn";
    reasons.push("Mofu couldn't read this contract's history.");
  }
  if (a.balance === 0n)
    reasons.push(`You hold no ${sym} right now, so nothing can be taken until you do.`);
  if (spender.label)
    reasons.unshift(`Spender: ${spender.label}${activity ? ` (${activity})` : ""}.`);
  else if (spender.kind !== "wallet" && activity)
    reasons.unshift(`Spender: a contract, ${activity}.`);
  return { risk, reasons };
}

const RANK = { risk: 0, warn: 1, ok: 2 } as const;

export async function walletReport(
  o: ChainDataOptions & { now: number },
  address: string,
): Promise<WalletReport> {
  const wallet = address.toLowerCase();
  const limits = [
    "Token approvals only. Approvals for whole NFT collections (setApprovalForAll) aren't checked yet.",
    "Approvals come from GoldRush's index and are re-checked on the chain; a very recent one can be missing for a few minutes.",
  ];
  const [code, balances, approvals, history] = await Promise.all([
    rpcCall<string>(o.rpcUrls, "eth_getCode", [wallet, "latest"], o.fetch).catch(() => "0x"),
    gr<{ items?: BalanceItem[] }>(o, `address/${wallet}/balances_v2/?no-spam=true`),
    gr<{ items?: ApprovalItem[] }>(o, `approvals/${wallet}/`),
    recentTransactions(o, wallet).then(
      (items) => items as unknown as HistoryTx[],
      () => null,
    ),
  ]);
  const poisoning = history ? findPoisoning(wallet, history) : [];
  limits.push(
    history
      ? "Lookalike addresses are checked in the wallet's latest 50 to 200 transactions."
      : "The wallet's recent transactions couldn't be read, so lookalike addresses weren't checked.",
  );

  // Holdings: non-zero, not spam, priced ones first.
  const meta = new Map<
    string,
    { name: string | null; symbol: string | null; decimals: number | null }
  >();
  let eth: string | null = null;
  const held = (balances?.items ?? []).filter(
    (i) => i.contract_address && isUint(i.balance) && BigInt(i.balance!) > 0n && !i.is_spam,
  );
  const holdings: WalletHolding[] = [];
  for (const i of held) {
    const token = i.contract_address!.toLowerCase();
    const decimals = i.contract_decimals ?? 18;
    if (token === NATIVE) {
      eth = formatUnits(BigInt(i.balance!), decimals);
      continue;
    }
    meta.set(token, {
      name: i.contract_name?.trim() || null,
      symbol: i.contract_ticker_symbol?.trim() || null,
      decimals: i.contract_decimals ?? null,
    });
  }
  const tokensHeld = held
    .filter((i) => i.contract_address!.toLowerCase() !== NATIVE)
    .sort((a, b) => (b.quote ?? -1) - (a.quote ?? -1));
  for (const i of tokensHeld.slice(0, MAX_HOLDINGS)) {
    const token = i.contract_address!.toLowerCase();
    holdings.push({
      token,
      name: i.contract_name?.trim() || null,
      symbol: i.contract_ticker_symbol?.trim() || null,
      balance: formatUnits(BigInt(i.balance!), i.contract_decimals ?? 18),
    });
  }
  if (tokensHeld.length > MAX_HOLDINGS)
    limits.push(`Showing ${MAX_HOLDINGS} of the ${tokensHeld.length} tokens this wallet holds.`);

  // Approvals: newest first, re-checked live.
  const pairs = (approvals?.items ?? [])
    .flatMap((item) =>
      (item.spenders ?? []).map((s) => ({
        token: (item.token_address ?? "").toLowerCase(),
        spender: (s.spender_address ?? "").toLowerCase(),
        balance: isUint(item.balance) ? BigInt(item.balance!) : null,
        decimals: item.contract_decimals ?? null,
        symbol: item.ticker_symbol ?? null,
        approvedAt: s.block_signed_at ?? null,
        txHash: s.tx_hash ?? null,
      })),
    )
    .filter((p) => /^0x[0-9a-f]{40}$/.test(p.token) && /^0x[0-9a-f]{40}$/.test(p.spender))
    .sort((a, b) => Date.parse(b.approvedAt ?? "0") - Date.parse(a.approvedAt ?? "0"));
  if (pairs.length > MAX_APPROVALS)
    limits.push(`Checked the ${MAX_APPROVALS} most recent of ${pairs.length} approvals.`);
  const recent = pairs.slice(0, MAX_APPROVALS);

  const live = await rpcBatch(
    o.rpcUrls,
    recent.map((p) => callOf(p.token, `0xdd62ed3e${pad(wallet)}${pad(p.spender)}`)),
    o.fetch,
  ).catch(() => recent.map(() => null));
  const active = recent
    .map((p, i) => {
      const r = live[i];
      const allowance = r && /^0x[0-9a-f]{64}/i.test(r) ? BigInt(r.slice(0, 66)) : null;
      return { ...p, allowance };
    })
    .filter((p) => p.allowance !== null && p.allowance > 0n);

  // Names, tickers and decimals for approval tokens we don't know yet.
  const unknown = [...new Set(active.map((p) => p.token))].filter((t) => !meta.has(t)).slice(0, 20);
  if (unknown.length) {
    const r = await rpcBatch(
      o.rpcUrls,
      unknown.flatMap((t) => [
        callOf(t, "0x06fdde03"),
        callOf(t, "0x95d89b41"),
        callOf(t, "0x313ce567"),
      ]),
      o.fetch,
    ).catch(() => unknown.flatMap(() => [null, null, null]));
    unknown.forEach((t, i) => {
      const d = r[i * 3 + 2];
      meta.set(t, {
        name: str(r[i * 3]),
        symbol: str(r[i * 3 + 1]),
        decimals: d && /^0x[0-9a-f]+$/i.test(d) && BigInt(d) <= 36n ? Number(BigInt(d)) : null,
      });
    });
  }

  const spenders = await describeAddresses(o, [...new Set(active.map((p) => p.spender))], 8).catch(
    () => new Map<string, AddressInfo>(),
  );
  const out: WalletApproval[] = active.map((p) => {
    const m = meta.get(p.token);
    const decimals = m?.decimals ?? p.decimals ?? 18;
    const symbol = m?.symbol ?? p.symbol;
    const unlimited = p.allowance! >= UNLIMITED;
    const spender: AddressInfo = spenders.get(p.spender) ?? {
      address: p.spender,
      kind: "contract",
      label: null,
      known: false,
      txCount: null,
      firstSeen: null,
      ageDays: null,
    };
    const { risk, reasons } = judgeApproval({ unlimited, balance: p.balance, symbol }, spender);
    return {
      token: p.token,
      tokenName: m?.name ?? null,
      tokenSymbol: symbol,
      balance: p.balance === null ? null : formatUnits(p.balance, decimals),
      spender,
      unlimited,
      allowance: unlimited ? "unlimited" : formatUnits(p.allowance!, decimals),
      approvedAt: p.approvedAt,
      txHash: p.txHash,
      risk,
      reasons,
    };
  });
  // Riskiest first; within a level, tokens the wallet still holds come before empty ones.
  const empty = (a: WalletApproval) => (a.balance === null || a.balance === "0" ? 1 : 0);
  out.sort((a, b) => RANK[a.risk] - RANK[b.risk] || empty(a) - empty(b));

  return {
    address: wallet,
    isContract: !!code && code !== "0x" && !code.toLowerCase().startsWith("0xef0100"),
    eth,
    holdings,
    holdingsTotal: tokensHeld.length,
    approvals: out,
    poisoning,
    status: {
      holdings: balances ? "ok" : "unavailable",
      approvals: approvals ? "ok" : "unavailable",
    },
    checkedAt: new Date(o.now).toISOString(),
    limits,
  };
}
