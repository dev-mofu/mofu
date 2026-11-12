import { describe, expect, it } from "vitest";
import type { AuditReport, SecretsReport } from "@mofu/core";
import { ArgsError, HELP, parseArgs } from "../src/args.js";
import { auditFails, ciFailures, ciMarkdown, formatSecrets, realSecrets } from "../src/builder.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex

describe("parseArgs: builder commands", () => {
  it("parses secrets, audit, review and ci", () => {
    expect(parseArgs(["secrets"])).toEqual({ command: "secrets", json: false, history: true });
    expect(parseArgs(["secrets", "src", "--no-history", "--json", "--range=main..HEAD"])).toEqual({
      command: "secrets",
      path: "src",
      json: true,
      history: false,
      range: "main..HEAD",
    });
    expect(parseArgs(["audit", "contracts", "--fail-on", "risky"])).toEqual({
      command: "audit",
      path: "contracts",
      json: false,
      failOn: "risky",
    });
    expect(parseArgs(["review"])).toEqual({
      command: "review",
      comment: false,
      yes: false,
      json: false,
    });
    expect(parseArgs(["review", "--pr", "#12", "--comment", "-y", "-m", "x/y"])).toEqual({
      command: "review",
      model: "x/y",
      pr: 12,
      comment: true,
      yes: true,
      json: false,
    });
    expect(parseArgs(["ci"])).toEqual({
      command: "ci",
      checks: ["deps", "secrets", "audit"],
      format: "markdown",
      failOn: ["secrets"],
    });
    expect(
      parseArgs(["ci", "--checks", "secrets", "--fail-on", "none", "--format", "json"]),
    ).toMatchObject({ checks: ["secrets"], failOn: [], format: "json" });
  });

  it("rejects bad builder arguments", () => {
    expect(() => parseArgs(["secrets", "--nope"])).toThrow(/Unknown option/);
    expect(() => parseArgs(["audit", "--fail-on", "maybe"])).toThrow(ArgsError);
    expect(() => parseArgs(["review", "--comment"])).toThrow(/needs --pr/);
    expect(() => parseArgs(["review", "--pr", "x"])).toThrow(/pull request number/);
    expect(() => parseArgs(["review", "--pr", "3", "--base", "main"])).toThrow(/either/);
    expect(() => parseArgs(["ci", "--checks", "lint"])).toThrow(/takes deps, secrets, audit/);
    expect(HELP).toContain("mofu secrets");
    expect(HELP).toContain("mofu audit");
    expect(HELP).toContain("mofu review");
    expect(HELP).toContain("mofu ci");
  });
});

const secrets: SecretsReport = {
  root: ".",
  filesScanned: 10,
  commitsScanned: 4,
  historyScanned: true,
  limits: [],
  findings: [
    {
      rule: "github-token",
      title: "GitHub token",
      severity: "critical",
      preview: "ghp_…Zz9Y",
      confidence: "high",
      inFiles: [],
      firstCommit: { file: ".env", line: 1, commit: "abcdef1234", date: "2026-11-12T00:00:00Z" },
      note: "Removed from the files, but still in git history",
    },
    {
      rule: "eth-private-key",
      title: "Public test private key (Hardhat/Anvil)",
      severity: "low",
      preview: "ac09…ff80",
      confidence: "high",
      inFiles: [{ file: "hardhat.config.js", line: 3 }],
      firstCommit: null,
      note: null,
    },
  ],
};

const audit: AuditReport = {
  target: ".",
  limits: [],
  files: [
    {
      file: "Trap.sol",
      contracts: ["Trap"],
      verdict: "risky",
      checks: [
        {
          id: "mint",
          label: "Can new tokens be created?",
          status: "risk",
          detail: "Yes: mint().",
          lines: [9],
        },
      ],
      issues: [
        {
          id: "tx-origin",
          severity: "high",
          title: "tx.origin used",
          detail: "Use msg.sender.",
          line: 18,
          snippet: "",
        },
      ],
    },
  ],
};

describe("builder output", () => {
  it("prints secrets with where they are and what to do", () => {
    const text = strip(formatSecrets(secrets).join("\n"));
    expect(text).toContain("1 possible secret found in 10 files and 4 commits.");
    expect(text).toContain("first committed in abcdef12 (2026-11-12) .env:1");
    expect(text).toContain("hardhat.config.js:3");
    expect(realSecrets(secrets)).toHaveLength(1);
    expect(strip(formatSecrets({ ...secrets, findings: [] }).join("\n"))).toContain(
      "No secrets found",
    );
  });

  it("builds the CI comment and decides what fails", () => {
    const result = { secrets, audit, deps: null, depsError: null };
    const failed = ciFailures(result, ["secrets", "risky", "deps"]);
    expect(failed).toEqual(["secrets", "risky contract"]);
    const text = ciMarkdown(result, failed);
    expect(text.startsWith("<!-- mofu-ci -->")).toBe(true);
    expect(text).toContain("| Secrets | **1 found** | 10 files, 4 commits |");
    expect(text).toContain("history: abcdef12 .env:1");
    expect(text).toContain("### Trap.sol: likely **risky**");
    expect(text).toContain("**Failing:** secrets, risky contract");
    expect(ciFailures(result, [])).toEqual([]);
    expect(auditFails(audit, "risky")).toBe(true);
    expect(auditFails(audit, undefined)).toBe(false);
  });
});
