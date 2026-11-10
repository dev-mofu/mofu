import type { MofuTool } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { listFilesTool } from "./list-files.js";
import { readFileTool } from "./read-file.js";
import { searchFilesTool } from "./search-files.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { runCommandTool } from "./run-command.js";
import { wikipediaSummaryTool } from "./wikipedia.js";
import { defineWordTool } from "./define-word.js";
import { saveMemoryTool } from "./save-memory.js";

/** Every built-in tool. Each declares which surfaces may use it. */
export const ALL_TOOLS: MofuTool[] = [
  listFilesTool,
  readFileTool,
  searchFilesTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
  wikipediaSummaryTool,
  defineWordTool,
  saveMemoryTool,
] as MofuTool[];

export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry(ALL_TOOLS);
}
