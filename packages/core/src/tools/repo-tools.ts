import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  buildRepoOverview,
  detectTestCommand,
  formatOverview,
  type RepoSnapshot,
} from "../repo/overview.js";
import { defineTool } from "./types.js";
import { looksBinary, requireWorkspace } from "./workspace.js";
import { walkFiles } from "./walk.js";
import { runShellCommand } from "./run-command.js";

const MAX_FILES = 5_000;
const MAX_READ_BYTES = 200_000;
const TEST_TIMEOUT_S = 300;
const OUTPUT_TAIL_CHARS = 6_000;

/** A RepoSnapshot backed by the local working directory. */
export async function localSnapshot(root: string): Promise<RepoSnapshot> {
  const files = (await walkFiles(root)).slice(0, MAX_FILES);
  return {
    name: path.basename(root),
    files,
    async readFile(rel) {
      const abs = path.join(root, rel);
      const info = await stat(abs).catch(() => null);
      if (!info?.isFile() || info.size > MAX_READ_BYTES) return null;
      const buf = await readFile(abs);
      return looksBinary(buf) ? null : buf.toString("utf8");
    },
  };
}

export const repoOverviewTool = defineTool({
  name: "repo_overview",
  description:
    "Get a compact map of the repository in the workspace: languages, package managers, frameworks, " +
    "entry points, how to run tests, scripts, config files, a folder tree and the README excerpt. " +
    "Call this first when you need to understand or change a codebase, instead of listing or reading many files.",
  inputSchema: z.object({}),
  kind: "read",
  surfaces: ["cli"],
  summarize: () => "repo_overview",
  async execute(_input, ctx) {
    const overview = await buildRepoOverview(await localSnapshot(requireWorkspace(ctx)));
    return { overview: formatOverview(overview) };
  },
});

export const detectTestCommandTool = defineTool({
  name: "detect_test_command",
  description:
    "Find the command that runs this project's tests (from package.json, pytest config, go.mod, Cargo.toml…). " +
    "Doesn't run anything.",
  inputSchema: z.object({}),
  kind: "read",
  surfaces: ["cli"],
  summarize: () => "detect_test_command",
  async execute(_input, ctx) {
    const found = await detectTestCommand(await localSnapshot(requireWorkspace(ctx)));
    return (
      found ?? { command: null, message: "No test setup detected. Ask the user how tests are run." }
    );
  },
});

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Pulls the "N passed, M failed" line out of common test runners' output. */
export function summarizeTestOutput(output: string): string | null {
  const clean = output.replace(ANSI, "");
  const patterns = [
    /^\s*Tests\s+(.*\d+ (?:passed|failed).*)$/m, // vitest
    /^Tests:\s+(.*)$/m, // jest
    /^=+ (.*(?:passed|failed|error).*) in [\d.]+s.*=+$/m, // pytest
    /^test result: (.*)$/m, // cargo
  ];
  for (const re of patterns) {
    const m = clean.match(re);
    if (m?.[1]) return m[1].trim();
  }
  const goFails = clean.match(/^--- FAIL:/gm)?.length ?? 0;
  if (/^(ok|FAIL)\s+\S+/m.test(clean)) return goFails ? `${goFails} failed` : "all packages ok";
  return null;
}

export const runTestsTool = defineTool({
  name: "run_tests",
  description:
    "Run the project's tests and report pass/fail with the end of the output, where failures usually are. " +
    "Without a command it uses the detected test command. You may pass a narrower command (e.g. one test file). " +
    "The user must approve it.",
  inputSchema: z.object({
    command: z.string().optional().describe("Test command to run. Omit to use the detected one."),
  }),
  kind: "exec",
  surfaces: ["cli"],
  summarize: (input) => `run_tests${input.command ? ` ${input.command}` : ""}`,
  async describeApproval(input, ctx) {
    const root = requireWorkspace(ctx);
    const command = input.command ?? (await detectTestCommand(await localSnapshot(root)))?.command;
    if (!command) throw new Error("No test command detected. Ask the user how to run the tests.");
    return { toolName: "run_tests", kind: "exec", title: `Run tests in ${root}`, detail: command };
  },
  async execute(input, ctx) {
    const root = requireWorkspace(ctx);
    const command = input.command ?? (await detectTestCommand(await localSnapshot(root)))?.command;
    if (!command) throw new Error("No test command detected.");
    const result = await runShellCommand(command, root, TEST_TIMEOUT_S, ctx.signal);
    const output = `${result.stdout}\n${result.stderr}`.replace(ANSI, "").trim();
    return {
      command,
      passed: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      summary: summarizeTestOutput(output),
      outputTail:
        output.length > OUTPUT_TAIL_CHARS ? `…${output.slice(-OUTPUT_TAIL_CHARS)}` : output,
    };
  },
});
