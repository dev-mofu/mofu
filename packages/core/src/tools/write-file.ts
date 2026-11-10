import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { defineTool } from "./types.js";
import { displayPath, requireWorkspace, resolveInWorkspace } from "./workspace.js";

async function readIfExists(abs: string): Promise<string | null> {
  try {
    return await readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export const writeFileTool = defineTool({
  name: "write_file",
  description:
    "Create a new file or overwrite an existing one with the given content. " +
    "Prefer edit_file for small changes to existing files. The user must approve every write.",
  inputSchema: z.object({
    path: z.string().describe("Path relative to the workspace root."),
    content: z.string().describe("The complete new file content."),
  }),
  kind: "write",
  surfaces: ["cli"],
  summarize: (input) => `write_file ${input.path}`,
  async describeApproval(input, ctx) {
    const root = requireWorkspace(ctx);
    const abs = await resolveInWorkspace(root, input.path);
    const rel = displayPath(root, abs);
    const existing = await readIfExists(abs);
    if (existing === null) {
      const lines = input.content.split(/\r?\n/).length;
      return {
        toolName: "write_file",
        kind: "write",
        title: `Create ${rel} (${lines} lines)`,
        detail: input.content,
      };
    }
    return {
      toolName: "write_file",
      kind: "write",
      title: `Overwrite ${rel}`,
      detail: createTwoFilesPatch(rel, rel, existing, input.content, "", "", { context: 3 }),
    };
  },
  async execute(input, ctx) {
    const root = requireWorkspace(ctx);
    const abs = await resolveInWorkspace(root, input.path);
    const existed = (await readIfExists(abs)) !== null;
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, input.content, "utf8");
    return {
      path: displayPath(root, abs),
      created: !existed,
      bytes: Buffer.byteLength(input.content),
    };
  },
});
