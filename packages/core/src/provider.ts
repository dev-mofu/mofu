import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

/**
 * Default model: cheap and reliable at tool calling. Override with --model,
 * MOFU_MODEL or the config file. Check current prices at openrouter.ai/models.
 */
export const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";

export interface ModelOptions {
  apiKey: string;
  modelId: string;
}

/** Creates an OpenRouter-backed model. Holds no global state, so web requests can use per-request keys. */
export function createModel({ apiKey, modelId }: ModelOptions): LanguageModel {
  const openrouter = createOpenRouter({
    apiKey,
    // OpenRouter uses these to attribute traffic to the app.
    headers: { "X-Title": "Mofu", "HTTP-Referer": "https://www.npmjs.com/package/mofu-cli" },
  });
  return openrouter(modelId);
}
