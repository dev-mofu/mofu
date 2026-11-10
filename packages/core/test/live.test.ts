import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  createDefaultRegistry,
  createModel,
  DEFAULT_MODEL,
  runTurn,
} from "../src/index.js";

/**
 * Makes ONE real, billed model call. Runs only with MOFU_LIVE_TEST=1 and
 * OPENROUTER_API_KEY set. Uses MOFU_MODEL or the default cheap model.
 */
const live = process.env.MOFU_LIVE_TEST === "1" && Boolean(process.env.OPENROUTER_API_KEY);

describe.skipIf(!live)("live smoke test", () => {
  it("answers a short question", async () => {
    const result = await runTurn({
      model: createModel({
        apiKey: process.env.OPENROUTER_API_KEY ?? "",
        modelId: process.env.MOFU_MODEL || DEFAULT_MODEL,
      }),
      instructions: buildSystemPrompt({ surface: "web" }),
      messages: [{ role: "user", content: "Reply with exactly the word: pong" }],
      tools: createDefaultRegistry().toToolSet("web", { approve: async () => false }),
      limits: { maxSteps: 1, maxOutputTokens: 20 },
    });
    expect(result.text.toLowerCase()).toContain("pong");
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  }, 60_000);
});
