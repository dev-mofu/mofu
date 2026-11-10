import { z } from "zod";
import { defineTool } from "./types.js";
import { displayPath, readTextFile, requireWorkspace, resolveInWorkspace } from "./workspace.js";
import { truncateText } from "./truncate.js";

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "Read a text file from the workspace. For large files, pass startLine/endLine (1-based, inclusive). " +
    "Returns the content plus the line range and total line count.",
  inputSchema: z.object({
    path: z.string().describe("Path relative to the workspace root."),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
  }),
  kind: "read",
  surfaces: ["cli"],
  summarize: (input) =>
    `read_file ${input.path}${input.startLine ? `:${input.startLine}-${input.endLine ?? ""}` : ""}`,
  async execute(input, ctx) {
    const root = requireWorkspace(ctx);
    const abs = await resolveInWorkspace(root, input.path);
    const lines = (await readTextFile(abs)).split(/\r?\n/);
    const start = input.startLine ?? 1;
    const end = Math.min(input.endLine ?? lines.length, lines.length);
    if (start > lines.length) {
      throw new Error(`startLine ${start} is past the end of the file (${lines.length} lines).`);
    }
    return {
      path: displayPath(root, abs),
      startLine: start,
      endLine: end,
      totalLines: lines.length,
      content: truncateText(lines.slice(start - 1, end).join("\n")),
    };
  },
});
