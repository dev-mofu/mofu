/** The text-only part of the secret scanner: no file system, no git, runs anywhere. */
import { KNOWN_TEST_KEYS, SECRET_FILES, SECRET_RULES, type SecretSeverity } from "./patterns.js";
import { findSeedPhrases, looksLikeWordlist } from "./seed.js";

export const IGNORE_MARKER = /mofu-secrets[:\s-]*ignore/i;

export function redact(value: string): string {
  const v = value.trim();
  if (v.length <= 12) return `${v.slice(0, 2)}…`;
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

export interface Hit {
  rule: string;
  title: string;
  severity: SecretSeverity;
  value: string;
  preview: string;
  confidence: "high" | "medium";
  line: number;
  note: string | null;
}

/** Every secret in one text. Lines with the ignore marker are skipped. */
export function scanText(text: string): Hit[] {
  const hits: Hit[] = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (index: number) => {
    let lo = 0,
      hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const lines = text.split("\n");
  const ignored = (line: number) => IGNORE_MARKER.test(lines[line - 1] ?? "");
  const seen = new Set<string>();
  for (const rule of SECRET_RULES) {
    for (const m of text.matchAll(rule.pattern)) {
      const value = m[1] ?? m[0];
      if (rule.valid && !rule.valid(value)) continue;
      const line = lineAt(m.index! + m[0].indexOf(value));
      const key = `${line}:${value}`;
      if (ignored(line) || seen.has(key)) continue;
      seen.add(key);
      const test =
        rule.id === "eth-private-key" &&
        KNOWN_TEST_KEYS.has(value.replace(/^0x/i, "").toLowerCase());
      hits.push({
        rule: rule.id,
        title: test ? "Public test private key (Hardhat/Anvil)" : rule.title,
        severity: test ? "low" : rule.severity,
        value,
        preview: rule.id === "pem-private-key" ? m[0] : redact(value),
        confidence: rule.severity === "medium" ? "medium" : "high",
        line,
        note: test ? "Anyone can use this key: never send real funds to its address." : null,
      });
    }
  }
  if (!looksLikeWordlist(text)) {
    for (const s of findSeedPhrases(text)) {
      const line = lineAt(s.index);
      if (ignored(line)) continue;
      hits.push({
        rule: "seed-phrase",
        title: s.knownTest ? "Public test seed phrase" : "Wallet seed phrase",
        severity: s.knownTest ? "low" : s.checksum ? "critical" : "high",
        value: s.words.join(" "),
        preview: `${s.words[0]} … ${s.words.at(-1)} (${s.words.length} words)`,
        confidence: s.checksum ? "high" : "medium",
        line,
        note: s.knownTest
          ? "A well-known test phrase: anyone can use it."
          : s.checksum
            ? "The words pass the BIP39 checksum: this is very likely a real recovery phrase."
            : null,
      });
    }
  }
  return hits;
}

export interface FileFinding {
  file: string;
  line: number;
  rule: string;
  title: string;
  severity: SecretSeverity;
  preview: string;
  confidence: "high" | "medium";
  note: string | null;
}

/**
 * Scans files given as text (for MCP clients and the browser, where there's no repository to
 * read). Also flags file names that are secrets by themselves, like a .env file.
 */
export function scanFiles(files: Array<{ path: string; content: string }>): FileFinding[] {
  const out: FileFinding[] = [];
  for (const f of files) {
    const name = f.path.split("\\").join("/");
    const named = SECRET_FILES.find((s) => s.pattern.test(name));
    if (named)
      out.push({
        file: name,
        line: 1,
        rule: "secret-file",
        title: named.title.replace(" is committed", ""),
        severity: named.severity,
        preview: name,
        confidence: "high",
        note: "Keep this file out of git (.gitignore).",
      });
    for (const h of scanText(f.content))
      out.push({
        file: name,
        line: h.line,
        rule: h.rule,
        title: h.title,
        severity: h.severity,
        preview: h.preview,
        confidence: h.confidence,
        note: h.note,
      });
  }
  const order: Record<SecretSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}
