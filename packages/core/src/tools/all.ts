import type { MofuTool } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { listFilesTool } from "./list-files.js";
import { readFileTool } from "./read-file.js";
import { searchFilesTool } from "./search-files.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { runCommandTool } from "./run-command.js";
import { WEB_SAFE_TOOLS } from "./web-tools.js";
import { detectTestCommandTool, repoOverviewTool, runTestsTool } from "./repo-tools.js";
import {
  createPullRequestTool,
  gitCommitTool,
  gitCreateBranchTool,
  gitDiffTool,
  gitStatusTool,
} from "./git.js";
import { scanDependenciesTool } from "./deps-tool.js";

/** Every built-in tool. Each declares which surfaces may use it. */
export const ALL_TOOLS: MofuTool[] = [
  listFilesTool,
  readFileTool,
  searchFilesTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
  repoOverviewTool,
  detectTestCommandTool,
  runTestsTool,
  gitStatusTool,
  gitDiffTool,
  gitCreateBranchTool,
  gitCommitTool,
  createPullRequestTool,
  scanDependenciesTool,
  ...WEB_SAFE_TOOLS,
] as MofuTool[];

export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry(ALL_TOOLS);
}
