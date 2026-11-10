import { isStepCount, streamText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { toMofuError } from "./errors.js";

export interface AgentLimits {
  /** Model calls per user turn (each tool round trip is one step). */
  maxSteps: number;
  /** Output tokens per step. */
  maxOutputTokens: number;
}

export const DEFAULT_LIMITS: AgentLimits = { maxSteps: 12, maxOutputTokens: 4_000 };

export type AgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; output: unknown }
  | { type: "tool-error"; toolCallId: string; toolName: string; error: string }
  | { type: "step-finish" };

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TurnResult {
  /** Assistant and tool messages to append to the history. */
  responseMessages: ModelMessage[];
  text: string;
  usage: TurnUsage;
  finishReason: string;
  /** True when the turn stopped because it hit maxSteps. */
  hitStepLimit: boolean;
}

export interface RunTurnOptions {
  model: LanguageModel;
  instructions: string;
  messages: ModelMessage[];
  tools: ToolSet;
  limits?: Partial<AgentLimits>;
  onEvent?: (event: AgentEvent) => void;
  abortSignal?: AbortSignal;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts one agent turn and returns the raw AI SDK result. The web app
 * converts its stream into a UI message stream; the CLI uses runTurn.
 */
export function startAgentStream(opts: Omit<RunTurnOptions, "onEvent">) {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  return streamText({
    model: opts.model,
    instructions: opts.instructions,
    messages: opts.messages,
    tools: opts.tools,
    stopWhen: isStepCount(limits.maxSteps),
    maxOutputTokens: limits.maxOutputTokens,
    // Callers surface errors themselves; don't let the SDK print them.
    onError: () => {},
    ...(opts.abortSignal && { abortSignal: opts.abortSignal }),
  });
}

/**
 * Runs one user turn: the model may call tools for up to `maxSteps` steps.
 * Streams events to `onEvent`; throws MofuError on failure.
 */
export async function runTurn(opts: RunTurnOptions): Promise<TurnResult> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const result = startAgentStream(opts);

  let text = "";
  let steps = 0;
  let lastFinishReason = "unknown";
  try {
    for await (const part of result.stream) {
      switch (part.type) {
        case "text-delta":
          text += part.text;
          opts.onEvent?.({ type: "text-delta", text: part.text });
          break;
        case "tool-call":
          opts.onEvent?.({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          });
          break;
        case "tool-result":
          opts.onEvent?.({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: part.output,
          });
          break;
        case "tool-error":
          opts.onEvent?.({
            type: "tool-error",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            error: errorText(part.error),
          });
          break;
        case "finish-step":
          steps++;
          lastFinishReason = part.finishReason;
          opts.onEvent?.({ type: "step-finish" });
          break;
        case "error":
          throw part.error;
        case "abort":
          throw Object.assign(new Error("Aborted"), { name: "AbortError" });
        default:
          break;
      }
    }
    const [responseMessages, usage] = await Promise.all([result.responseMessages, result.usage]);
    return {
      responseMessages,
      text,
      usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
      finishReason: lastFinishReason,
      hitStepLimit: steps >= limits.maxSteps && lastFinishReason === "tool-calls",
    };
  } catch (err) {
    throw toMofuError(err);
  }
}
