import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./types.js";
import { looksBinary, MAX_FILE_BYTES, requireWorkspace } from "./workspace.js";
import { walkFiles } from "./walk.js";

const MAX_MATCHES = 200;
const MAX_LINE_CHARS = 200;

export const searchFilesTool = defineTool({
  name: "search_files",
  description:
    "Search file contents in the workspace with a regular expression (JavaScript syntax). " +
    "Optionally limit to files matching a glob. Returns matches as path:line: text, capped at 200.",
  inputSchema: z.object({
    pattern: z.string().describe("Regular expression to search for."),
    glob: z.string().optional().describe("Only search files matching this glob, e.g. '**/*.ts'."),
    caseSensitive: z.boolean().optional().describe("Defaults to false."),
  }),
  kind: "read",
  surfaces: ["cli"],
  summarize: (input) => `search_files /${input.pattern}/${input.glob ? ` in ${input.glob}` : ""}`,
  async execute(input, ctx) {
    const root = requireWorkspace(ctx);
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, input.caseSensitive ? "" : "i");
    } catch (err) {
      throw new Error(`Invalid regular expression: ${(err as Error).message}`, { cause: err });
    }
    const glob = input.glob ?? "**/*";
    if (glob.includes("..")) throw new Error("Globs may not contain '..'.");

    const matches: string[] = [];
    let filesSearched = 0;
    for (const rel of await walkFiles(root, glob)) {
      const abs = path.join(root, rel);
      const info = await stat(abs).catch(() => null);
      if (!info || info.size > MAX_FILE_BYTES) continue;
      const buf = await readFile(abs);
      if (looksBinary(buf)) continue;
      filesSearched++;
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!regex.test(line)) continue;
        const text = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
        matches.push(`${rel}:${i + 1}: ${text.trim()}`);
        if (matches.length >= MAX_MATCHES) {
          return {
            matches,
            filesSearched,
            note: `Stopped at ${MAX_MATCHES} matches; narrow the pattern or glob.`,
          };
        }
      }
    }
    return { matches, filesSearched };
  },
});
