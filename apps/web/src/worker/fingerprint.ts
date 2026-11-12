/**
 * "Seen this code before": scammers redeploy the same honeypot contract under new names. Mofu
 * fingerprints each contract's code and remembers which fingerprints belonged to tokens whose
 * simulated sell failed, then flags new tokens built from the same code.
 *
 * The fingerprint skips what changes between deployments of the same source: the compiler's
 * metadata at the end, and constants of 20 bytes or more pushed by the code (addresses and other
 * immutables baked in at deploy time).
 */
import type { CodeMatch, TokenCheck, TokenScanReport } from "../shared/api.js";
import type { TokenIndex } from "./stats.js";

const toBytes = (hex: string) => {
  const h = hex.replace(/^0x/, "");
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** The code with metadata cut and long constants zeroed. */
export function codeSkeleton(code: Uint8Array): Uint8Array {
  let end = code.length;
  // Solidity/Vyper append CBOR metadata whose length sits in the last two bytes.
  if (end >= 2) {
    const len = (code[end - 2]! << 8) | code[end - 1]!;
    const start = end - 2 - len;
    if (len > 0 && start >= 0 && (code[start]! & 0xe0) === 0xa0) end = start;
  }
  const out = code.slice(0, end);
  for (let i = 0; i < end; i++) {
    const op = out[i]!;
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (n >= 20) out.fill(0, i + 1, Math.min(end, i + 1 + n));
      i += n;
    }
  }
  return out;
}

/** 32 hex characters (the first 16 bytes of SHA-256 of the skeleton). Null for empty code. */
export async function codeFingerprint(code: string | null | undefined): Promise<string | null> {
  if (!code || code === "0x" || code.toLowerCase().startsWith("0xef0100")) return null;
  const digest = await crypto.subtle.digest("SHA-256", codeSkeleton(toBytes(code)));
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** What a scan says about its own code: a failed sell is the evidence that counts. */
export function codeOutcome(r: TokenScanReport): "failed" | "passed" | null {
  if (!r.sellTest || r.sellTest.status === "unknown") return null;
  const worst = Math.max(r.sellTest.buyTaxPercent ?? 0, r.sellTest.sellTaxPercent ?? 0);
  return r.sellTest.status === "failed" || worst >= 50 ? "failed" : "passed";
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const verdictOf = (checks: TokenCheck[]): TokenScanReport["verdict"] =>
  checks.some((c) => c.status === "risk")
    ? "risky"
    : checks.some((c) => c.status === "warn")
      ? "caution"
      : "clean";

/**
 * Looks the fingerprint up, adds the check when it matches honeypots, and remembers this token's
 * own outcome for later scans. Never throws.
 */
export async function withCodeMatch(
  r: TokenScanReport,
  index: TokenIndex | null,
): Promise<TokenScanReport> {
  if (!r.fingerprint || !index?.codeMatches) return { ...r, codeMatch: r.codeMatch ?? null };
  const match: CodeMatch | null = await index
    .codeMatches(r.fingerprint, r.address)
    .catch(() => null);
  const outcome = codeOutcome(r);
  if (outcome && index.noteCode) {
    // Remember this one (only when its sell was actually simulated). Errors don't matter here.
    await index
      .noteCode(r.fingerprint, { address: r.address, symbol: r.token.symbol, outcome })
      .catch(() => undefined);
  }
  const checks = r.checks.filter((c) => c.id !== "fingerprint");
  // Flag only when honeypots outnumber tokens of the same code that sold fine: a widely used
  // template (a launchpad's standard token) isn't suspicious because one copy misbehaved.
  if (match && match.flagged > 0 && match.flagged >= match.passed) {
    const ex = match.examples[0];
    const example = ex
      ? `, for example ${ex.symbol ? `$${ex.symbol} ` : ""}(${short(ex.address)})`
      : "";
    const ownSellFine = outcome === "passed";
    checks.push({
      id: "fingerprint",
      label: "Seen this code before?",
      status: ownSellFine ? "warn" : "risk",
      detail:
        `Yes. This contract's code matches ${match.flagged} token${match.flagged === 1 ? "" : "s"} where Mofu's simulated sell failed${example}. ` +
        (ownSellFine
          ? "This one sold fine in the test, but the same code has trapped buyers before: the switch may not be flipped yet."
          : "Same code under a new name is a common honeypot trick."),
    });
  }
  return {
    ...r,
    checks,
    verdict: verdictOf(checks),
    codeMatch: match && match.flagged > 0 ? match : null,
  };
}
