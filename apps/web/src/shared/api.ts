/** Types and constants shared by the Worker and the browser app. */

export const MODES = ["general", "data", "study", "dev"] as const;
export type Mode = (typeof MODES)[number];

export const MODE_LABELS: Record<Mode, string> = {
  general: "General",
  data: "Data Analyst",
  study: "Study Buddy",
  dev: "Dev Tools",
};

/** Modes that work today. The rest show "Coming soon" until their phase ships. */
export const AVAILABLE_MODES: readonly Mode[] = ["general", "data", "dev"];

/** Header carrying a user's own OpenRouter key. Never logged or stored server-side. */
export const BYOK_HEADER = "X-OpenRouter-Key";
/** Model choice; honored only together with BYOK_HEADER. */
export const MODEL_HEADER = "X-Mofu-Model";

/** Hard limits, enforced by the Worker. The UI only mirrors them. */
export const LIMITS = {
  maxBodyBytes: 200_000,
  maxMessages: 40,
  maxHistoryChars: 60_000,
  maxMemoryItems: 50,
  maxMemoryItemChars: 300,
  maxSteps: 6,
  maxOutputTokens: 2_000,
  timeoutMs: 90_000,
  /** Repository overview the browser builds and sends in Dev Tools mode. */
  maxContextChars: 16_000,
  sessionTtlMs: 2 * 60 * 60 * 1000,
} as const;

/** Suggested models for people using their own key. Any OpenRouter ID with tool support works. */
export const CURATED_MODELS = [
  { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5 (fast, cheap)" },
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5" },
  { id: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5 (most capable)" },
  { id: "qwen/qwen3.7-flash", label: "Qwen 3.7 Flash (cheapest)" },
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
] as const;

export type ApiErrorCode =
  | "session_required"
  | "daily_limit"
  | "free_tier_disabled"
  | "bad_request"
  | "too_large"
  | "invalid_key"
  | "forbidden_origin"
  | "server_error";

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  /** ISO time when the daily limit resets (daily_limit only). */
  resetAt?: string;
  limit?: number;
}

/** Extra material the browser gathered for the model, e.g. a GitHub repository overview. */
export type ChatContext =
  | {
      kind: "github-repo";
      /** owner/repo */
      title: string;
      text: string;
    }
  | { kind: "dep-scan"; title: string; text: string }
  /** Profile of the user's file, built in the browser. */
  | { kind: "dataset"; title: string; text: string };

export interface UsageInfo {
  freeTierEnabled: boolean;
  limit: number;
  remaining: number;
  resetAt: string;
}

export interface PublicConfig {
  turnstileSiteKey: string;
  defaultModel: string;
  freeDailyLimit: number;
  freeTierEnabled: boolean;
}

export interface SessionResponse {
  expiresAt: string;
}

export interface KeyCheckResponse {
  valid: boolean;
  /** Credit left on the key, in USD, when the key has a limit. */
  limitRemaining?: number | null;
}

/** Parses an error thrown by the chat transport (its message is the response body). */
export function parseApiError(err: unknown): ApiError | null {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  try {
    const parsed = JSON.parse(text) as Partial<ApiError>;
    if (parsed && typeof parsed.code === "string" && typeof parsed.message === "string") {
      return parsed as ApiError;
    }
  } catch {
    // Not one of ours.
  }
  return null;
}
