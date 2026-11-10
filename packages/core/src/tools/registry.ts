import { tool, type ToolSet } from "ai";
import { DECLINED_RESULT, type MofuTool, type Surface, type ToolContext } from "./types.js";
import { truncateText } from "./truncate.js";

/** Hard cap on the serialized size of any tool result sent to the model. */
export const MAX_RESULT_CHARS = 25_000;

/** Runs one tool call: approval for write/exec, then execution, then size capping. */
export async function runTool(t: MofuTool, input: unknown, ctx: ToolContext): Promise<unknown> {
  if (t.kind !== "read") {
    // describeApproval may throw on invalid input; that surfaces as a tool error.
    const request = await t.describeApproval(input, ctx);
    const approved = await ctx.approve(request);
    if (!approved) return DECLINED_RESULT;
  }
  const output = await t.execute(input, ctx);
  return capResult(output);
}

/** Keeps results small. Oversized results are replaced by a truncated JSON string. */
export function capResult(output: unknown): unknown {
  const json = JSON.stringify(output) ?? "null";
  if (json.length <= MAX_RESULT_CHARS) return output;
  return { truncated: true, partialJson: truncateText(json, MAX_RESULT_CHARS) };
}

export class ToolRegistry {
  private readonly tools = new Map<string, MofuTool>();

  constructor(tools: MofuTool[] = []) {
    for (const t of tools) this.register(t);
  }

  register(t: MofuTool): this {
    if (this.tools.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
    if (!/^[a-z][a-z0-9_]*$/.test(t.name))
      throw new Error(`Tool names must be snake_case: ${t.name}`);
    this.tools.set(t.name, t);
    return this;
  }

  get(name: string): MofuTool | undefined {
    return this.tools.get(name);
  }

  forSurface(surface: Surface): MofuTool[] {
    return [...this.tools.values()].filter((t) => t.surfaces.includes(surface));
  }

  /** Builds the AI SDK tool set for a surface, bound to a context. */
  toToolSet(surface: Surface, ctx: Omit<ToolContext, "signal">): ToolSet {
    const set: ToolSet = {};
    for (const t of this.forSurface(surface)) {
      set[t.name] = tool({
        description: t.description,
        inputSchema: t.inputSchema,
        execute: (input: unknown, options: { abortSignal?: AbortSignal }) =>
          runTool(t, input, {
            ...ctx,
            ...(options.abortSignal && { signal: options.abortSignal }),
          }),
      });
    }
    return set;
  }
}
