import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL } from "@mofu/core";
import { parseArgs } from "../src/args.js";
import { configPath, loadConfig, resolveApiKey, resolveModel, saveConfig } from "../src/config.js";
import { colorizeDiff, formatApproval, oneLine } from "../src/ui.js";

describe("parseArgs", () => {
  it("parses commands, model and prompt", () => {
    expect(parseArgs([])).toEqual({ command: "chat" });
    expect(parseArgs(["auth"])).toEqual({ command: "auth" });
    expect(parseArgs(["--help"])).toEqual({ command: "help" });
    expect(parseArgs(["-m", "x/y", "what", "is", "this"])).toEqual({
      command: "chat",
      model: "x/y",
      prompt: "what is this",
    });
    expect(parseArgs(["--model=a/b"])).toEqual({ command: "chat", model: "a/b" });
    // "auth" inside a longer prompt is just text.
    expect(parseArgs(["auth", "flow", "explain"])).toMatchObject({ prompt: "auth flow explain" });
  });

  it("rejects unknown options and a missing model", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown option/);
    expect(() => parseArgs(["--model"])).toThrow(/needs a model ID/);
  });
});

describe("config", () => {
  const dirs: string[] = [];
  afterEach(async () =>
    Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))),
  );

  async function env(): Promise<NodeJS.ProcessEnv> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mofu-home-"));
    dirs.push(dir);
    return { MOFU_HOME: dir };
  }

  it("saves and merges config", async () => {
    const e = await env();
    await saveConfig({ apiKey: "sk-or-test" }, e);
    await saveConfig({ model: "m/1" }, e);
    expect(await loadConfig(e)).toEqual({ apiKey: "sk-or-test", model: "m/1" });
    expect(JSON.parse(await readFile(configPath(e), "utf8"))).toEqual({
      apiKey: "sk-or-test",
      model: "m/1",
    });
  });

  it("returns empty config for missing or invalid files", async () => {
    expect(await loadConfig(await env())).toEqual({});
  });

  it("resolves the key: env beats config", () => {
    expect(resolveApiKey({ OPENROUTER_API_KEY: "env" }, { apiKey: "cfg" })).toBe("env");
    expect(resolveApiKey({ OPENROUTER_API_KEY: " " }, { apiKey: "cfg" })).toBe("cfg");
    expect(resolveApiKey({}, {})).toBeUndefined();
  });

  it("resolves the model: flag, env, config, default", () => {
    expect(resolveModel("flag", { MOFU_MODEL: "env" }, { model: "cfg" })).toBe("flag");
    expect(resolveModel(undefined, { MOFU_MODEL: "env" }, { model: "cfg" })).toBe("env");
    expect(resolveModel(undefined, {}, { model: "cfg" })).toBe("cfg");
    expect(resolveModel(undefined, { MOFU_MODEL: "" }, {})).toBe(DEFAULT_MODEL);
  });
});

describe("ui", () => {
  it("shortens tool summaries to one line", () => {
    expect(oneLine("a\n  b")).toBe("a b");
    expect(oneLine("x".repeat(200))).toHaveLength(121);
  });

  it("renders commands and diffs for approval", () => {
    const cmd = formatApproval({
      toolName: "run_command",
      kind: "exec",
      title: "Run",
      detail: "npm test",
    });
    expect(cmd).toContain("$ npm test");
    expect(colorizeDiff("+a\n-b")).toContain("a");
  });
});
