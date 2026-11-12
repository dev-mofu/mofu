/**
 * Builder tools: `mofu secrets`, `mofu audit`, `mofu review` and `mofu ci` (what the GitHub
 * Action runs). Secrets, audit and ci are deterministic; review makes one model call.
 */
import { modelTarget } from "./target.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import {
  auditPath,
  commitText,
  writeCommitMessage,
  writePullRequest,
  createModel,
  defaultBranch,
  execProgram,
  githubReviewPayload,
  reviewDiff,
  scanSecrets,
  scanWorkspace,
  type AuditReport,
  type Review,
  type ScanReport,
  type SecretFinding,
  type SecretsReport,
} from "@mofu/core";
import type { AuditArgs, CiArgs, CommitArgs, PrArgs, ReviewArgs, SecretsArgs } from "./args.js";
import type { Printer } from "./ui.js";

export const EXIT_FOUND = 2;

const SEV = {
  critical: (s: string) => pc.bold(pc.red(s)),
  high: pc.red,
  medium: pc.yellow,
  low: pc.dim,
};

/** Findings that should fail a run: anything but public test keys. */
export const realSecrets = (r: SecretsReport) => r.findings.filter((f) => f.severity !== "low");

// ---------------------------------------------------------------- secrets

export function formatSecrets(r: SecretsReport): string[] {
  const out: string[] = [];
  const where = r.historyScanned
    ? `${r.filesScanned} files and ${r.commitsScanned} commits`
    : `${r.filesScanned} files`;
  if (r.findings.length === 0) {
    out.push(pc.green(`No secrets found in ${where}.`));
  } else {
    const real = realSecrets(r).length;
    out.push(
      real
        ? pc.red(pc.bold(`${real} possible secret${real === 1 ? "" : "s"} found in ${where}.`))
        : pc.yellow(`Only public test keys found in ${where}.`),
      "",
    );
    for (const f of r.findings) {
      out.push(
        `${SEV[f.severity](f.severity.toUpperCase().padEnd(8))} ${pc.bold(f.title)}  ${pc.dim(f.preview)}`,
      );
      for (const l of f.inFiles.slice(0, 3)) out.push(`         ${l.file}:${l.line}`);
      if (f.inFiles.length > 3)
        out.push(pc.dim(`         …and ${f.inFiles.length - 3} more places`));
      if (f.firstCommit)
        out.push(
          pc.dim(
            `         first committed in ${f.firstCommit.commit?.slice(0, 8)} (${f.firstCommit.date?.slice(0, 10)}) ${f.firstCommit.file}:${f.firstCommit.line}`,
          ),
        );
      if (f.note) out.push(pc.dim(`         ${f.note}`));
    }
    out.push(
      "",
      pc.dim(
        "A leaked key stays usable until you revoke it at the provider; deleting the line isn't enough.",
      ),
      pc.dim("A leaked wallet key or seed phrase: move the funds to a new wallet now."),
      pc.dim('False alarm? Add "mofu-secrets: ignore" in a comment on that line.'),
    );
  }
  for (const l of r.limits) out.push(pc.dim(l));
  return out;
}

export async function runSecrets(args: SecretsArgs, printer: Printer): Promise<number> {
  const root = path.resolve(args.path ?? ".");
  if (!args.json)
    printer.line(pc.dim(args.history ? "Scanning files and git history…" : "Scanning files…"));
  const r = await scanSecrets(root, {
    history: args.history,
    ...(args.range && { range: args.range }),
  });
  if (args.json) printer.line(JSON.stringify(r, null, 2));
  else for (const l of formatSecrets(r)) printer.line(l);
  return realSecrets(r).length ? EXIT_FOUND : 0;
}

// ---------------------------------------------------------------- audit

const STATUS = { ok: pc.green("✓"), info: pc.dim("·"), warn: pc.yellow("!"), risk: pc.red("✗") };
const VERDICT = {
  clean: pc.green(pc.bold("CLEAN")),
  caution: pc.yellow(pc.bold("CAUTION")),
  risky: pc.red(pc.bold("RISKY")),
};
const ISSUE = { high: pc.red, medium: pc.yellow, low: pc.dim, info: pc.dim };

