/**
 * Indexed Robinhood Chain data from GoldRush (Covalent): token holders, who created a token, and
 * decoded transactions. Public RPCs can't answer these, so every function needs the API key.
 * Contracts are told apart from wallets with eth_getCode on the fallback RPC list.
 */
import type {
  LaunchHistory,
  TokenHolder,
  TokenOrigin,
  TxApproval,
  TxReport,
  TxTransfer,
} from "../shared/api.js";
import { callOf, rpcBatch, rpcCall } from "./chain.js";
import { decodeString } from "./token-scan.js";

const BASE = "https://api.covalenthq.com/v1";
const ZERO = "0x0000000000000000000000000000000000000000";
const BURN = new Set([ZERO, "0x000000000000000000000000000000000000dead"]);
const MAX_UINT256 = (1n << 256n) - 1n;

export interface ChainDataOptions {
  apiKey: string;
  chain: string;
  rpcUrls: readonly string[];
  fetch: typeof fetch;
}

export class ChainDataError extends Error {}

/** A GoldRush GET, tried once more after a short pause when it's rate-limited (HTTP 429). */
export async function goldrushGet(
  o: ChainDataOptions,
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const go = () =>
    o.fetch(url, {
      headers: { Authorization: `Bearer ${o.apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  const res = await go();
  if (res.status !== 429) return res;
  await new Promise((r) => setTimeout(r, 1200));
  return go();
}

async function gr<T>(o: ChainDataOptions, path: string): Promise<T> {
  const res = await goldrushGet(o, `${BASE}/${o.chain}/${path}`, 12_000);
  const body = (await res.json().catch(() => null)) as {
    data?: T;
    error?: boolean;
    error_message?: string;
  } | null;
  if (!res.ok || !body || body.error || !body.data) {
    throw new ChainDataError(body?.error_message ?? `GoldRush HTTP ${res.status}`);
  }
  return body.data;
}

const isContract = async (o: ChainDataOptions, address: string) => {
  const code = await rpcCall<string>(o.rpcUrls, "eth_getCode", [address, "latest"], o.fetch).catch(
    () => "0x",
  );
  // EIP-7702 wallets carry a delegation designator (0xef0100…), not contract code.
  return !!code && code !== "0x" && !code.toLowerCase().startsWith("0xef0100");
};

const share = (part: bigint, total: bigint) =>
  total > 0n ? Number((part * 1_000_000n) / total) / 10_000 : 0;

const whole = (units: bigint, decimals: number) => (units / 10n ** BigInt(decimals)).toString();

// ---------------------------------------------------------------- holders

interface HolderItem {
  address?: string;
  balance?: string;
  total_supply?: string;
  contract_decimals?: number;
}

/** Top holders by balance (first page from GoldRush, sorted here), contracts and burns labeled. */
export async function topHolders(
  o: ChainDataOptions,
  token: string,
  limit = 10,
): Promise<TokenHolder[]> {
  const data = await gr<{ items?: HolderItem[] }>(o, `tokens/${token}/token_holders_v2/`);
  const items = (data.items ?? [])
    .filter((i) => i.address && i.balance && /^\d+$/.test(i.balance))
    .sort((a, b) => {
      const x = BigInt(a.balance!),
        y = BigInt(b.balance!);
      return x > y ? -1 : x < y ? 1 : 0;
    })
    .slice(0, limit);
  return Promise.all(
    items.map(async (i): Promise<TokenHolder> => {
      const address = i.address!.toLowerCase();
      const balance = BigInt(i.balance!);
      const supply = BigInt(i.total_supply ?? "0");
      const kind: TokenHolder["kind"] = BURN.has(address)
        ? "burn"
        : (await isContract(o, address))
          ? "contract"
          : "wallet";
      return {
        address,
        balance: whole(balance, i.contract_decimals ?? 18),
        percent: share(balance, supply),
        kind,
      };
    }),
  );
}

// ---------------------------------------------------------------- origin

export interface TxItem {
  tx_hash?: string;
  block_signed_at?: string;
  block_height?: number;
  tx_offset?: number;
  from_address?: string;
  to_address?: string;
  successful?: boolean;
  value?: string;
  fees_paid?: string;
  log_events?: LogEvent[];
}
export interface LogEvent {
  sender_address?: string;
  sender_contract_ticker_symbol?: string | null;
  sender_contract_decimals?: number | null;
  decoded?: { name?: string; params?: Array<{ name?: string; value?: unknown }> | null } | null;
}
interface Summary {
  items?: Array<{
    total_count?: number;
    earliest_transaction?: { tx_hash?: string; block_signed_at?: string };
    latest_transaction?: { tx_hash?: string; block_signed_at?: string };
  }>;
}

interface TxPage {
  items?: TxItem[];
  current_page?: number;
}

const byBlock = (a: TxItem, b: TxItem) =>
  (a.block_height ?? 0) - (b.block_height ?? 0) || (a.tx_offset ?? 0) - (b.tx_offset ?? 0);

/**
 * An address's newest transactions, newest first: GoldRush's latest page, plus the page before
 * it when the latest is short. (Numbered pages count from the oldest: page 0 is the first 100.)
 */
export async function recentTransactions(
  o: ChainDataOptions,
  address: string,
  { logs = true, min = 50 }: { logs?: boolean; min?: number } = {},
): Promise<TxItem[]> {
  const q = logs ? "" : "?no-logs=true";
  const latest = await gr<TxPage>(o, `address/${address}/transactions_v3/${q}`);
  const items = [...(latest.items ?? [])];
  const page = latest.current_page;
  if (items.length < min && typeof page === "number" && page > 0) {
    const prev = await gr<TxPage>(
      o,
      `address/${address}/transactions_v3/page/${page - 1}/${q}`,
    ).catch(() => null);
    items.push(...(prev?.items ?? []));
  }
  return items.sort((a, b) => byBlock(b, a));
}

/** An address's first 100 transactions, oldest first. */
export async function earliestTransactions(
  o: ChainDataOptions,
  address: string,
  { logs = true }: { logs?: boolean } = {},
): Promise<TxItem[]> {
  const page = await gr<TxPage>(
    o,
    `address/${address}/transactions_v3/page/0/${logs ? "" : "?no-logs=true"}`,
  );
  return [...(page.items ?? [])].sort(byBlock);
}

/** Total transactions of an address, or null when unknown. */
export async function transactionCount(
  o: ChainDataOptions,
  address: string,
): Promise<number | null> {
  const s = await gr<Summary>(o, `address/${address}/transactions_summary/`).catch(() => null);
  return s?.items?.[0]?.total_count ?? null;
}

const str = (h: string | null | undefined) => {
  if (!h || h === "0x") return null;
  try {
    return decodeString(h);
  } catch {
    return null;
  }
};

/**
 * Deployer history: name, ticker and last activity of up to five other tokens the creator
 * launched. "Active" means any transaction in the last seven days.
 */
export async function launchHistory(
  o: ChainDataOptions,
  tokens: readonly string[],
  now: number,
): Promise<LaunchHistory[]> {
  const list = tokens.slice(0, 5);
  if (list.length === 0) return [];
  const [meta, summaries] = await Promise.all([
    rpcBatch(
      o.rpcUrls,
      list.flatMap((t) => [callOf(t, "0x06fdde03"), callOf(t, "0x95d89b41")]),
      o.fetch,
    ).catch(() => list.flatMap(() => [null, null])),
    Promise.all(
      list.map((t) => gr<Summary>(o, `address/${t}/transactions_summary/`).catch(() => null)),
    ),
  ]);
  return list.map((address, i) => {
    const lastActive = summaries[i]?.items?.[0]?.latest_transaction?.block_signed_at ?? null;
    return {
      address,
      name: str(meta[i * 2]),
      symbol: str(meta[i * 2 + 1]),
      lastActive,
      active: lastActive !== null && now - Date.parse(lastActive) < 7 * 86_400_000,
    };
  });
}

const param = (e: LogEvent, name: string) =>
  e.decoded?.params?.find((p) => p.name === name)?.value as string | undefined;

/**
 * Who created the token: the sender of the token's earliest transaction (on launchpads that is
 * the person who called the launcher). Also how old that wallet is, what it still holds, and
 * how many other tokens it launched through the same contract in its recent history.
 */
export async function tokenOrigin(
  o: ChainDataOptions,
  token: string,
  totalSupply: bigint | null,
  decimals: number,
  now: number,
): Promise<TokenOrigin | null> {
  const sum = await gr<Summary>(o, `address/${token}/transactions_summary/`);
  const first = sum.items?.[0]?.earliest_transaction?.tx_hash;
  if (!first) return null;
  const tx = (await gr<{ items?: TxItem[] }>(o, `transaction_v2/${first}/`)).items?.[0];
  const creator = tx?.from_address?.toLowerCase();
  if (!tx || !creator) return null;
  const launcher = tx.to_address?.toLowerCase() ?? null;
  const minted = (tx.log_events ?? []).some(
    (e) =>
      e.sender_address?.toLowerCase() === token &&
      e.decoded?.name === "Transfer" &&
      param(e, "from") === ZERO,
  );

  const [balanceHex, creatorSummary, creatorTxs] = await Promise.all([
    rpcCall<string>(
      o.rpcUrls,
      "eth_call",
      [{ to: token, data: `0x70a08231${creator.slice(2).padStart(64, "0")}` }, "latest"],
      o.fetch,
    ).catch(() => null),
    gr<Summary>(o, `address/${creator}/transactions_summary/`).catch(() => null),
    recentTransactions(o, creator).catch(() => null),
  ]);
  const balance = balanceHex && /^0x[0-9a-f]+$/i.test(balanceHex) ? BigInt(balanceHex) : null;
  const firstSeen = creatorSummary?.items?.[0]?.earliest_transaction?.block_signed_at ?? null;
  // Other tokens this wallet launched through the same launcher, in its latest transactions.
  const others = new Set<string>();
  for (const t of creatorTxs ?? []) {
    if (!launcher || t.to_address?.toLowerCase() !== launcher) continue;
    for (const e of t.log_events ?? []) {
      const sender = e.sender_address?.toLowerCase();
      if (sender && sender !== token && e.decoded?.name === "Transfer" && param(e, "from") === ZERO)
        others.add(sender);
    }
  }
  const otherLaunchDetails = await launchHistory(o, [...others], now).catch(() => []);
  return {
    creator,
    launcher: minted ? launcher : null,
    creationTx: first,
    createdAt: tx.block_signed_at ?? null,
    creatorFirstSeen: firstSeen,
    creatorAgeDays: firstSeen
      ? Math.max(0, Math.floor((now - Date.parse(firstSeen)) / 86_400_000))
      : null,
    creatorTxCount: creatorSummary?.items?.[0]?.total_count ?? null,
    creatorHolds: balance !== null ? whole(balance, decimals) : null,
    creatorHoldsPercent: balance !== null && totalSupply ? share(balance, totalSupply) : null,
    otherLaunches: [...others].slice(0, 20),
    otherLaunchCount: others.size,
    otherLaunchDetails,
  };
}

// ---------------------------------------------------------------- transactions

const fmtUnits = (units: bigint, decimals: number) => {
  const d = BigInt(decimals);
  const int = units / 10n ** d;
  const frac = units % 10n ** d;
  if (frac === 0n || decimals === 0) return int.toLocaleString("en-US");
  const f = frac
    .toString()
    .padStart(decimals, "0")
    .slice(0, int > 0n ? 4 : 8)
    .replace(/0+$/, "");
  return f ? `${int.toLocaleString("en-US")}.${f}` : int.toLocaleString("en-US");
};

/** A decoded, plain-English account of one transaction. Deterministic; the model only explains. */
export async function explainTransaction(o: ChainDataOptions, hash: string): Promise<TxReport> {
  const tx = (await gr<{ items?: TxItem[] }>(o, `transaction_v2/${hash}/`)).items?.[0];
  if (!tx) throw new ChainDataError("Transaction not found.");
  const from = tx.from_address?.toLowerCase() ?? "";
  const to = tx.to_address?.toLowerCase() ?? null;
  const transfers: TxTransfer[] = [];
  const approvals: TxApproval[] = [];
  const otherEvents = new Set<string>();
  for (const e of tx.log_events ?? []) {
    const name = e.decoded?.name;
    const token = e.sender_address?.toLowerCase() ?? "";
    const symbol = e.sender_contract_ticker_symbol ?? null;
    const decimals = e.sender_contract_decimals ?? 18;
    if (name === "Transfer" && param(e, "value") !== undefined) {
      const raw = BigInt(String(param(e, "value")));
      transfers.push({
        token,
        symbol,
        from: String(param(e, "from") ?? "").toLowerCase(),
        to: String(param(e, "to") ?? "").toLowerCase(),
        amount: fmtUnits(raw, decimals),
        mint: param(e, "from") === ZERO,
        burn: BURN.has(String(param(e, "to") ?? "").toLowerCase()),
      });
    } else if (name === "Approval" && param(e, "value") !== undefined) {
      const raw = BigInt(String(param(e, "value")));
      approvals.push({
        token,
        symbol,
        owner: String(param(e, "owner") ?? "").toLowerCase(),
        spender: String(param(e, "spender") ?? "").toLowerCase(),
        amount: raw >= MAX_UINT256 / 2n ? "unlimited" : fmtUnits(raw, decimals),
        unlimited: raw >= MAX_UINT256 / 2n,
        spenderIsContract: null,
      });
    } else if (name === "ApprovalForAll") {
      approvals.push({
        token,
        symbol,
        owner: String(param(e, "owner") ?? "").toLowerCase(),
        spender: String(param(e, "operator") ?? "").toLowerCase(),
        amount:
          param(e, "approved") === "false" || param(e, "approved") === (false as unknown)
            ? "revoked"
            : "all items",
        unlimited: !(
          param(e, "approved") === "false" || param(e, "approved") === (false as unknown)
        ),
        spenderIsContract: null,
      });
    } else if (name) otherEvents.add(name);
  }
  await Promise.all(
    approvals.map(async (a) => {
      a.spenderIsContract = await isContract(o, a.spender);
    }),
  );
  const value = BigInt(tx.value ?? "0");
  const fee = BigInt(tx.fees_paid ?? "0");
  const toIsContract = to ? await isContract(o, to) : null;

  const flags: TxReport["flags"] = [];
  if (tx.successful === false)
    flags.push({
      level: "warn",
      text: "This transaction failed. Nothing it tried to do happened, but the fee was still paid.",
    });
  for (const a of approvals) {
    if (a.amount === "revoked") continue;
    if (a.unlimited) {
      flags.push({
        level: "risk",
        text: `Unlimited approval: ${a.spender} can move ALL of this wallet's ${a.symbol ?? "tokens"} at any time, until it's revoked. Only keep this for apps you trust.`,
      });
    } else {
      flags.push({
        level: "warn",
        text: `Approval: ${a.spender} may move up to ${a.amount} ${a.symbol ?? "tokens"} from this wallet.`,
      });
    }
    if (a.spenderIsContract === false) {
      flags.push({
        level: "risk",
        text: `The approved spender ${a.spender} is a plain wallet, not an app contract. That's a common sign of a drainer.`,
      });
    }
  }

  return {
    hash,
    chainName: "Robinhood Chain",
    status: tx.successful === false ? "failed" : "success",
    time: tx.block_signed_at ?? null,
    from,
    to,
    toIsContract,
    valueEth: fmtUnits(value, 18),
    feeEth: fmtUnits(fee, 18),
    transfers: transfers.slice(0, 40),
    approvals,
    otherEvents: [...otherEvents].slice(0, 12),
    flags,
  };
}
