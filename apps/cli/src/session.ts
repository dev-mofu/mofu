import pc from "picocolors";
import {
  buildSystemPrompt,
  createDefaultRegistry,
  createModel,
  runTurn,
  SHELL_NAME,
  type ApprovalRequest,
  type MemoryStore,
  type ModelMessage,
  type MofuError,
  type ToolSet,
} from "@mofu/core";
import { formatApproval, Printer } from "./ui.js";
import type { Terminal } from "./terminal.js";

export interface SessionOptions {
  apiKey: string;
  model: string;
  workspaceRoot: string;
  memory: MemoryStore;
  terminal: Terminal;
  printer: Printer;
}

/** One chat conversation in the terminal. */
export class ChatSession {
  model: string;
  private messages: ModelMessage[] = [];
  private readonly tools: ToolSet;
  private readonly summaries = new Map<string, (input: never) => string>();
  private current: AbortController | null = null;

  constructor(private readonly opts: SessionOptions) {
    this.model = opts.model;
    const registry = createDefaultRegistry();
    for (const t of registry.forSurface("cli")) {
      if (t.summarize) this.summaries.set(t.name, t.summarize as (input: never) => string);
    }
    this.tools = registry.toToolSet("cli", {
      workspaceRoot: opts.workspaceRoot,
      memory: opts.memory,
      approve: (req) => this.approve(req),
    });
  }

  get busy(): boolean {
    return this.current !== null;
  }

  /** Stops the running turn (Ctrl+C). */
  abort(): void {
    this.current?.abort();
  }

  clear(): void {
    this.messages = [];
  }

  private async approve(req: ApprovalRequest): Promise<boolean> {
    const { printer, terminal } = this.opts;
    if (!terminal.interactive) {
      printer.line(
        pc.yellow(`Skipped (needs approval, but input isn't interactive): ${req.title}`),
      );
      return false;
    }
    printer.line();
    printer.line(formatApproval(req));
    const ok = await terminal.confirm(pc.yellow("Apply? (y/n) "));
    printer.line(ok ? pc.green("  approved") : pc.dim("  declined"));
    return ok;
  }

  private summarize(toolName: string, input: unknown): string {
    const fn = this.summaries.get(toolName);
    return fn ? fn(input as never) : `${toolName} ${JSON.stringify(input)}`;
  }

  /** Sends one user message and streams the reply. Returns false if the turn failed. */
  async send(text: string): Promise<boolean> {
    const { printer } = this.opts;
    const instructions = buildSystemPrompt({
      surface: "cli",
      memory: await this.opts.memory.load(),
      workspaceRoot: this.opts.workspaceRoot,
      shell: SHELL_NAME,
      platform: process.platform,
    });
    const history = [...this.messages, { role: "user", content: text } satisfies ModelMessage];
    this.current = new AbortController();
    try {
      const result = await runTurn({
        model: createModel({ apiKey: this.opts.apiKey, modelId: this.model }),
        instructions,
        messages: history,
        tools: this.tools,
        abortSignal: this.current.signal,
        onEvent: (event) => {
          if (event.type === "text-delta") printer.write(event.text);
          else if (event.type === "tool-call")
            printer.toolCall(this.summarize(event.toolName, event.input));
          else if (event.type === "tool-error") printer.toolError(event.error);
        },
      });
      this.messages = [...history, ...result.responseMessages];
      printer.newline();
      if (result.hitStepLimit) {
        printer.line(pc.yellow("  Stopped after the step limit. Say 'continue' to keep going."));
      }
      printer.usage(result.usage, this.model);
      return true;
    } catch (err) {
      const e = err as MofuError;
      // The failed turn isn't kept in history. File changes already made stay on disk.
      if (e.kind === "aborted") printer.line(pc.dim("Stopped."));
      else printer.error(e.message);
      return false;
    } finally {
      this.current = null;
    }
  }
}
