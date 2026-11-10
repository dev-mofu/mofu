import pc from "picocolors";
import type { ApprovalRequest, TurnUsage } from "@mofu/core";

/** Writes streamed output and remembers whether the cursor is at the start of a line. */
export class Printer {
  private atLineStart = true;

  constructor(private readonly out: NodeJS.WritableStream = process.stdout) {}

  write(text: string): void {
    if (!text) return;
    this.out.write(text);
    this.atLineStart = text.endsWith("\n");
  }

  /** Ends the current line if something was printed on it. */
  newline(): void {
    if (!this.atLineStart) this.write("\n");
  }

  line(text = ""): void {
    this.newline();
    this.write(`${text}\n`);
  }

  toolCall(summary: string): void {
    this.line(pc.cyan("› ") + pc.dim(oneLine(summary)));
  }

  toolError(message: string): void {
    this.line(pc.red("  ✗ ") + pc.dim(oneLine(message)));
  }

  error(message: string): void {
    this.line(pc.red(`Error: ${message}`));
  }

  usage(usage: TurnUsage, model: string): void {
    const fmt = (n: number) => n.toLocaleString("en-US");
    this.line(
      pc.dim(`  ${fmt(usage.inputTokens)} in · ${fmt(usage.outputTokens)} out tokens · ${model}`),
    );
  }
}

const MAX_SUMMARY = 120;

export function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SUMMARY ? `${flat.slice(0, MAX_SUMMARY)}…` : flat;
}

/** Colors a unified diff: additions green, removals red, hunks cyan. */
export function colorizeDiff(diff: string): string {
  return diff
    .split("\n")
    .filter((l) => !l.startsWith("====="))
    .map((l) => {
      if (l.startsWith("+++") || l.startsWith("---")) return pc.bold(l);
      if (l.startsWith("+")) return pc.green(l);
      if (l.startsWith("-")) return pc.red(l);
      if (l.startsWith("@@")) return pc.cyan(l);
      return pc.dim(l);
    })
    .join("\n");
}

/** Renders what the user is about to approve. */
export function formatApproval(req: ApprovalRequest): string {
  const header = pc.yellow(pc.bold(req.title));
  let body: string;
  if (req.toolName === "run_command") body = pc.bold(`$ ${req.detail}`);
  else if (req.detail.startsWith("Index:") || req.detail.includes("\n@@"))
    body = colorizeDiff(req.detail);
  else body = req.detail;
  return `${header}\n${body.trimEnd()}`;
}
