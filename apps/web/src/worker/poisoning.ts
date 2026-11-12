/**
 * Address poisoning in a wallet's recent history: transfers someone else sent, from or to an
 * address that starts and ends like one the wallet really uses, so a later copy-paste from the
 * history goes to the scammer. Also flags zero-value transfers "from" the wallet that it never
 * sent (the transferFrom(…, 0) trick).
 */
import type { PoisonAlert } from "../shared/api.js";

export interface HistoryTx {
  tx_hash: string;
  block_signed_at?: string | null;
  from_address: string;
  to_address?: string | null;
  value?: string | null;
  successful?: boolean | null;
  log_events?: Array<{
    sender_address?: string | null;
    sender_contract_ticker_symbol?: string | null;
    decoded?: { name?: string; params?: Array<{ name: string; value: unknown }> | null } | null;
  }> | null;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;

/** Same first 4 and last 4 hex characters, different address. */
export function looksLike(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (!ADDRESS.test(x) || !ADDRESS.test(y) || x === y) return false;
  return x.slice(2, 6) === y.slice(2, 6) && x.slice(-4) === y.slice(-4);
}

/** A whole number from GoldRush's string fields; anything unreadable counts as zero. */
function toBig(v: unknown): bigint {
  try {
    return BigInt(String(v ?? "0"));
  } catch {
    return 0n;
  }
}

function transfers(tx: HistoryTx) {
  return (tx.log_events ?? [])
    .filter((e) => e.decoded?.name === "Transfer" && e.decoded.params?.length)
    .map((e) => {
      const p = Object.fromEntries((e.decoded!.params ?? []).map((x) => [x.name, x.value]));
      const value = toBig(p.value ?? p.wad ?? p.amount);
      return {
        token: String(e.sender_address ?? "").toLowerCase(),
        symbol: e.sender_contract_ticker_symbol ?? null,
        from: String(p.from ?? p.src ?? "").toLowerCase(),
        to: String(p.to ?? p.dst ?? "").toLowerCase(),
        value,
      };
    });
}

export function findPoisoning(wallet: string, txs: HistoryTx[]): PoisonAlert[] {
  const me = wallet.toLowerCase();
  // Who the wallet really sends to: its own transactions with something of value moving out.
  const trusted = new Set<string>();
  for (const tx of txs) {
    if (tx.from_address?.toLowerCase() !== me || tx.successful === false) continue;
    if (toBig(tx.value) > 0n && tx.to_address) trusted.add(tx.to_address.toLowerCase());
    for (const t of transfers(tx))
      if (t.from === me && t.value > 0n && ADDRESS.test(t.to)) trusted.add(t.to);
  }
  const known = [...trusted, me];
  const alerts = new Map<string, PoisonAlert>();
  for (const tx of txs) {
    if (tx.from_address?.toLowerCase() === me) continue; // the wallet sent it: not planted
    for (const t of transfers(tx)) {
      const outbound = t.from === me;
      const other = t.to === me ? t.from : outbound ? t.to : null;
      if (!other || !ADDRESS.test(other) || alerts.has(other)) continue;
      const twin = known.find((k) => looksLike(other, k)) ?? null;
      const zeroFromYou = outbound && t.value === 0n;
      if (!twin && !zeroFromYou) continue;
      alerts.set(other, {
        address: other,
        resembles: twin,
        resemblesSelf: twin === me,
        kind: zeroFromYou ? "zero-transfer" : t.value === 0n ? "zero-transfer" : "dust",
        token: t.token || null,
        tokenSymbol: t.symbol,
        txHash: tx.tx_hash,
        at: tx.block_signed_at ?? null,
        risk: twin ? "risk" : "warn",
      });
      if (alerts.size >= 10) break;
    }
  }
  return [...alerts.values()].sort((a, b) => (a.risk === b.risk ? 0 : a.risk === "risk" ? -1 : 1));
}
