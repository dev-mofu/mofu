import { z } from "zod";
import { defineTool } from "./types.js";

export const saveMemoryTool = defineTool({
  name: "save_memory",
  description:
    "Save a short fact about the user or their preferences so you remember it in future sessions. " +
    "Only use it when the user asks you to remember something, or clearly states a lasting preference. " +
    "Write the fact as one plain sentence.",
  inputSchema: z.object({
    fact: z
      .string()
      .min(1)
      .max(300)
      .describe("One sentence, e.g. 'Prefers TypeScript over JavaScript.'"),
  }),
  kind: "write",
  surfaces: ["web", "cli"],
  summarize: (input) => `save_memory "${input.fact}"`,
  async describeApproval(input) {
    return { toolName: "save_memory", kind: "write", title: "Remember this", detail: input.fact };
  },
  async execute(input, ctx) {
    if (!ctx.memory) throw new Error("Memory is not available here.");
    await ctx.memory.append(input.fact);
    return { status: "saved", fact: input.fact };
  },
});
