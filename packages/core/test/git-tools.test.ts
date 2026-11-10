import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DECLINED_RESULT, runTool, type MofuTool } from "../src/index.js";
import {
  createPullRequestTool,
  git,
  gitCommitTool,
  gitCreateBranchTool,
  gitDiffTool,
  gitStatusTool,
} from "../src/tools/git.js";
import { repoOverviewTool, runTestsTool } from "../src/tools/repo-tools.js";
import { tempDir, testContext } from "./helpers.js";

const asTool = (t: unknown) => t as MofuTool;
let root: string;

async function sh(args: string[]) {
  const r = await git(root, args);
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

beforeEach(async () => {
  root = await tempDir("mofu-git-");
  await sh(["init", "-b", "main"]);
  await sh(["config", "user.email", "test@example.com"]);
  await sh(["config", "user.name", "Test"]);
  await sh(["config", "core.autocrlf", "false"]);
  await writeFile(path.join(root, "a.txt"), "one\n");
  await sh(["add", "."]);
  await sh(["commit", "-m", "init"]);
});

describe("git tools", () => {
  it("git_status reports branch, default branch and changes", async () => {
    await writeFile(path.join(root, "b.txt"), "new");
    const out = await runTool(asTool(gitStatusTool), {}, testContext(root));
    expect(out).toMatchObject({ branch: "main", defaultBranch: "main", changes: ["?? b.txt"] });
  });

  it("refuses to create a branch over uncommitted changes unless stashing", async () => {
    await writeFile(path.join(root, "a.txt"), "changed\n");
    const ctx = testContext(root);
    await expect(
      runTool(asTool(gitCreateBranchTool), { description: "fix it" }, ctx),
    ).rejects.toThrow(/uncommitted changes/);
    expect(ctx.requests).toHaveLength(0);

    const out = await runTool(
      asTool(gitCreateBranchTool),
      { description: "fix it", stash: true },
      ctx,
    );
    expect(out).toMatchObject({ branch: "mofu/fix-it" });
    expect(ctx.requests[0]?.detail).toMatch(/stashed/);
    expect(await sh(["stash", "list"])).toContain("mofu: before mofu/fix-it");
  });

  it("picks a unique branch name", async () => {
    await sh(["branch", "mofu/add-feature"]);
    const out = await runTool(
      asTool(gitCreateBranchTool),
      { description: "Add feature" },
      testContext(root),
    );
    expect(out).toMatchObject({ branch: "mofu/add-feature-2" });
  });

  it("never commits on the default branch", async () => {
    await writeFile(path.join(root, "a.txt"), "two\n");
    const ctx = testContext(root);
    await expect(
      runTool(asTool(gitCommitTool), { files: ["a.txt"], message: "change" }, ctx),
    ).rejects.toThrow(/Refusing to commit on 'main'/);
    expect(ctx.requests).toHaveLength(0);
  });

  it("commits only the listed files on a feature branch", async () => {
    await runTool(asTool(gitCreateBranchTool), { description: "work" }, testContext(root));
    await writeFile(path.join(root, "a.txt"), "two\n");
    await writeFile(path.join(root, "other.txt"), "leave me");
    const ctx = testContext(root);
    const out = (await runTool(
      asTool(gitCommitTool),
      { files: ["a.txt"], message: "Update a" },
      ctx,
    )) as { commit: string; branch: string };
    expect(out.branch).toBe("mofu/work");
    expect(out.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(ctx.requests[0]?.detail).toContain("Update a");
    expect(await sh(["status", "--porcelain"])).toBe("?? other.txt");
  });

  it("does nothing when the commit is declined", async () => {
    await runTool(asTool(gitCreateBranchTool), { description: "work" }, testContext(root));
    await writeFile(path.join(root, "a.txt"), "two\n");
    const out = await runTool(
      asTool(gitCommitTool),
      { files: ["a.txt"], message: "Update a" },
      testContext(root, false),
    );
    expect(out).toEqual(DECLINED_RESULT);
    expect(await sh(["log", "--oneline"])).not.toContain("Update a");
  });

  it("git_diff shows working tree changes and rejects option-like refs", async () => {
    await writeFile(path.join(root, "a.txt"), "two\n");
    const out = (await runTool(asTool(gitDiffTool), {}, testContext(root))) as { diff: string };
    expect(out.diff).toContain("+two");
    await expect(
      runTool(asTool(gitDiffTool), { ref: "--output=/tmp/x" }, testContext(root)),
    ).rejects.toThrow();
  });

  it("won't open a pull request from the default branch", async () => {
    const ctx = testContext(root);
    await expect(
      runTool(asTool(createPullRequestTool), { title: "PR", body: "x" }, ctx),
    ).rejects.toThrow(/protected branch/);
    expect(ctx.requests).toHaveLength(0);
  });

  it("won't push without a remote (or gh), and never asks first in that case", async () => {
    await runTool(asTool(gitCreateBranchTool), { description: "pr" }, testContext(root));
    const ctx = testContext(root);
    await expect(
      runTool(asTool(createPullRequestTool), { title: "PR", body: "x" }, ctx),
    ).rejects.toThrow(/gh|origin/);
    expect(ctx.requests).toHaveLength(0);
  });
});

describe("repo_overview and run_tests", () => {
  it("builds an overview of the local repository", async () => {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "node test.js" } }),
    );
    const out = (await runTool(asTool(repoOverviewTool), {}, testContext(root))) as {
      overview: string;
    };
    expect(out.overview).toContain("Tests: `npm test`");
    expect(out.overview).toContain("a.txt");
  });

  it("runs tests after approval and reports failure with the output tail", async () => {
    await writeFile(
      path.join(root, "t.js"),
      "console.log('Tests:       1 failed, 2 passed, 3 total'); process.exit(1);",
    );
    const ctx = testContext(root);
    const out = await runTool(asTool(runTestsTool), { command: "node t.js" }, ctx);
    expect(ctx.requests[0]).toMatchObject({ kind: "exec", detail: "node t.js" });
    expect(out).toMatchObject({
      passed: false,
      exitCode: 1,
      summary: "1 failed, 2 passed, 3 total",
    });
  });
});
