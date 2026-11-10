import path from "node:path";
import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  FileMemoryStore,
  memoryForPrompt,
  MAX_MEMORY_CHARS,
  redactSecrets,
  runTool,
  toMofuError,
  type MofuTool,
} from "../src/index.js";
import { saveMemoryTool } from "../src/tools/save-memory.js";
import { tempDir, testContext } from "./helpers.js";

describe("FileMemoryStore", () => {
  it("appends, loads and clears facts", async () => {
    const store = new FileMemoryStore(path.join(await tempDir(), "sub", "memory.md"));
    expect(await store.load()).toBe("");
    await store.append("Prefers   TypeScript.");
    await store.append("Lives in Jakarta.");
    const text = await store.load();
    expect(text).toMatch(/^- Prefers TypeScript\. \(\d{4}-\d{2}-\d{2}\)\n- Lives in Jakarta\./);
    await store.clear();
    expect(await store.load()).toBe("");
  });

  it("save_memory asks for approval then saves", async () => {
    const memory = new FileMemoryStore(path.join(await tempDir(), "memory.md"));
    const ctx = { ...testContext(undefined, true), memory };
    await runTool(saveMemoryTool as unknown as MofuTool, { fact: "Likes dark mode." }, ctx);
    expect(ctx.requests[0]).toMatchObject({ title: "Remember this", detail: "Likes dark mode." });
    expect(await memory.load()).toContain("Likes dark mode.");
  });

  it("keeps the newest facts when memory is too long", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `- fact number ${i}`).join("\n");
    const out = memoryForPrompt(lines);
    expect(out.length).toBeLessThanOrEqual(MAX_MEMORY_CHARS);
    expect(out.endsWith("- fact number 399")).toBe(true);
    expect(out.startsWith("- fact")).toBe(true);
  });
});

describe("buildSystemPrompt", () => {
  it("includes environment and memory for the CLI", () => {
    const prompt = buildSystemPrompt({
      surface: "cli",
      memory: "- Prefers TypeScript.",
      workspaceRoot: "C:\\proj",
      shell: "Windows PowerShell",
      platform: "win32",
      now: new Date("2026-11-10T00:00:00Z"),
    });
    expect(prompt).toContain("Workspace: C:\\proj");
    expect(prompt).toContain("use ';' instead of '&&'");
    expect(prompt).toContain("2026-11-10");
    expect(prompt).toContain("- Prefers TypeScript.");
  });

  it("leaves CLI instructions out on the web", () => {
    expect(buildSystemPrompt({ surface: "web" })).not.toContain("Workspace:");
  });
});

describe("toMofuError", () => {
  const apiError = (statusCode: number, responseBody = "") =>
    new APICallError({
      message: "failed",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode,
      responseBody,
    });

  it.each([
    [401, "", "auth"],
    [402, "", "credits"],
    [429, "", "rate-limit"],
    [404, "No endpoints found that support tool use", "no-tool-support"],
    [404, "model not found", "model-not-found"],
    [500, "", "api"],
  ])("maps HTTP %i to %s", (status, body, kind) => {
    expect(toMofuError(apiError(status, body)).kind).toBe(kind);
  });

  it("maps network failures", () => {
    const err = new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    expect(toMofuError(err)).toMatchObject({ kind: "network", retryable: true });
  });

  it("never leaks keys in messages", () => {
    expect(redactSecrets("bad key sk-or-v1-abcdef1234567890")).toBe("bad key sk-or-…");
    expect(
      toMofuError(new Error("Bearer sk-or-v1-abcdef1234567890 rejected")).message,
    ).not.toContain("abcdef");
  });
});
