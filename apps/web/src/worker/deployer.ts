/**
 * Deployer reputation: who created the token and what Mofu found in the other tokens they
 * launched. Launches come from the creator's recent transactions (the report's origin) and from
 * tokens Mofu scanned earlier that had the same creator. Deterministic; no model.
 */
import type {
  DeployerReputation,
  DeployerToken,
  TokenCheck,
  TokenScanReport,
} from "../shared/api.js";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const tag = (t: DeployerToken) => `${t.symbol ? `$${t.symbol} ` : ""}(${short(t.address)})`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** This many other launches in the creator's recent history is a farm, whatever they turned out to be. */
const SERIAL = 10;

/** Builds the reputation from what's known of the creator's other tokens. Null without an origin. */
export function deployerReputation(
  r: TokenScanReport,
  known: DeployerToken[],
): DeployerReputation | null {
  const o = r.origin;
  if (!o) return null;
  // Tickers Mofu doesn't have yet come from the launch details read off the chain.
  const tickers = new Map((o.otherLaunchDetails ?? []).map((l) => [l.address.toLowerCase(), l]));
  const others = known
    .filter((t) => t.address.toLowerCase() !== r.address.toLowerCase())
    .map((t) =>
      t.symbol ? t : { ...t, symbol: tickers.get(t.address.toLowerCase())?.symbol ?? null },
    );
  const honeypots = others.filter((t) => t.honeypot);
  const rest = others.filter((t) => !t.honeypot);
  const risky = rest.filter((t) => t.verdict === "risky");
  const caution = rest.filter((t) => t.verdict === "caution");
  const clean = rest.filter((t) => t.verdict === "clean");
  const unscanned = rest.filter((t) => t.verdict === null);
  const scanned = others.length - unscanned.length;
  const launches = Math.max(others.length, o.otherLaunchCount);
  const details = o.otherLaunchDetails ?? [];
  const quietOf = details.length || null;
  const quiet = quietOf ? details.filter((l) => !l.active).length : null;
  const who = `This creator (${short(o.creator)})`;

  let status: DeployerReputation["status"] = "ok";
  let detail: string;
  if (honeypots.length) {
    status = "risk";
    detail = `${who} launched ${plural(honeypots.length, "other token")} where Mofu's simulated sell failed or the code matches known honeypots, for example ${tag(honeypots[0]!)}.`;
  } else if (risky.length >= 2) {
    status = "warn";
    detail = `${who} launched ${plural(risky.length, "other token")} Mofu rated risky, for example ${tag(risky[0]!)}.`;
  } else if (launches >= SERIAL) {
    status = "warn";
    detail = `${who} launched ${launches} other tokens in its recent history. Launching that many is typical of pump-and-dump farms, where each token is bought early and dropped.${scanned ? ` Mofu has scanned ${scanned} of them${risky.length ? `, ${risky.length} rated risky` : ", none failed the sell test"}.` : ""}`;
  } else if (launches >= 5 && quietOf !== null && quietOf >= 3 && quiet! / quietOf >= 0.8) {
    status = "warn";
    detail = `${who} launched ${launches} other tokens recently, and ${quiet} of the ${quietOf} looked at have gone quiet (no activity in a week). Many fast launches that die quickly is a common pump-and-dump pattern.`;
  } else if (launches === 0) {
    const age =
      o.creatorAgeDays === null
        ? ""
        : o.creatorAgeDays === 0
          ? " The wallet was first active the same day."
          : ` The wallet is ${plural(o.creatorAgeDays, "day")} old.`;
    detail = `No other launches by ${short(o.creator)} found in its recent history.${age}`;
  } else {
    const found = scanned
      ? `Mofu has scanned ${scanned}: none failed the sell test${risky.length ? `, ${risky.length} rated risky` : ""}${caution.length ? `, ${caution.length} caution` : ""}${clean.length ? `, ${clean.length} clean` : ""}.`
      : "Mofu hasn't scanned any of them yet.";
    const q =
      quietOf === null
        ? ""
        : quiet === 0
          ? ` ${quietOf === 1 ? "It was" : `All ${quietOf} looked at were`} active this week.`
          : ` ${quiet} of the ${quietOf} looked at had no activity this week.`;
    detail = `${who} launched ${plural(launches, "other token")}. ${found}${q}`;
  }

  return {
    creator: o.creator,
    status,
    launches,
    scanned,
    honeypots: honeypots.length,
    risky: risky.length,
    caution: caution.length,
    clean: clean.length,
    quiet,
    quietOf,
    tokens: [...honeypots, ...risky, ...caution, ...clean, ...unscanned].slice(0, 6),
    detail,
  };
}

export const deployerCheck = (d: DeployerReputation): TokenCheck => ({
  id: "deployer",
  label: "What else did the creator launch?",
  status: d.status,
  detail: d.detail,
});
