import { spawn } from "node:child_process";
import { z } from "zod";
import { defineTool } from "./types.js";
import { requireWorkspace } from "./workspace.js";
import { truncateText } from "./truncate.js";

const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 300;
const MAX_OUTPUT_CHARS = 10_000;

export const isWindows = process.platform === "win32";

/** Human name of the shell, also used in the system prompt. */
export const SHELL_NAME = isWindows ? "Windows PowerShell" : "sh";

function shellInvocation(command: string): { file: string; args: string[] } {
  return isWindows
    ? { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] }
    : { file: "/bin/sh", args: ["-c", command] };
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (isWindows) {
    // Killing powershell.exe alone leaves its children running.
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runShellCommand(
  command: string,
  cwd: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const { file, args } = shellInvocation(command);
    const child = spawn(file, args, {
      cwd,
      windowsHide: true,
      detached: !isWindows, // own process group so the whole tree can be killed
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += d.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutSeconds * 1000);
    const onAbort = () => killTree(child.pid);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: code,
        stdout: truncateText(stdout, MAX_OUTPUT_CHARS),
        stderr: truncateText(stderr, MAX_OUTPUT_CHARS),
        timedOut,
      });
    });
  });
}

/** Force-pushing can destroy other people's work; Mofu never does it, approved or not. */
const FORCE_PUSH =
  /\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*(\s--force(-with-lease)?\b|\s-[a-zA-Z]*f[a-zA-Z]*\b|\s\+\S)/;

export function assertAllowedCommand(command: string): void {
  if (FORCE_PUSH.test(command)) {
    throw new Error(
      "Force-pushing isn't allowed. Push normally or ask the user to do it themselves.",
    );
  }
}

export const runCommandTool = defineTool({
  name: "run_command",
  description:
    `Run a shell command in the workspace directory using ${SHELL_NAME}. ` +
    "Use it for builds, tests, git and other CLI tools. Avoid interactive commands; they will hang until the timeout. " +
    "Returns exit code, stdout and stderr (truncated). The user must approve every command.",
  inputSchema: z.object({
    command: z.string().min(1).describe(`The exact command line for ${SHELL_NAME}.`),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_TIMEOUT_S)
      .optional()
      .describe(`Defaults to ${DEFAULT_TIMEOUT_S}.`),
  }),
  kind: "exec",
  surfaces: ["cli"],
  summarize: (input) => `run_command ${input.command}`,
  async describeApproval(input, ctx) {
    const root = requireWorkspace(ctx);
    assertAllowedCommand(input.command);
    return {
      toolName: "run_command",
      kind: "exec",
      title: `Run in ${root}`,
      detail: input.command,
    };
  },
  async execute(input, ctx) {
    const root = requireWorkspace(ctx);
    return runShellCommand(
      input.command,
      root,
      input.timeoutSeconds ?? DEFAULT_TIMEOUT_S,
      ctx.signal,
    );
  },
});
