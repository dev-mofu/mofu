import { listLocalModels } from "@mofu/core";
/**
 * Where the CLI's model calls go: OpenRouter (default) or a local OpenAI-compatible server
 * (mofu --local, --base-url, MOFU_BASE_URL). Set once at startup.
 */
let baseURL: string | undefined;

export function setModelTarget(url: string | undefined): void {
  baseURL = url;
}

/** Spread into createModel options. */
export const modelTarget = (): { baseURL?: string } => (baseURL ? { baseURL } : {});

export const isLocal = () => !!baseURL;

/**
 * The model to use on a local server: the one asked for, else the first one it has. Says what to
 * do when the server isn't running or has no models.
 */
export async function pickLocalModel(
  baseURL: string,
  wanted: string | undefined,
  list: (url: string) => Promise<string[] | null> = listLocalModels,
): Promise<{ model: string } | { error: string }> {
  if (wanted) return { model: wanted };
  const models = await list(baseURL);
  if (models === null)
    return {
      error: `Can't reach a model server at ${baseURL}. Start Ollama (ollama serve) or LM Studio's server, or pass --base-url.`,
    };
  if (models.length === 0)
    return {
      error: `${baseURL} has no models. Pull one with tool calling, e.g. ollama pull qwen2.5-coder, then pass -m qwen2.5-coder.`,
    };
  return { model: models[0]! };
}
