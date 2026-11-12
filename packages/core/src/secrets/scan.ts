/**
 * `mofu secrets`: finds keys, tokens and seed phrases in a repository's files and in its git
 * history. Deterministic, local, no network. Values are never printed in full.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { execProgram } from "../tools/git.js";
import { KNOWN_TEST_KEYS, SECRET_FILES, SECRET_RULES, type SecretSeverity } from "./patterns.js";
import { findSeedPhrases, looksLikeWordlist } from "./seed.js";

export const IGNORE_MARKER = /mofu-secrets[:\s-]*ignore/i;
const SKIP_PATH =
  /(^|\/)(node_modules|dist|build|\.git|vendor|coverage)\/|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock)$/;
const MAX_FILE_BYTES = 1_000_000;

export interface SecretLocation {
  file: string;
  line: number;
  /** Set for a hit found in history: the commit that added it. */
  commit?: string;
  date?: string;
}

export interface SecretFinding {
  rule: string;
  title: string;
  severity: SecretSeverity;
  /** The value with everything but its ends hidden. */
  preview: string;
  /** "high" for exact formats and seed phrases with a valid checksum. */
  confidence: "high" | "medium";
  /** Where it is in the files now (empty when it's only in history). */
  inFiles: SecretLocation[];
  /** The oldest commit that added it, when history was scanned. */
  firstCommit: SecretLocation | null;
  note: string | null;
}

export interface SecretsReport {
  root: string;
  filesScanned: number;
  commitsScanned: number;
  historyScanned: boolean;
  findings: SecretFinding[];
  /** What the scan couldn't cover. */
  limits: string[];
}

export function redact(value: string): string {
  const v = value.trim();
  if (v.length <= 12) return `${v.slice(0, 2)}…`;
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

interface Hit {
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

const fingerprint = (rule: string, value: string) =>
  createHash("sha256").update(`${rule}\0${value}`).digest("hex").slice(0, 16);

async function git(root: string, args: string[]) {
  const r = await execProgram("git", args, root, 120_000);
  return r.code === 0 ? r.stdout : null;
}

/** Tracked files plus untracked ones that aren't ignored (they'd go in with `git add .`). */
async function filesToScan(root: string): Promise<string[] | null> {
  const out = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (out === null) return null;
  return out.split("\0").filter((f) => f && !SKIP_PATH.test(f));
}

export interface SecretsOptions {
  /** Scan git history too (default true). */
  history?: boolean;
  /** Only commits in this range, e.g. "origin/main..HEAD". */
  range?: string;
  /** Stop reading history after this many commits (default 5000). */
  maxCommits?: number;
}

/** Scans a repository (or a plain folder: then only the files). */
export async function scanSecrets(
  root: string,
  options: SecretsOptions = {},
): Promise<SecretsReport> {
  const limits: string[] = [];
  const merged = new Map<string, SecretFinding>();
  const add = (h: Hit, loc: SecretLocation, inFiles: boolean) => {
    const id = fingerprint(h.rule, h.value);
    let f = merged.get(id);
    if (!f) {
      f = {
        rule: h.rule,
        title: h.title,
        severity: h.severity,
        preview: h.preview,
        confidence: h.confidence,
        inFiles: [],
        firstCommit: null,
        note: h.note,
      };
      merged.set(id, f);
    }
    if (inFiles) {
      if (f.inFiles.length < 20) f.inFiles.push(loc);
    } else f.firstCommit = loc; // history runs newest first: the last one seen is the oldest
  };

  const tracked = await filesToScan(root);
  const isRepo = tracked !== null;
  if (!isRepo) limits.push("Not a git repository: only the files were scanned, without history.");
  const files = tracked ?? (await walk(root));
  let filesScanned = 0;
  for (const rel of files) {
    const abs = path.join(root, rel);
    const st = await stat(abs).catch(() => null);
    if (!st?.isFile()) continue;
    const named = SECRET_FILES.find((s) => s.pattern.test(rel.replace(/\\/g, "/")));
    if (named && isRepo) {
      const tracked = (await git(root, ["ls-files", "--error-unmatch", rel])) !== null;
      if (tracked)
        add(
          {
            rule: "secret-file",
            title: named.title,
            severity: named.severity,
            value: `file:${rel}`,
            preview: rel,
            confidence: "high",
            line: 1,
            note: "Remove it from git (git rm --cached) and add it to .gitignore.",
          },
          { file: rel, line: 1 },
          true,
        );
    }
    if (st.size > MAX_FILE_BYTES) continue;
    const buf = await readFile(abs).catch(() => null);
    if (!buf || buf.subarray(0, 8000).includes(0)) continue;
    filesScanned++;
    for (const h of scanText(buf.toString("utf8"))) add(h, { file: rel, line: h.line }, true);
  }

  let commitsScanned = 0;
  const wantHistory = isRepo && options.history !== false;
  if (wantHistory) {
    commitsScanned = await scanHistory(root, options, (h, loc) => add(h, loc, false), limits);
  }

  const order: Record<SecretSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const findings = [...merged.values()].sort(
    (a, b) =>
      order[a.severity] - order[b.severity] ||
      Number(b.inFiles.length > 0) - Number(a.inFiles.length > 0),
  );
  for (const f of findings) {
    if (f.inFiles.length === 0 && f.firstCommit && !f.note)
      f.note =
        "Removed from the files, but still in git history: anyone with the repo can read it. Rotate it.";
  }
  return { root, filesScanned, commitsScanned, historyScanned: wantHistory, findings, limits };
}

async function walk(root: string, rel = "", out: string[] = []): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (SKIP_PATH.test(`${p}/`) || SKIP_PATH.test(p)) continue;
    if (e.isDirectory()) await walk(root, p, out);
    else if (e.isFile()) out.push(p);
    if (out.length > 20_000) break;
  }
  return out;
}