export function formatAudit(r: AuditReport): string[] {
  if (r.files.length === 0)
    return [pc.yellow(`No .sol files found in ${r.target === "." ? "this folder" : r.target}.`)];
  const out: string[] = [];
  for (const f of r.files) {
    out.push(`${pc.bold(f.file)}  ${pc.dim(f.contracts.join(", "))}`);
    out.push(`What the Token Scanner will likely say after deploy: ${VERDICT[f.verdict]}`);
    const width = Math.max(...f.checks.map((c) => c.label.length));
    for (const c of f.checks) {
      if (c.status === "ok") continue;
      const lines = c.lines.length ? pc.dim(` (line ${c.lines.join(", ")})`) : "";
      out.push(`  ${STATUS[c.status]} ${c.label.padEnd(width)}  ${c.detail}${lines}`);
    }
    const okCount = f.checks.filter((c) => c.status === "ok").length;
    if (okCount) out.push(pc.dim(`  ✓ ${okCount} other checks clear`));
    if (f.issues.length) {
      out.push("", "  Code issues:");
      for (const i of f.issues)
        out.push(
          `  ${ISSUE[i.severity](i.severity.toUpperCase().padEnd(6))} ${i.title} ${pc.dim(`line ${i.line}`)}`,
          pc.dim(`         ${i.detail}`),
          pc.dim(`         ${i.snippet}`),
        );
    }
    out.push("");
  }
  for (const l of r.limits) out.push(pc.dim(l));
  return out;
}

export const auditFails = (r: AuditReport, failOn: AuditArgs["failOn"]) =>
  !!failOn &&
  r.files.some(
    (f) =>
      (failOn === "caution" ? f.verdict !== "clean" : f.verdict === "risky") ||
      f.issues.some((i) => i.severity === "high"),
  );

