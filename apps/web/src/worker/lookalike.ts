/**
 * Copycat alert: other tokens with the same name or ticker that Mofu has seen (scans, Mofu Guard
 * checks, wallet holdings), which of them came first, and a hard warning for anything that uses
 * the $MOFU name without being the official contract.
 */
import type { TokenCheck, TokenLookalike, TokenScanReport } from "../shared/api.js";
import type { ChainDataOptions } from "./chain-data.js";
import { withCodeMatch } from "./fingerprint.js";
import { withLaunchChecks } from "./launch.js";
import { MOFU_TOKEN } from "./known.js";
import { normalizeName, type TokenIndex } from "./stats.js";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

async function firstTx(o: ChainDataOptions, address: string): Promise<string | null> {
  try {
    const res = await o.fetch(
      `https://api.covalenthq.com/v1/${o.chain}/address/${address}/transactions_summary/`,
      {
        headers: { Authorization: `Bearer ${o.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      },
    );
    const body = (await res.json()) as {
      data?: { items?: Array<{ earliest_transaction?: { block_signed_at?: string } }> };
    };
    return body.data?.items?.[0]?.earliest_transaction?.block_signed_at ?? null;
  } catch {
    return null;
  }
}

const verdictOf = (checks: TokenCheck[]): TokenScanReport["verdict"] =>
  checks.some((c) => c.status === "risk")
    ? "risky"
    : checks.some((c) => c.status === "warn")
      ? "caution"
      : "clean";

/**
 * Adds what Mofu knows from other scans: lookalikes with the "Is it the real one?" check, and
 * "Seen this code before?" for code shared with known honeypots. Never throws.
 */
export async function withLookalikes(
  r: TokenScanReport,
  index: TokenIndex | null,
  data: ChainDataOptions | undefined,
): Promise<TokenScanReport> {
  const coded = await withCodeMatch(await lookalikesOnly(r, index, data), index);
  return withLaunchChecks(coded, index, data);
}

async function lookalikesOnly(
  r: TokenScanReport,
  index: TokenIndex | null,
  data: ChainDataOptions | undefined,
): Promise<TokenScanReport> {
  if (!r.isContract || !(r.token.name || r.token.symbol)) return r;
  const checks = r.checks.filter((c) => c.id !== "lookalike");
  const fakeMofu =
    r.address !== MOFU_TOKEN &&
    (normalizeName(r.token.symbol) === "MOFU" || normalizeName(r.token.name) === "MOFU");

  let seen: Array<{ address: string; name: string | null; symbol: string | null }>;
  try {
    seen = index ? await index.similar(r.token.name, r.token.symbol, r.address) : [];
  } catch {
    // No index (tests, local runs) or it failed: the check just goes without lookalikes.
    seen = [];
  }
  const candidates = seen.slice(0, 4);
  let lookalikes: TokenLookalike[] = candidates.map((t) => ({ ...t, createdAt: null }));
  let mine: string | null = r.origin?.createdAt ?? null;
  if (data && candidates.length) {
    const [own, ...theirs] = await Promise.all([
      mine ? Promise.resolve(mine) : firstTx(data, r.address),
      ...candidates.map((t) => firstTx(data, t.address)),
    ]);
    mine = own ?? null;
    lookalikes = candidates.map((t, i) => ({ ...t, createdAt: theirs[i] ?? null }));
  }

  let check: TokenCheck | null = null;
  if (fakeMofu) {
    check = {
      id: "lookalike",
      label: "Is this the real one?",
      status: "risk",
      detail: `No. This token uses the $MOFU name, but it isn't the official $MOFU contract (${MOFU_TOKEN}). Check mofu.works/verify before you buy anything called MOFU.`,
    };
  } else if (lookalikes.length) {
    const older = lookalikes
      .filter((l) => l.createdAt && mine && Date.parse(l.createdAt) < Date.parse(mine))
      .sort((a, b) => Date.parse(a.createdAt!) - Date.parse(b.createdAt!));
    const first = older[0];
    const n = lookalikes.length;
    check = first
      ? {
          id: "lookalike",
          label: "Is this the real one?",
          status: "warn",
          detail: `Another token with the same name or ticker came first: ${first.name ?? first.symbol ?? "a token"} at ${short(first.address)}, created ${day(first.createdAt!)}. Mofu has seen ${n} other token${n === 1 ? "" : "s"} like this. Make sure this is the contract the project itself links to.`,
        }
      : {
          id: "lookalike",
          label: "Is this the real one?",
          status: "info",
          detail: `Mofu has seen ${n} other token${n === 1 ? "" : "s"} with the same name or ticker${mine && lookalikes.every((l) => l.createdAt) ? ", and this one is the oldest of them" : ""}. Make sure this is the contract the project itself links to.`,
        };
  }
  if (check) checks.push(check);
  return { ...r, checks, verdict: verdictOf(checks), lookalikes };
}
