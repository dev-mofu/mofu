import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

/**
 * Default model: cheap and reliable at tool calling. Override with --model,
 * MOFU_MODEL or the config file. Check current prices at openrouter.ai/models.
 */
export const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";

/** Ollama's OpenAI-compatible endpoint; LM Studio uses http://localhost:1234/v1. */
export const DEFAULT_LOCAL_URL = "http://localhost:11434/v1";

export interface ModelOptions {
  apiKey: string;
  modelId: string;
  /**
   * An OpenAI-compatible server to use instead of OpenRouter: a local model (Ollama, LM Studio,
   * llama.cpp, vLLM) or any compatible endpoint. The key is sent only if one is given.
   */
  baseURL?: string;
}

/** Creates the model. Holds no global state, so web requests can use per-request keys. */
export function createModel({ apiKey, modelId, baseURL }: ModelOptions): LanguageModel {
  if (baseURL) {
    const local = createOpenAICompatible({
      name: "local",
      baseURL: baseURL.replace(/\/+$/, ""),
      ...(apiKey && apiKey !== "local" ? { apiKey } : {}),
      includeUsage: true,
    });
    return local(modelId);
  }
  const openrouter = createOpenRouter({
    apiKey,
    // OpenRouter uses these to attribute traffic to the app.
    headers: { "X-Title": "Mofu", "HTTP-Referer": "https://www.npmjs.com/package/mofu-cli" },
  });
  return openrouter(modelId);
}

/** Models a local OpenAI-compatible server offers (GET /models). Empty when it can't be reached. */
export async function listLocalModels(
  baseURL: string,
  fetchFn: typeof fetch = fetch,
): Promise<string[] | null> {
  try {
    const res = await fetchFn(`${baseURL.replace(/\/+$/, "")}/models`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
  } catch {
    return null;
  }
}