export async function runAudit(args: AuditArgs, printer: Printer): Promise<number> {
  try {
    const r = await auditPath(args.path ?? ".");
    if (args.json) printer.line(JSON.stringify(r, null, 2));
    else for (const l of formatAudit(r)) printer.line(l);
    return auditFails(r, args.failOn) ? EXIT_FOUND : 0;
  } catch (err) {
    printer.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

// ---------------------------------------------------------------- review

const REVIEW_SEV = {
  security: pc.red,
  bug: pc.red,
  performance: pc.yellow,
  simplify: pc.cyan,
  nit: pc.dim,
};

export function formatReview(r: Review): string[] {
  const out = [pc.bold("Summary: ") + r.summary, ""];
  if (r.findings.length === 0) out.push(pc.green("No issues found in this change."));
  for (const f of r.findings) {
    out.push(
      `${REVIEW_SEV[f.severity](f.severity.toUpperCase().padEnd(11))} ${pc.bold(f.title)}  ${pc.dim(`${f.file}${f.line ? `:${f.line}` : ""}`)}`,
    );
    for (const l of f.body.split("\n")) out.push(`            ${l}`);
    if (f.suggestion) {
      out.push(pc.dim("            suggestion:"));
      for (const l of f.suggestion.split("\n")) out.push(pc.green(`            ${l}`));
    }
  }
  if (r.truncated) out.push("", pc.yellow("The diff was long: only the first part was reviewed."));
  if (r.dropped)
    out.push(pc.dim(`${r.dropped} finding(s) about files outside the diff were dropped.`));
  out.push("", pc.dim("AI review: check each point before acting on it."));
  return out;
}

async function getDiff(args: ReviewArgs, cwd: string) {
  if (args.pr) {
    const diff = await execProgram("gh", ["pr", "diff", String(args.pr)], cwd);
    if (diff.code !== 0)
      throw new Error(
        `gh pr diff failed: ${diff.stderr.trim() || "is the GitHub CLI installed and logged in?"}`,
      );
    const view = await execProgram(
      "gh",
      ["pr", "view", String(args.pr), "--json", "title,body,headRefOid,url"],
      cwd,
    );
    const meta =
      view.code === 0
        ? (JSON.parse(view.stdout) as {
            title: string;
            body: string;
            headRefOid: string;
            url: string;
          })
        : null;
    return {
      diff: diff.stdout,
      title: meta?.title,
      description: meta?.body,
      commit: meta?.headRefOid,
      label: meta?.url ?? `PR #${args.pr}`,
    };
  }
  const base = args.base ?? (await defaultBranch(cwd));
  const mb = await execProgram("git", ["merge-base", base, "HEAD"], cwd);
  if (mb.code !== 0)
    throw new Error(`Couldn't find where this branch left ${base}. Pass --base <branch>.`);
  const diff = await execProgram(
    "git",
    ["diff", "--no-color", "--no-ext-diff", mb.stdout.trim()],
    cwd,
  );
  return { diff: diff.stdout, label: `changes since ${base}` };
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export async function runReview(
  args: ReviewArgs,
  printer: Printer,
  apiKey: string,
  modelId: string,
): Promise<number> {
  const cwd = process.cwd();
  try {
    const d = await getDiff(args, cwd);
    if (!d.diff.trim()) {
      printer.line(pc.yellow(`Nothing to review: no ${d.label}.`));
      return 0;
    }
    if (!args.json) printer.line(pc.dim(`Reviewing ${d.label} with ${modelId}…`));
    const review = await reviewDiff(createModel({ apiKey, modelId, ...modelTarget() }), d.diff, {
      ...(d.title && { title: d.title }),
      ...(d.description && { description: d.description }),
    });
    if (args.json) printer.line(JSON.stringify(review, null, 2));
    else {
      for (const l of formatReview(review)) printer.line(l);
      printer.line(
        pc.dim(
          `  ${review.usage.inputTokens.toLocaleString("en-US")} in · ${review.usage.outputTokens.toLocaleString("en-US")} out tokens`,
        ),
      );
    }
    if (!args.comment) return 0;
    if (!args.pr || !d.commit) {
      printer.error("--comment needs --pr <number> (the GitHub pull request to comment on).");
      return 1;
    }
    const inline = review.findings.filter((f) => f.onDiff).length;
    const ok =
      args.yes || (await confirm(`Post this review to ${d.label} (${inline} line comment(s))?`));
    if (!ok) {
      printer.line(pc.dim("Not posted."));
      return 0;
    }
    return (await postReview(review, args.pr, d.commit, cwd, printer)) ? 0 : 1;
  } catch (err) {
    printer.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function postReview(
  review: Review,
  pr: number,
  commit: string,
  cwd: string,
  printer: Printer,
): Promise<boolean> {
  const dir = await mkdtemp(path.join(tmpdir(), "mofu-review-"));
  const file = path.join(dir, "review.json");
  try {
    const post = async (payload: unknown) => {
      await writeFile(file, JSON.stringify(payload));
      return execProgram(
        "gh",
        ["api", "--method", "POST", `repos/{owner}/{repo}/pulls/${pr}/reviews`, "--input", file],
        cwd,
      );
    };
    let res = await post(githubReviewPayload(review, commit));
    if (res.code !== 0) {
      // GitHub refuses the whole review if one line isn't commentable: retry with everything in the body.
      const flat = { ...review, findings: review.findings.map((f) => ({ ...f, onDiff: false })) };
      res = await post(githubReviewPayload(flat, commit));
    }
    if (res.code !== 0) {
      printer.error(`GitHub didn't take the review: ${res.stderr.trim().slice(0, 300)}`);
      return false;
    }
    printer.line(pc.green(`Posted to pull request #${pr}.`));
    return true;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- ci

export interface CiResult {
  deps: ScanReport | null;
  depsError: string | null;
  secrets: SecretsReport | null;
  audit: AuditReport | null;
}

const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The PR comment / job summary. Starts with a marker so the Action can update one comment. */
export function ciMarkdown(r: CiResult, failed: string[]): string {
  const out = ["<!-- mofu-ci -->", "## Mofu checks", ""];
  const rows: string[] = [];
  if (r.secrets) {
    const real = realSecrets(r.secrets).length;
    rows.push(
      `| Secrets | ${real ? `**${real} found**` : "none found"} | ${r.secrets.filesScanned} files${r.secrets.historyScanned ? `, ${r.secrets.commitsScanned} commits` : ""} |`,
    );
  }
  if (r.audit) {
    const risky = r.audit.files.filter((f) => f.verdict === "risky").length;
    const high = r.audit.files.reduce(
      (n, f) => n + f.issues.filter((i) => i.severity === "high").length,
      0,
    );
    rows.push(
      `| Contracts | ${r.audit.files.length === 0 ? "no .sol files" : `${risky} risky, ${high} high-severity issue(s)`} | ${r.audit.files.length} file(s) |`,
    );
  }
  if (r.deps || r.depsError) {
    const t = r.deps?.totals;
    rows.push(
      `| Dependencies | ${r.depsError ? `couldn't run: ${md(r.depsError)}` : `${t!.vulnerabilities} known vulnerabilit${t!.vulnerabilities === 1 ? "y" : "ies"} (${t!.bySeverity.critical ?? 0} critical, ${t!.bySeverity.high ?? 0} high)`} | ${t ? `${t.dependencies} packages` : ""} |`,
    );
  }
  out.push("| Check | Result | Scanned |", "| --- | --- | --- |", ...rows, "");
  if (failed.length) out.push(`**Failing:** ${failed.join(", ")}`, "");

  if (r.secrets && r.secrets.findings.length) {
    out.push("### Secrets", "", "| Severity | What | Where |", "| --- | --- | --- |");
    for (const f of r.secrets.findings.slice(0, 30))
      out.push(`| ${f.severity} | ${md(f.title)} \`${md(f.preview)}\` | ${md(secretWhere(f))} |`);
    out.push(
      "",
      "Revoke leaked keys at the provider; move funds out of a leaked wallet. Deleting the line doesn't remove it from git history.",
      "",
    );
  }
  if (r.audit) {
    for (const f of r.audit.files) {
      const bad = f.checks.filter((c) => c.status === "risk" || c.status === "warn");
      if (!bad.length && !f.issues.length) continue;
      out.push(`### ${f.file}: likely **${f.verdict}** on Mofu's Token Scanner`, "");
      for (const c of bad)
        out.push(
          `- ${c.status === "risk" ? "Risk" : "Warn"}: ${md(c.label)} ${md(c.detail)}${c.lines.length ? ` (line ${c.lines.join(", ")})` : ""}`,
        );
      for (const i of f.issues)
        out.push(
          `- ${i.severity === "high" ? "High" : i.severity === "medium" ? "Medium" : "Note"}: ${md(i.title)}, line ${i.line}. ${md(i.detail)}`,
        );
      out.push("");
    }
  }
  if (r.deps && r.deps.findings.some((f) => f.vulnerabilities.length)) {
    out.push(
      "### Vulnerable dependencies",
      "",
      "| Package | Installed | Worst | Fixed in |",
      "| --- | --- | --- | --- |",
    );
    for (const f of r.deps.findings.filter((x) => x.vulnerabilities.length).slice(0, 25))
      out.push(
        `| ${md(f.name)} | ${f.version ?? "?"} | ${f.worstSeverity ?? "?"} | ${f.fixVersion ?? "no fix yet"} |`,
      );
    out.push("");
  }
  out.push(
    "<sub>Deterministic checks by [mofu-cli](https://mofu.works/docs/#ci): no AI, no keys. The contract check reads source patterns; it isn't an audit.</sub>",
  );
  return out.join("\n");
}

function secretWhere(f: SecretFinding) {
  const l = f.inFiles[0];
  if (l) return `${l.file}:${l.line}`;
  const c = f.firstCommit;
  return c ? `history: ${c.commit?.slice(0, 8)} ${c.file}:${c.line}` : "";
}

export function ciFailures(r: CiResult, failOn: CiArgs["failOn"]): string[] {
  const failed: string[] = [];
  if (failOn.includes("secrets") && r.secrets && realSecrets(r.secrets).length)
    failed.push("secrets");
  if (
    failOn.includes("risky") &&
    r.audit?.files.some((f) => f.verdict === "risky" || f.issues.some((i) => i.severity === "high"))
  )
    failed.push("risky contract");
  if (
    failOn.includes("deps") &&
    r.deps &&
    ((r.deps.totals.bySeverity.critical ?? 0) > 0 || (r.deps.totals.bySeverity.high ?? 0) > 0)
  )
    failed.push("critical or high vulnerabilities");
  return failed;
}

export async function runCi(args: CiArgs, printer: Printer): Promise<number> {
  const root = process.cwd();
  const result: CiResult = { deps: null, depsError: null, secrets: null, audit: null };
  if (args.checks.includes("secrets")) {
    result.secrets = await scanSecrets(root, {
      history: true,
      ...(args.range && { range: args.range }),
    });
  }
  if (args.checks.includes("audit")) {
    result.audit = await auditPath(args.auditPath ?? ".", root).catch(() => null);
  }
  if (args.checks.includes("deps")) {
    try {
      result.deps = await scanWorkspace(root);
    } catch (err) {
      result.depsError = err instanceof Error ? err.message : String(err);
    }
  }
  const failed = ciFailures(result, args.failOn);
  if (args.format === "json") printer.line(JSON.stringify({ ...result, failed }, null, 2));
  else printer.line(ciMarkdown(result, failed));
  return failed.length ? EXIT_FOUND : 0;
}

// ---------------------------------------------------------------- commit and pr

async function gitOut(args: string[], cwd: string): Promise<string> {
  const r = await execProgram("git", args, cwd);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} failed`);
  return r.stdout;
}

async function withTempFile<T>(text: string, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "mofu-msg-"));
  const file = path.join(dir, "message.txt");
  try {
    await writeFile(file, text);
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function runCommit(
  args: CommitArgs,
  printer: Printer,
  apiKey: string,
  modelId: string,
): Promise<number> {
  const cwd = process.cwd();
  try {
    if (args.all) await gitOut(["add", "-A"], cwd);
    const diff = await gitOut(["diff", "--cached", "--no-color", "--no-ext-diff"], cwd);
    if (!diff.trim()) {
      printer.line(
        pc.yellow("Nothing is staged. Stage files with git add, or run mofu commit --all."),
      );
      return 1;
    }
    const recent = (await gitOut(["log", "-15", "--format=%s"], cwd).catch(() => ""))
      .split("\n")
      .filter(Boolean);
    printer.line(pc.dim(`Writing a commit message with ${modelId}…`));
    const msg = await writeCommitMessage(
      createModel({ apiKey, modelId, ...modelTarget() }),
      diff,
      recent,
    );
    const text = commitText(msg);
    printer.line("");
    for (const l of text.split("\n")) printer.line(`  ${l === msg.subject ? pc.bold(l) : l}`);
    printer.line("");
    const branch = (await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
    const onDefault = branch === (await defaultBranch(cwd));
    const ok =
      args.yes ||
      (await confirm(
        `Commit with this message${onDefault ? ` (on ${branch}, your default branch)` : ""}?`,
      ));
    if (!ok) {
      printer.line(pc.dim("Not committed. Your changes are still staged."));
      return 0;
    }
    await withTempFile(text, (file) => gitOut(["commit", "-F", file], cwd));
    printer.line(pc.green(`Committed: ${msg.subject}`));
    return 0;
  } catch (err) {
    printer.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export async function runPr(
  args: PrArgs,
  printer: Printer,
  apiKey: string,
  modelId: string,
): Promise<number> {
  const cwd = process.cwd();
  try {
    const base = args.base ?? (await defaultBranch(cwd));
    const branch = (await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
    if (branch === base) {
      printer.error(`You're on ${base}. Switch to the branch you want to open a pull request for.`);
      return 1;
    }
    const commits = (await gitOut(["log", "--format=%s", `${base}..HEAD`], cwd))
      .split("\n")
      .filter(Boolean);
    if (commits.length === 0) {
      printer.line(pc.yellow(`No commits on ${branch} that aren't on ${base} yet.`));
      return 1;
    }
    const diff = await gitOut(["diff", "--no-color", "--no-ext-diff", `${base}...HEAD`], cwd);
    printer.line(pc.dim(`Writing the pull request with ${modelId}…`));
    const pr = await writePullRequest(
      createModel({ apiKey, modelId, ...modelTarget() }),
      diff,
      commits,
    );
    printer.line("");
    printer.line(pc.bold(pr.title));
    printer.line("");
    for (const l of pr.body.split("\n")) printer.line(`  ${l}`);
    printer.line("");
    const ok =
      args.yes ||
      (await confirm(
        `Push ${branch} to origin and open a ${args.draft ? "draft " : ""}pull request into ${base}?`,
      ));
    if (!ok) {
      printer.line(pc.dim("Nothing pushed or opened."));
      return 0;
    }
    const push = await execProgram("git", ["push", "-u", "origin", "HEAD"], cwd, 120_000);
    if (push.code !== 0) throw new Error(`git push failed: ${push.stderr.trim().slice(0, 300)}`);
    const created = await withTempFile(pr.body, (file) =>
      execProgram(
        "gh",
        [
          "pr",
          "create",
          "--base",
          base,
          "--title",
          pr.title,
          "--body-file",
          file,
          ...(args.draft ? ["--draft"] : []),
        ],
        cwd,
        120_000,
      ),
    );
    if (created.code !== 0)
      throw new Error(
        `gh pr create failed: ${created.stderr.trim().slice(0, 300) || "is the GitHub CLI installed and logged in?"}`,
      );
    printer.line(pc.green(`Opened: ${created.stdout.trim()}`));
    return 0;
  } catch (err) {
    printer.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
