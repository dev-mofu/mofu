/**
 * Wallet Health: what a wallet holds and which token approvals it has given, with each approval
 * re-checked on the chain and its spender described. Approvals and balances come from GoldRush;
 * live allowances, token names and spender facts from batched RPC calls.
 */
import type {
  AddressInfo,
  WalletApproval,
  WalletHolding,
  WalletNftApproval,
  WalletReport,
} from "../shared/api.js";
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

interface NftApprovalItem {
  contract_address?: string;
  token_address?: string;
  contract_name?: string | null;
  contract_ticker_symbol?: string | null;
  spenders?: Array<{
    spender_address?: string;
    operator?: string;
    block_signed_at?: string;
    tx_hash?: string;
  }>;
}

const MAX_NFT_APPROVALS = 20;

/**
 * Collection-wide NFT approvals to check: from GoldRush's index and from ApprovalForAll events in
 * the wallet's recent transactions, newest first, one per collection and operator.
 */
export function nftApprovalCandidates(
  wallet: string,
  index: NftApprovalItem[] | null,
  history: HistoryTx[] | null,
): Array<{
  collection: string;
  operator: string;
  approvedAt: string | null;
  txHash: string | null;
  name: string | null;
  symbol: string | null;
}> {
  const out = new Map<
    string,
    {
      collection: string;
      operator: string;
      approvedAt: string | null;
      txHash: string | null;
      name: string | null;
      symbol: string | null;
    }
  >();
  const add = (
    c: string | undefined,
    op: string | undefined,
    at: string | null,
    tx: string | null,
    name: string | null,
    symbol: string | null,
  ) => {
    const collection = (c ?? "").toLowerCase();
    const operator = (op ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(collection) || !/^0x[0-9a-f]{40}$/.test(operator)) return;
    const k = `${collection}:${operator}`;
    const prev = out.get(k);
    if (!prev || Date.parse(at ?? "0") > Date.parse(prev.approvedAt ?? "0"))
      out.set(k, {
        collection,
        operator,
        approvedAt: at,
        txHash: tx,
        name: name ?? prev?.name ?? null,
        symbol: symbol ?? prev?.symbol ?? null,
      });
  };
  for (const item of index ?? [])
    for (const s of item.spenders ?? [])
      add(
        item.contract_address ?? item.token_address,
        s.spender_address ?? s.operator,
        s.block_signed_at ?? null,
        s.tx_hash ?? null,
        item.contract_name?.trim() || null,
        item.contract_ticker_symbol?.trim() || null,
      );
  for (const tx of history ?? [])
    for (const e of tx.log_events ?? []) {
      if (e.decoded?.name !== "ApprovalForAll") continue;
      const p = (n: string) => e.decoded?.params?.find((x) => x.name === n)?.value;
      if (String(p("owner") ?? "").toLowerCase() !== wallet) continue;
      add(
        e.sender_address ?? undefined,
        String(p("operator") ?? ""),
        tx.block_signed_at ?? null,
        tx.tx_hash,
        null,
        e.sender_contract_ticker_symbol ?? null,
      );
    }
  return [...out.values()]
    .sort((a, b) => Date.parse(b.approvedAt ?? "0") - Date.parse(a.approvedAt ?? "0"))
    .slice(0, MAX_NFT_APPROVALS);
}

/** Level and reasons for an approval over a whole NFT collection. */
export function judgeNftApproval(
  name: string,
  operator: AddressInfo,
): { risk: WalletNftApproval["risk"]; reasons: string[] } {
  const activity = describeActivity(operator);
  const reasons = [`It can move every NFT you hold in ${name}, now and later.`];
  let risk: WalletNftApproval["risk"] = "warn";
  if (operator.kind === "wallet") {
    risk = "risk";
    reasons.push(
      "The operator is a plain wallet, not a contract. Marketplaces never need that: it's how NFT drainers work.",
    );
  } else if (
    !operator.known &&
    operator.ageDays !== null &&
    operator.ageDays < 7 &&
    (operator.txCount ?? 0) < 1_000
  ) {
    risk = "risk";
    reasons.push(`The operator is a new contract with little use (${activity}).`);
  }
  if (operator.label)
    reasons.unshift(`Operator: ${operator.label}${activity ? ` (${activity})` : ""}.`);
  else if (operator.kind !== "wallet" && activity)
    reasons.unshift(`Operator: a contract, ${activity}.`);
  return { risk, reasons };
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
    "Approvals come from GoldRush's index and the wallet's recent transactions, and are re-checked on the chain; a very recent one can be missing for a few minutes.",
    "NFT approvals cover whole collections (setApprovalForAll); approvals for single NFTs aren't listed.",
  ];
  const [code, balances, approvals, history, nftIndex] = await Promise.all([
    rpcCall<string>(o.rpcUrls, "eth_getCode", [wallet, "latest"], o.fetch).catch(() => "0x"),
    gr<{ items?: BalanceItem[] }>(o, `address/${wallet}/balances_v2/?no-spam=true`),
    gr<{ items?: ApprovalItem[] }>(o, `approvals/${wallet}/`),
    recentTransactions(o, wallet).then(
      (items) => items as unknown as HistoryTx[],
      () => null,
    ),
    gr<{ items?: NftApprovalItem[] }>(o, `nft/approvals/${wallet}/`),
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

  // Collection-wide NFT approvals, kept only when isApprovedForAll still says yes.
  const nftCandidates = nftApprovalCandidates(wallet, nftIndex?.items ?? null, history);
  const nftLive = await rpcBatch(
    o.rpcUrls,
    nftCandidates.flatMap((c) => [
      callOf(c.collection, `0xe985e9c5${pad(wallet)}${pad(c.operator)}`),
      callOf(c.collection, "0x06fdde03"),
      callOf(c.collection, "0x95d89b41"),
    ]),
    o.fetch,
  ).catch(() => nftCandidates.flatMap(() => [null, null, null]));
  const nftActive = nftCandidates
    .map((c, i) => ({
      ...c,
      on: /^0x0*1$/i.test(nftLive[i * 3] ?? ""),
      name: c.name ?? str(nftLive[i * 3 + 1] ?? null),
      symbol: c.symbol ?? str(nftLive[i * 3 + 2] ?? null),
    }))
    .filter((c) => c.on);

  const spenders = await describeAddresses(
    o,
    [...new Set([...active.map((p) => p.spender), ...nftActive.map((c) => c.operator)])],
    8,
  ).catch(() => new Map<string, AddressInfo>());
  const nftApprovals: WalletNftApproval[] = nftActive.map((c) => {
    const operator: AddressInfo = spenders.get(c.operator) ?? {
      address: c.operator,
      kind: "contract",
      label: null,
      known: false,
      txCount: null,
      firstSeen: null,
      ageDays: null,
    };
    const label = c.name ?? (c.symbol ? `$${c.symbol}` : "this collection");
    const { risk, reasons } = judgeNftApproval(label, operator);
    return {
      collection: c.collection,
      name: c.name,
      symbol: c.symbol,
      operator,
      approvedAt: c.approvedAt,
      txHash: c.txHash,
      risk,
      reasons,
    };
  });
  nftApprovals.sort((a, b) => RANK[a.risk] - RANK[b.risk]);
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
    nftApprovals,
    poisoning,
    status: {
      holdings: balances ? "ok" : "unavailable",
      approvals: approvals ? "ok" : "unavailable",
    },
    checkedAt: new Date(o.now).toISOString(),
    limits,
  };
}