/** Reads `git log -p` as a stream and scans every added line. Returns the commits read. */
function scanHistory(
  root: string,
  options: SecretsOptions,
  onHit: (h: Hit, loc: SecretLocation) => void,
  limits: string[],
): Promise<number> {
  const maxCommits = options.maxCommits ?? 5000;
  const args = ["log", "-p", "-U0", "--no-color", "--no-ext-diff", "--format=%x00commit %H %cI"];
  args.push(options.range ? options.range : "--all");
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: root, windowsHide: true });
    const rl = createInterface({ input: child.stdout });
    let commits = 0,
      commit = "",
      date = "",
      file = "",
      line = 0,
      skipFile = false;
    let chunk: string[] = [],
      chunkStart = 0;
    const flush = () => {
      if (chunk.length && !skipFile) {
        const text = chunk.join("\n");
        for (const h of scanText(text))
          onHit(h, { file, line: chunkStart + h.line - 1, commit, date });
      }
      chunk = [];
    };
    rl.on("line", (l) => {
      if (l.startsWith("\0commit ")) {
        flush();
        if (++commits > maxCommits) {
          limits.push(`History stopped after ${maxCommits} commits.`);
          rl.close();
          child.kill();
          return;
        }
        [, commit = "", date = ""] = l.slice(1).split(" ");
      } else if (l.startsWith("+++ ")) {
        flush();
        file = l.startsWith("+++ b/") ? l.slice(6) : "";
        skipFile = !file || SKIP_PATH.test(file);
      } else if (l.startsWith("@@")) {
        flush();
        const m = /\+(\d+)/.exec(l);
        line = m ? Number(m[1]) : 0;
        chunkStart = line;
      } else if (l.startsWith("+")) {
        chunk.push(l.slice(1));
      } else if (!l.startsWith("-") && !l.startsWith("\\")) {
        flush();
      }
    });
    rl.on("close", () => {
      flush();
      resolve(Math.min(commits, maxCommits));
    });
    child.on("error", () => resolve(0));
  });
}
