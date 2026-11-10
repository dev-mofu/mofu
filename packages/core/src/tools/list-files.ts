import { z } from "zod";
import { defineTool } from "./types.js";
import { requireWorkspace } from "./workspace.js";
import { walkFiles } from "./walk.js";
import { truncateList } from "./truncate.js";

const MAX_ENTRIES = 500;

export const listFilesTool = defineTool({
  name: "list_files",
  description:
    "List files in the workspace. Use a glob pattern to narrow the result (e.g. 'src/**/*.ts'). " +
    "Respects .gitignore and skips node_modules, .git and build output. Returns relative paths.",
  inputSchema: z.object({
    pattern: z
      .string()
      .optional()
      .describe("Glob pattern relative to the workspace root. Defaults to all files."),
  }),
  kind: "read",
  surfaces: ["cli"],
  summarize: (input) => `list_files ${input.pattern ?? "**/*"}`,
  async execute(input, ctx) {
    const root = requireWorkspace(ctx);
    const pattern = input.pattern ?? "**/*";
    if (pattern.includes("..")) throw new Error("Patterns may not contain '..'.");
    const all = await walkFiles(root, pattern);
    const { items, omitted } = truncateList(all, MAX_ENTRIES);
    return {
      files: items,
      total: all.length,
      ...(omitted > 0 && { note: `${omitted} more files not shown; use a narrower pattern.` }),
    };
  },
});
