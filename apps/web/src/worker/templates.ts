/**
 * Standard code, or custom? Recognizes the Pons launchpad's standard token code by fingerprint,
 * and for anything else lists the functions beyond a plain token, read from the dispatcher. Also
 * the upgrade diff: what an implementation swap added and removed.
 */
import type { TokenCheck } from "../shared/api.js";
import { rpcBatch } from "./chain.js";
import { customFunctions, dispatcherSelectors, nameOf } from "./signatures.js";

/** Every Pons launch Mofu has scanned runs this code (fingerprint of the runtime code). */
export const PONS_TOKEN_FINGERPRINT = "282e8b47cfc27b4ba0328b0b37e99100";
/** Functions that only make sense for taking tokens or faking balances. */
const EGREGIOUS = new Set(["setBalance(address,uint256)", "setAllowance(address,address,uint256)"]);

export interface CodeFacts {
  standard: "pons" | null;
  functions: number;
  named: string[];
  unknown: number;
}

const list = (names: string[]) =>
  names.length <= 6
    ? names.join(", ")
    : `${names.slice(0, 6).join(", ")} and ${names.length - 6} more`;

/** The check and its facts. Null when the code's functions can't be read. */
export function codeCheck(
  fingerprint: string | null,
  logicCode: string,
  proxied: boolean,
): { check: TokenCheck; facts: CodeFacts } | null {
  const label = "Standard code, or custom?";
  if (fingerprint === PONS_TOKEN_FINGERPRINT)
    return {
      check: {
        id: "code",
        label,
        status: "ok",
        detail:
          "Standard code. It runs the Pons launchpad's standard token code, the same as every Pons launch Mofu has scanned: no custom functions.",
      },
      facts: {
        standard: "pons",
        functions: dispatcherSelectors(logicCode).length,
        named: [],
        unknown: 0,
      },
    };
  const selectors = dispatcherSelectors(logicCode);
  if (selectors.length === 0) return null;
  const { named, unknown } = customFunctions(selectors);
  const facts: CodeFacts = {
    standard: null,
    functions: selectors.length,
    named,
    unknown: unknown.length,
  };
  const where = proxied ? "Its current code (behind the proxy)" : "It";
  if (!named.length && !unknown.length)
    return {
      check: {
        id: "code",
        label,
        status: "ok",
        detail: `${where} has only the functions of a plain token.`,
      },
      facts,
    };
  const bad = named.filter((n) => EGREGIOUS.has(n));
  const parts = [
    named.length
      ? `${named.length} named function${named.length === 1 ? "" : "s"} beyond a plain token (${list(named)})`
      : "",
    unknown.length ? `${unknown.length} that Mofu can't name` : "",
  ].filter(Boolean);
  return {
    check: {
      id: "code",
      label,
      status: bad.length ? "warn" : "info",
      detail: `Custom code. ${where} has ${parts.join(" and ")}.${bad.length ? ` ${list(bad)} can rewrite balances or allowances directly, which an honest token never needs.` : ""}${unknown.length ? " Unnamed functions aren't necessarily bad, but switches hide among them; the checks above look for the ones that matter." : ""}`,
    },
    facts,
  };
}

/** What changed between two implementations' functions. Pure. */
export function functionDiff(oldCode: string, newCode: string) {
  const a = new Set(dispatcherSelectors(oldCode));
  const b = new Set(dispatcherSelectors(newCode));
  const added = [...b].filter((s) => !a.has(s));
  const removed = [...a].filter((s) => !b.has(s));
  const named = (xs: string[]) =>
    xs
      .map(nameOf)
      .filter((n): n is string => !!n)
      .sort();
  return {
    added: named(added),
    addedUnknown: added.filter((s) => !nameOf(s)).length,
    removed: named(removed),
    removedUnknown: removed.filter((s) => !nameOf(s)).length,
  };
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** A sentence about an upgrade, with what it added and removed when the code can be read. */
export async function upgradeSummary(
  urls: readonly string[],
  fetchFn: typeof fetch,
  from: string | null,
  to: string | null,
): Promise<{ text: string; risky: boolean }> {
  const head = `The contract's code was swapped (implementation ${from ? short(from) : "none"} → ${to ? short(to) : "none"}).`;
  if (!from || !to) return { text: head, risky: true };
  try {
    const [oldCode, newCode] = await rpcBatch(
      urls,
      [
        { method: "eth_getCode", params: [from, "latest"] },
        { method: "eth_getCode", params: [to, "latest"] },
      ],
      fetchFn,
    );
    if (!oldCode || !newCode || oldCode === "0x" || newCode === "0x")
      return { text: head, risky: true };
    const d = functionDiff(oldCode, newCode);
    const bits = [
      d.added.length || d.addedUnknown
        ? `Added: ${[...d.added, ...(d.addedUnknown ? [`${d.addedUnknown} unnamed`] : [])].join(", ")}.`
        : "",
      d.removed.length || d.removedUnknown
        ? `Removed: ${[...d.removed, ...(d.removedUnknown ? [`${d.removedUnknown} unnamed`] : [])].join(", ")}.`
        : "",
    ].filter(Boolean);
    const risky = d.added.some((n) =>
      /^(mint|blacklist|addToBlacklist|setBlacklist|setBot|setBots|addBots|freeze|pause|setFee|setFees|setTax|setBuyFee|setSellFee|setBuyTax|setSellTax|setBalance|setAllowance|setMaxTxAmount|setMaxWallet)/.test(
        n,
      ),
    );
    return {
      text: bits.length
        ? `${head} ${bits.join(" ")}`
        : `${head} The list of functions stayed the same; what they do may have changed.`,
      risky: risky || d.addedUnknown > 0,
    };
  } catch {
    return { text: head, risky: true };
  }
}
