import { APICallError, LoadAPIKeyError, RetryError } from "ai";

export type MofuErrorKind =
  | "auth"
  | "credits"
  | "rate-limit"
  | "no-tool-support"
  | "model-not-found"
  | "network"
  | "aborted"
  | "api"
  | "unknown";

/** An error with a message safe to show the user. Never contains API keys. */
export class MofuError extends Error {
  override name = "MofuError";
  constructor(
    readonly kind: MofuErrorKind,
    message: string,
    readonly retryable = false,
  ) {
    super(redactSecrets(message));
  }
}

/** Removes anything that looks like an OpenRouter or bearer key. */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-or-[A-Za-z0-9-_]{8,}/g, "sk-or-…")
    .replace(/Bearer\s+[A-Za-z0-9-_.]{8,}/gi, "Bearer …");
}

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

function networkCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_CODES.has(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Maps SDK, HTTP and network failures to a MofuError with a clear, actionable message. */
export function toMofuError(err: unknown): MofuError {
  if (err instanceof MofuError) return err;
  if (RetryError.isInstance(err)) return toMofuError(err.lastError);

  if (err instanceof Error && err.name === "AbortError") {
    return new MofuError("aborted", "Stopped.");
  }
  if (LoadAPIKeyError.isInstance(err)) {
    return new MofuError(
      "auth",
      "No OpenRouter API key found. Run `mofu auth` or set OPENROUTER_API_KEY.",
    );
  }
  if (APICallError.isInstance(err)) {
    const status = err.statusCode;
    const body = `${err.message} ${err.responseBody ?? ""}`.toLowerCase();
    if (status === 401 || status === 403) {
      return new MofuError("auth", "OpenRouter rejected the API key. Check it with `mofu auth`.");
    }
    if (status === 402) {
      return new MofuError(
        "credits",
        "Your OpenRouter account is out of credits. Add credits at openrouter.ai.",
      );
    }
    if (status === 429) {
      return new MofuError(
        "rate-limit",
        "Rate limited by OpenRouter or the model provider. Wait a moment and try again.",
        true,
      );
    }
    if (status === 404 && body.includes("tool")) {
      return new MofuError(
        "no-tool-support",
        "This model doesn't support tool calling. Pick another model with /model.",
      );
    }
    if (status === 404 || (status === 400 && body.includes("not a valid model"))) {
      return new MofuError(
        "model-not-found",
        "OpenRouter doesn't know that model ID. Check it at openrouter.ai/models.",
      );
    }
    return new MofuError(
      "api",
      `The model request failed (HTTP ${status ?? "?"}): ${err.message}`,
      err.isRetryable,
    );
  }
  const code = networkCode(err);
  if (code) {
    return new MofuError(
      "network",
      `Can't reach OpenRouter (${code}). Check your internet connection.`,
      true,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new MofuError("unknown", message);
}
