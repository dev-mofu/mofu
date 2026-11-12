/**
 * Address poisoning: scammers make an address whose first and last characters match one you use,
 * then plant it in your history with a tiny or zero-value transfer, hoping you copy it next time.
 * Mofu Guard remembers who you've sent to (in this browser only) and stops a send to a lookalike.
 */
import type { Analysis } from "./decode.js";

const ADDRESS = /^0x[0-9a-f]{40}$/;

/** Same first 4 and last 4 hex characters, but a different address. */
export function looksLike(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (!ADDRESS.test(x) || !ADDRESS.test(y) || x === y) return false;
  return x.slice(2, 6) === y.slice(2, 6) && x.slice(-4) === y.slice(-4);
}

/** The known address `target` imitates, if any. */
export function imitates(target: string, known: Iterable<string>): string | null {
  for (const k of known) if (looksLike(target, k)) return k.toLowerCase();
  return null;
}

/**
 * Adds a stop to sends whose recipient imitates an address the user has sent to before, or the
 * user's own address.
 */
export function withPoisonCheck(
  a: Analysis,
  known: { recipients: Iterable<string>; self: string | null },
): Analysis {
  if ((a.kind !== "send" && a.kind !== "transfer") || !a.target) return a;
  const target = a.target.toLowerCase();
  const self = known.self?.toLowerCase() ?? null;
  const twinOfSelf = self && looksLike(target, self) ? self : null;
  const twin = twinOfSelf ?? imitates(target, known.recipients);
  if (!twin) return a;
  return {
    ...a,
    prompt: true,
    findings: [
      {
        level: "risk",
        // Full addresses: shortened, a lookalike and the real one look identical (that's the trick).
        text: twinOfSelf
          ? `This looks like your own address but isn't. Sending to ${target}, your address is ${twin}. Scammers make lookalikes of your address and plant them in your history. Check every character.`
          : `This looks like an address you've sent to before, but it's a different one. Sending to ${target}, you sent to ${twin} before. Scammers plant lookalikes in your history with tiny transfers. Copy the address from its source, not from your history.`,
      },
      ...a.findings,
    ],
  };
}

/** Recipients worth remembering after a send went ahead. */
export const sentTo = (analyses: Analysis[]) =>
  analyses
    .filter(
      (a) =>
        (a.kind === "send" || a.kind === "transfer") &&
        a.target &&
        ADDRESS.test(a.target.toLowerCase()),
    )
    .map((a) => a.target!.toLowerCase());

/** Keeps the newest `max` unique addresses, newest first. */
export function rememberRecipients(list: string[], add: string[], max = 300): string[] {
  const out = [...add.map((a) => a.toLowerCase()), ...list.map((a) => a.toLowerCase())];
  return [...new Set(out)].slice(0, max);
}
