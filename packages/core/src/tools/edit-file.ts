import { writeFile } from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { defineTool } from "./types.js";
import { displayPath, readTextFile, requireWorkspace, resolveInWorkspace } from "./workspace.js";

export class EditError extends Error {
  override name = "EditError";
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (
    let i = haystack.indexOf(needle);
    i !== -1;
    i = haystack.indexOf(needle, i + needle.length)
  ) {
    count++;
  }
  return count;
}

/**
 * Replaces exactly one occurrence of `oldString`. Models usually write `\n`
 * line endings, so for CRLF files a LF-only match is retried with CRLF.
 */
export function applyEdit(original: string, oldString: string, newString: string): string {
  if (oldString.length === 0) throw new EditError("oldString must not be empty.");
  if (oldString === newString) throw new EditError("oldString and newString are identical.");

  const candidates: Array<[string, string]> = [[oldString, newString]];
  if (original.includes("\r\n") && !oldString.includes("\r\n")) {
    candidates.push([oldString.replace(/\n/g, "\r\n"), newString.replace(/\n/g, "\r\n")]);
  }

  for (const [oldS, newS] of candidates) {
    const count = countOccurrences(original, oldS);
    if (count === 1) return original.replace(oldS, () => newS);
    if (count > 1) {
      throw new EditError(
        `oldString appears ${count} times. Include more surrounding lines so it matches exactly once.`,
      );
    }
  }
  throw new EditError(
    "oldString was not found in the file. Read the file again and copy the text exactly, including whitespace.",
  );
}

export const editFileTool = defineTool({
  name: "edit_file",
  description:
    "Edit a file by replacing one exact occurrence of oldString with newString. oldString must match " +
    "the file exactly (including indentation) and appear exactly once; add surrounding lines if needed. " +
    "Read the file first. The user must approve every edit.",
  inputSchema: z.object({
    path: z.string().describe("Path relative to the workspace root."),
    oldString: z.string().describe("Exact text to replace. Must appear exactly once."),
    newString: z.string().describe("Replacement text."),
  }),
  kind: "write",
  surfaces: ["cli"],
  summarize: (input) => `edit_file ${input.path}`,
  async describeApproval(input, ctx) {
    const root = requireWorkspace(ctx);
    const abs = await resolveInWorkspace(root, input.path);
    const rel = displayPath(root, abs);
    const original = await readTextFile(abs);
    const updated = applyEdit(original, input.oldString, input.newString);
    return {
      toolName: "edit_file",
      kind: "write",
      title: `Edit ${rel}`,
      detail: createTwoFilesPatch(rel, rel, original, updated, "", "", { context: 3 }),
    };
  },
  async execute(input, ctx) {
    const root = requireWorkspace(ctx);
    const abs = await resolveInWorkspace(root, input.path);
    const original = await readTextFile(abs);
    await writeFile(abs, applyEdit(original, input.oldString, input.newString), "utf8");
    return { path: displayPath(root, abs), status: "edited" };
  },
});
