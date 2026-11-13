/**
 * Transaction preview: what Mofu's simulation on Robinhood Chain says a transaction does to your
 * wallet, and what's worth a warning in it. The simulation itself runs on mofu.works; this file
 * is pure (builds the request, reads the answer).
 */
import { short, type Analysis, type Finding } from "./decode.js";

export interface PreviewChange {
  asset: string;
  kind: "eth" | "token" | "nft";
  symbol: string | null;
  direction: "in" | "out";
  amount: string;
  tokenId: string | null;
}

export interface PreviewApproval {
  token: string;
  symbol: string | null;
  spender: string;
  kind: "token" | "nft";
  revoke: boolean;
  unlimited: boolean;
  amount: string;
}

export interface TxPreview {
  status: "ok" | "reverted";
  error: string | null;
  failedCall: number | null;
  changes: PreviewChange[];
  approvals: PreviewApproval[];
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const hexValue = (v: unknown) =>
  typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) && v.length > 2
    ? v
    : typeof v === "number" && Number.isSafeInteger(v) && v >= 0
      ? `0x${v.toString(16)}`
      : "0x0";

/** The body for /api/guard/preview, or null when the request isn't a transaction Mofu can simulate. */
export function previewRequest(
  method: string,
  params: unknown[],
): { from: string; calls: Array<{ to: string; data: string; value: string }> } | null {
  const call = (c: Record<string, unknown>) => {
    const to = typeof c.to === "string" ? c.to : "";
    if (!ADDRESS.test(to)) return null;
    const data = typeof c.data === "string" ? c.data : typeof c.input === "string" ? c.input : "0x";
    return { to: to.toLowerCase(), data: data || "0x", value: hexValue(c.value) };
  };
  const p = (params[0] ?? {}) as Record<string, unknown>;
  const from = typeof p.from === "string" && ADDRESS.test(p.from) ? p.from.toLowerCase() : null;
  if (!from) return null;
  if (method === "eth_sendTransaction") {
    const c = call(p);
    return c ? { from, calls: [c] } : null;
  }
  if (method === "wallet_sendCalls" && Array.isArray(p.calls)) {
    const calls = (p.calls as Array<Record<string, unknown>>).slice(0, 10).map(call);
    return calls.length && calls.every((c) => c)
      ? { from, calls: calls as NonNullable<(typeof calls)[number]>[] }
      : null;
  }
  return null;
}

/** "− 0.5 ETH", "+ 1,200 PEPU", "− NFT #12 of PKIT". */
export function changeText(c: PreviewChange): string {
  const sign = c.direction === "out" ? "−" : "+";
  const name = c.symbol ?? short(c.asset);
  if (c.kind === "nft")
    return `${sign} ${c.amount === "1" ? "NFT" : `${c.amount} NFTs`}${c.tokenId ? ` #${c.tokenId}` : ""} of ${name}`;
  return `${sign} ${c.amount} ${name}`;
}

/** Findings from the preview, and whether it alone is a reason to stop and show the panel. */
export function judgePreview(
  analyses: Analysis[],
  p: TxPreview,
): { findings: Finding[]; prompt: boolean } {
  const findings: Finding[] = [];
  let prompt = false;
  if (p.status === "reverted") {
    findings.push({
      level: "warn",
      text: `Mofu's simulation says this transaction would fail${p.error ? ` (${p.error})` : ""}. Your wallet may still charge gas for it.`,
    });
    prompt = true;
  }
  // Approvals the request itself shows (decoded locally) versus the ones the simulation saw.
  const shown = new Set(
    analyses
      .filter((a) => a.token && a.spender)
      .map((a) => `${a.token!.toLowerCase()}:${a.spender!.toLowerCase()}`),
  );
  for (const a of p.approvals) {
    if (a.revoke || shown.has(`${a.token}:${a.spender}`)) continue;
    findings.push({
      level: "risk",
      text: `This transaction also lets ${short(a.spender)} spend ${a.amount === "every item" ? "every item" : a.amount} of your ${a.symbol ?? short(a.token)}. The request itself doesn't say so.`,
    });
    prompt = true;
  }
  const outs = p.changes.filter((c) => c.direction === "out");
  const ins = p.changes.filter((c) => c.direction === "in");
  const plainCalls = analyses.length > 0 && analyses.every((a) => a.kind === "call");
  if (p.status === "ok" && plainCalls && outs.length && !ins.length) {
    findings.push({
      level: "warn",
      text: `You give ${outs.map((c) => changeText(c).slice(2)).join(", ")} and get nothing back in this transaction.`,
    });
    prompt = true;
  }
  return { findings, prompt };
}
