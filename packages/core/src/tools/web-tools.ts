import type { MofuTool } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { wikipediaSummaryTool } from "./wikipedia.js";
import { defineWordTool } from "./define-word.js";
import { saveMemoryTool } from "./save-memory.js";
import { REFERENCE_TOOLS } from "../study/references.js";

/**
 * Tools with no Node.js dependencies, safe to bundle into the Cloudflare
 * Worker. File and command tools live in all.ts and never reach the web.
 */
export const WEB_SAFE_TOOLS: MofuTool[] = [
  wikipediaSummaryTool,
  defineWordTool,
  saveMemoryTool,
  ...REFERENCE_TOOLS,
] as MofuTool[];

export function createWebRegistry(): ToolRegistry {
  return new ToolRegistry(WEB_SAFE_TOOLS);
}
