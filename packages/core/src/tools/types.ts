import type { z } from "zod";
import type { MemoryStore } from "../memory.js";

/** Where a tool may run. */
export type Surface = "web" | "cli";

/**
 * read  - no side effects
 * write - changes files or stored state
 * exec  - runs commands or code
 */
export type ToolKind = "read" | "write" | "exec";

/** What the user is shown before a write/exec tool runs. */
export interface ApprovalRequest {
  toolName: string;
  kind: Exclude<ToolKind, "read">;
  /** One line, e.g. "Edit src/index.ts". */
  title: string;
  /** Full detail: a unified diff, the file content or the exact command. */
  detail: string;
}

export type ApproveFn = (request: ApprovalRequest) => Promise<boolean>;

/** Everything a tool may need at run time. Supplied by the surface (CLI or web). */
export interface ToolContext {
  /** Absolute path that file tools are confined to. Required by file and command tools. */
  workspaceRoot?: string;
  approve: ApproveFn;
  memory?: MemoryStore;
  signal?: AbortSignal;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

interface ToolBase<Schema extends z.ZodType, Output> {
  /** snake_case name the model sees. */
  name: string;
  /** Written for the model: what it does, when to use it, what it returns. */
  description: string;
  inputSchema: Schema;
  surfaces: readonly Surface[];
  /** One short line for the UI, e.g. "read_file src/index.ts". */
  summarize?: (input: z.infer<Schema>) => string;
  execute: (input: z.infer<Schema>, ctx: ToolContext) => Promise<Output>;
}

export interface ReadTool<Schema extends z.ZodType = z.ZodType, Output = unknown> extends ToolBase<
  Schema,
  Output
> {
  kind: "read";
}

export interface SideEffectTool<
  Schema extends z.ZodType = z.ZodType,
  Output = unknown,
> extends ToolBase<Schema, Output> {
  kind: "write" | "exec";
  /**
   * Builds what the user approves. May throw to reject invalid input before
   * the user is asked (e.g. an edit whose target string is missing).
   */
  describeApproval: (input: z.infer<Schema>, ctx: ToolContext) => Promise<ApprovalRequest>;
}

export type MofuTool<Schema extends z.ZodType = z.ZodType, Output = unknown> =
  ReadTool<Schema, Output> | SideEffectTool<Schema, Output>;

/** Identity helper that keeps the input type inferred from the schema. */
export function defineTool<Schema extends z.ZodType, Output>(
  tool: MofuTool<Schema, Output>,
): MofuTool<Schema, Output> {
  return tool;
}

/** Returned to the model when the user says no. */
export const DECLINED_RESULT = {
  status: "declined",
  message: "The user declined this action. Do not retry it. Ask the user what they want instead.",
} as const;
