/** Finds BIP39 seed phrases (wallet recovery words) in text. */
import { BIP39_ENGLISH } from "./bip39-english.js";
import { sha256 } from "./sha256.js";

const INDEX = new Map(BIP39_ENGLISH.map((w, i) => [w, i]));
const VALID_LENGTHS = [24, 21, 18, 15, 12];

/** Seed phrases from the Hardhat and BIP39 docs: public, but never fund them. */
const KNOWN_TEST = new Set([
  "test test test test test test test test test test test junk", // mofu-secrets: ignore
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", // mofu-secrets: ignore
]);

/** Whether the words carry a correct BIP39 checksum (random English words pass 1 time in 16). */
export function bip39Checksum(words: string[]): boolean {
  if (!VALID_LENGTHS.includes(words.length)) return false;
  let bits = "";
  for (const w of words) {
    const i = INDEX.get(w);
    if (i === undefined) return false;
    bits += i.toString(2).padStart(11, "0");
  }
  const csLen = words.length / 3;
  const entBits = bits.slice(0, bits.length - csLen);
  const entropy = new Uint8Array(entBits.length / 8);
  for (let i = 0; i < entropy.length; i++)
    entropy[i] = Number.parseInt(entBits.slice(i * 8, i * 8 + 8), 2);
  const hash = sha256(entropy);
  const hashBits = [...hash].map((b) => b.toString(2).padStart(8, "0")).join("");
  return hashBits.slice(0, csLen) === bits.slice(bits.length - csLen);
}

export interface SeedMatch {
  words: string[];
  /** Index of the first word in the text. */
  index: number;
  checksum: boolean;
  knownTest: boolean;
}

/** Words that look like a BIP39 wordlist file rather than a phrase: skip the whole text. */
export function looksLikeWordlist(text: string): boolean {
  let n = 0;
  for (const m of text.matchAll(/[a-z]+/g)) if (INDEX.has(m[0]) && ++n > 400) return true;
  return false;
}

/** Runs of 12+ consecutive wordlist words. The longest valid-length phrase in each run is kept. */
export function findSeedPhrases(text: string): SeedMatch[] {
  const out: SeedMatch[] = [];
  const words = [...text.matchAll(/[A-Za-z]+/g)];
  let run: Array<{ w: string; index: number; end: number }> = [];
  const flush = () => {
    if (run.length >= 12) {
      // try the longest valid length with a correct checksum first, else report the first 12
      let best: SeedMatch | null = null;
      for (const len of VALID_LENGTHS) {
        if (run.length < len) continue;
        for (let s = 0; s + len <= run.length; s++) {
          const ws = run.slice(s, s + len).map((r) => r.w);
          if (bip39Checksum(ws)) {
            best = {
              words: ws,
              index: run[s]!.index,
              checksum: true,
              knownTest: KNOWN_TEST.has(ws.join(" ")),
            };
            break;
          }
        }
        if (best) break;
      }
      const ws = run.slice(0, 12).map((r) => r.w);
      out.push(
        best ?? {
          words: ws,
          index: run[0]!.index,
          checksum: false,
          knownTest: KNOWN_TEST.has(ws.join(" ")),
        },
      );
    }
    run = [];
  };
  for (const m of words) {
    const w = m[0].toLowerCase();
    const prev = run.at(-1);
    // words must sit next to each other: only spaces, commas, quotes or a line break between
    const gapOk = !prev || /^[\s,'"`\-\d.)(:]*$/.test(text.slice(prev.end, m.index));
    if (m[0] === w && INDEX.has(w) && gapOk)
      run.push({ w, index: m.index!, end: m.index! + w.length });
    else {
      flush();
      if (m[0] === w && INDEX.has(w)) run.push({ w, index: m.index!, end: m.index! + w.length });
    }
  }
  flush();
  return out;
}
