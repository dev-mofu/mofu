import { execFile } from "node:child_process";
import { z } from "zod";
import { defineTool } from "./types.js";
import { requireWorkspace, resolveInWorkspace, displayPath } from "./workspace.js";
import { truncateText } from "./truncate.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program with an argument list (no shell, so nothing can be injected). */
export function execProgram(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : err
              ? 1
              : 0;
        resolve({
          code,
          stdout: String(stdout),
          stderr: String(stderr || (err && !stderr ? err.message : "")),
        });
      },
    );
  });
}

export const git = (root: string, args: string[]) => execProgram("git", args, root);

async function gitOk(root: string, args: string[]): Promise<string> {
  const r = await git(root, args);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

/** Branch names Mofu never commits to, on top of the repository's default branch. */
const ALWAYS_PROTECTED = new Set(["main", "master", "develop", "trunk", "HEAD"]);

export async function ensureGitRepo(root: string): Promise<void> {
  const r = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (r.code !== 0 || r.stdout.trim() !== "true") {
    throw new Error("This folder isn't a git repository. Ask the user before running `git init`.");
  }
}

export async function currentBranch(root: string): Promise<string> {
  return gitOk(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function defaultBranch(root: string): Promise<string> {
  const remoteHead = await git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead.code === 0 && remoteHead.stdout.trim()) {
    return remoteHead.stdout.trim().replace(/^origin\//, "");
  }
  for (const candidate of ["main", "master"]) {
    const r = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (r.code === 0) return candidate;
  }
  const configured = await git(root, ["config", "init.defaultBranch"]);
  return configured.stdout.trim() || "main";
}

export async function isProtectedBranch(root: string, branch: string): Promise<boolean> {
  return ALWAYS_PROTECTED.has(branch) || branch === (await defaultBranch(root));
}

async function changedFiles(root: string): Promise<string[]> {
  const out = await gitOk(root, ["status", "--porcelain", "--untracked-files=all"]);
  return out ? out.split("\n").map((l) => l.trimEnd()) : [];
}

/** mofu/<lowercase-dashed-slug>, at most 50 characters after the prefix. */
export function branchNameFor(description: string): string {
  const slug = description
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return `mofu/${slug || "task"}`;
}

async function uniqueBranchName(root: string, wanted: string): Promise<string> {
  for (let i = 1; i < 100; i++) {
    const name = i === 1 ? wanted : `${wanted}-${i}`;
    const r = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    if (r.code !== 0) return name;
  }
  throw new Error("Couldn't find a free branch name.");
}

/** Refs the model may pass to git diff: names, hashes, HEAD~1 etc. Never options. */
const SAFE_REF = /^(?!-)[A-Za-z0-9._/~^@{}-]{1,100}$/;

export const gitStatusTool = defineTool({
  name: "git_status",
  description:
    "Show the current branch, the default branch, whether it's ahead/behind its upstream, and changed files.",
  inputSchema: z.object({}),
  kind: "read",
  surfaces: ["cli"],
  summarize: () => "git_status",
  async execute(_input, ctx) {
    const root = requireWorkspace(ctx);
    await ensureGitRepo(root);
    const [branch, base, header, changes] = await Promise.all([
      currentBranch(root),
      defaultBranch(root),
      gitOk(root, ["status", "-sb"]).then((s) => s.split("\n")[0] ?? ""),
      changedFiles(root),
    ]);
    return {
      branch,
      defaultBranch: base,
      tracking: header.replace(/^## /, ""),
      changes: changes.slice(0, 100),
      ...(changes.length > 100 && { note: `${changes.length - 100} more changes not shown.` }),
    };
  },
});

export const gitDiffTool = defineTool({
  name: "git_diff",
  description:
    "Show a diff: working tree changes by default, staged changes with staged: true, or against a ref " +
    "(e.g. 'main' or 'HEAD~1'). Optionally limit to one path. Output is truncated.",
  inputSchema: z.object({
    ref: z.string().regex(SAFE_REF).optional().describe("Compare against this ref."),
    staged: z.boolean().optional(),
    path: z.string().optional().describe("Only this file or folder."),
  }),
  kind: "read",
  surfaces: ["cli"],
  summarize: (input) =>
    `git_diff${input.ref ? ` ${input.ref}` : ""}${input.path ? ` ${input.path}` : ""}`,
  async execute(input, ctx) {
    const root = requireWorkspace(ctx);
    await ensureGitRepo(root);
    const base = ["diff", "--no-color"];
    if (input.staged) base.push("--staged");
    if (input.ref) base.push(input.ref);
    const paths = input.path
      ? ["--", displayPath(root, await resolveInWorkspace(root, input.path))]
      : [];
    const stat = await gitOk(root, [...base, "--stat", ...paths]);
    const patch = await gitOk(root, [...base, ...paths]);
    return { stat: stat || "(no changes)", diff: truncateText(patch, 15_000) };
  },
});

export const gitCreateBranchTool = defineTool({
  name: "git_create_branch",
  description:
    "Create and switch to a new branch named mofu/<short-description> for the current task. Always do this " +
    "before changing code in a git repository. If there are uncommitted changes it fails; ask the user whether " +
    "to stash them, then call again with stash: true.",
  inputSchema: z.object({
    description: z
      .string()
      .min(1)
      .max(80)
      .describe("A few words describing the task, e.g. 'add dark mode'."),
    stash: z
      .boolean()
      .optional()
      .describe("Stash uncommitted changes first. Only with the user's consent."),
  }),
  kind: "exec",
  surfaces: ["cli"],
  summarize: (input) => `git_create_branch ${branchNameFor(input.description)}`,
  async describeApproval(input, ctx) {
    const root = requireWorkspace(ctx);
    await ensureGitRepo(root);
    const changes = await changedFiles(root);
    if (changes.length > 0 && !input.stash) {
      throw new Error(
        `There are uncommitted changes:\n${changes.slice(0, 20).join("\n")}\n` +
          "Ask the user whether to stash them (call again with stash: true) or to commit them first.",
      );
    }
    const name = await uniqueBranchName(root, branchNameFor(input.description));
    const from = await currentBranch(root);
    return {
      toolName: "git_create_branch",
      kind: "exec",
      title: `Create branch ${name}`,
      detail:
        `New branch ${name}, starting from ${from}.` +
        (changes.length > 0
          ? `\nYour ${changes.length} uncommitted change(s) will be stashed first (restore later with \`git stash pop\`).`
          : ""),
    };
  },
  async execute(input, ctx) {
    const root = requireWorkspace(ctx);
    const name = await uniqueBranchName(root, branchNameFor(input.description));
    if (input.stash && (await changedFiles(root)).length > 0) {
      await gitOk(root, ["stash", "push", "--include-untracked", "-m", `mofu: before ${name}`]);
    }
    await gitOk(root, ["switch", "-c", name]);
    return { branch: name, status: "created" };
  },
});

async function relativeFiles(root: string, files: string[]): Promise<string[]> {
  return Promise.all(files.map(async (f) => displayPath(root, await resolveInWorkspace(root, f))));
}

export const gitCommitTool = defineTool({
  name: "git_commit",
  description:
    "Stage the listed files and commit them with a message. Only works on a feature branch (never the default " +
    "branch). Write a clear message: a short summary line, then a blank line and details if useful.",
  inputSchema: z.object({
    files: z.array(z.string()).min(1).max(100).describe("Paths to include in the commit."),
    message: z.string().min(3).max(2000),
  }),
  kind: "exec",
  surfaces: ["cli"],
  summarize: (input) => `git_commit ${input.files.length} file(s)`,
  async describeApproval(input, ctx) {
    const root = requireWorkspace(ctx);
    await ensureGitRepo(root);
    const branch = await currentBranch(root);
    if (await isProtectedBranch(root, branch)) {
      throw new Error(
        `Refusing to commit on '${branch}'. Create a feature branch with git_create_branch first.`,
      );
    }
    const files = await relativeFiles(root, input.files);
    const stat = (await git(root, ["diff", "HEAD", "--stat", "--", ...files])).stdout.trim();
    return {
      toolName: "git_commit",
      kind: "exec",
      title: `Commit ${files.length} file(s) on ${branch}`,
      detail: `Files:\n${files.map((f) => `  ${f}`).join("\n")}\n\nMessage:\n${input.message}${stat ? `\n\n${stat}` : ""}`,
    };
  },
  async execute(input, ctx) {
    const root = requireWorkspace(ctx);
    const branch = await currentBranch(root);
    if (await isProtectedBranch(root, branch))
      throw new Error(`Refusing to commit on '${branch}'.`);
    const files = await relativeFiles(root, input.files);
    await gitOk(root, ["add", "--", ...files]);
    await gitOk(root, ["commit", "-m", input.message]);
    return { branch, commit: await gitOk(root, ["rev-parse", "--short", "HEAD"]), files };
  },
});

export const createPullRequestTool = defineTool({
  name: "create_pull_request",
  description:
    "Push the current feature branch to origin and open a GitHub pull request with the GitHub CLI (gh). " +
    "Only after the work is committed and the user wants a PR. Never force-pushes.",
  inputSchema: z.object({
    title: z.string().min(3).max(200),
    body: z.string().max(10_000).describe("What changed, why, and how it was tested."),
    base: z
      .string()
      .regex(SAFE_REF)
      .optional()
      .describe("Target branch. Defaults to the default branch."),
  }),
  kind: "exec",
  surfaces: ["cli"],
  summarize: (input) => `create_pull_request "${input.title}"`,
  async describeApproval(input, ctx) {
    const root = requireWorkspace(ctx);
    await ensureGitRepo(root);
    const branch = await currentBranch(root);
    if (await isProtectedBranch(root, branch)) {
      throw new Error(
        `'${branch}' is a protected branch; open pull requests from a feature branch.`,
      );
    }
    const gh = await execProgram("gh", ["auth", "status"], root);
    if (gh.code !== 0) {
      throw new Error(
        "The GitHub CLI (gh) isn't installed or isn't logged in. Tell the user to install it from https://cli.github.com and run `gh auth login`, or to push and open the PR themselves.",
      );
    }
    const remote = await git(root, ["remote", "get-url", "origin"]);
    if (remote.code !== 0) throw new Error("This repository has no 'origin' remote to push to.");
    const base = input.base ?? (await defaultBranch(root));
    return {
      toolName: "create_pull_request",
      kind: "exec",
      title: `Push ${branch} and open a pull request into ${base}`,
      detail: `Remote: ${remote.stdout.trim()}\nBranch: ${branch} → ${base}\n\nTitle: ${input.title}\n\n${input.body}`,
    };
  },
  async execute(input, ctx) {
    const root = requireWorkspace(ctx);
    const branch = await currentBranch(root);
    const base = input.base ?? (await defaultBranch(root));
    await gitOk(root, ["push", "--set-upstream", "origin", branch]);
    const pr = await execProgram(
      "gh",
      [
        "pr",
        "create",
        "--base",
        base,
        "--head",
        branch,
        "--title",
        input.title,
        "--body",
        input.body,
      ],
      root,
    );
    if (pr.code !== 0) throw new Error(`gh pr create failed: ${(pr.stderr || pr.stdout).trim()}`);
    return { branch, base, url: pr.stdout.trim().split("\n").pop() };
  },
});
