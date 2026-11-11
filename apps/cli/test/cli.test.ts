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

describe("createSerialQueue", () => {
  it("runs tasks one at a time in call order, even after a failure", async () => {
    const { createSerialQueue } = await import("../src/queue.js");
    const enqueue = createSerialQueue();
    const log: string[] = [];
    let running = 0;
    const task = (name: string, ms: number, fail = false) =>
      enqueue(async () => {
        running++;
        expect(running).toBe(1);
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`end ${name}`);
        running--;
        if (fail) throw new Error(name);
        return name;
      });
    const results = await Promise.allSettled([task("a", 30), task("b", 5, true), task("c", 1)]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});

describe("RepoPilot commands", () => {
  it("parses task, explain and tests into interactive sessions", async () => {
    const { EXPLAIN_PROMPT } = await import("../src/args.js");
    expect(parseArgs(["task", "add", "a", "flag"])).toEqual({
      command: "chat",
      task: true,
      initialPrompt: "add a flag",
    });
    expect(parseArgs(["explain", "-m", "x/y"])).toEqual({
      command: "chat",
      model: "x/y",
      initialPrompt: EXPLAIN_PROMPT,
    });
    expect(parseArgs(["tests", "src/a.ts"])).toMatchObject({
      command: "chat",
      initialPrompt: expect.stringContaining("Write unit tests for src/a.ts"),
    });
  });

  it("requires an instruction or path", () => {
    expect(() => parseArgs(["task"])).toThrow(/needs an instruction/);
    expect(() => parseArgs(["tests"])).toThrow(/needs a file or folder/);
  });
});

describe("parseArgs: study and api", () => {
  it("parses mofu study with an optional page range", () => {
    expect(parseArgs(["study", "notes.pdf"])).toEqual({ command: "chat", study: "notes.pdf" });
    expect(parseArgs(["study", "book.pdf", "--pages", "10-40"])).toEqual({
      command: "chat",
      study: "book.pdf",
      pages: "10-40",
    });
    expect(parseArgs(["study", "--pages=3", "a.pdf"])).toEqual({
      command: "chat",
      study: "a.pdf",
      pages: "3",
    });
    expect(() => parseArgs(["study"])).toThrow(/needs a PDF/);
  });

  it("parses the mofu api subcommands", () => {
    expect(parseArgs(["api", "docs", "openapi.yaml"])).toEqual({
      command: "api",
      sub: "docs",
      spec: "openapi.yaml",
    });
    expect(parseArgs(["api", "diff", "v1.yaml", "v2.yaml", "-m", "x/y"])).toEqual({
      command: "api",
      sub: "diff",
      spec: "v1.yaml",
      spec2: "v2.yaml",
      model: "x/y",
    });
    expect(
      parseArgs([
        "api",
        "test",
        "spec.json",
        "--base-url",
        "http://localhost:4010",
        "--auth-header=X-API-Key: k",
        "--concurrency",
        "2",
        "--timeout",
        "500",
        "--yes",
      ]),
    ).toEqual({
      command: "api",
      sub: "test",
      spec: "spec.json",
      baseUrl: "http://localhost:4010",
      authHeader: "X-API-Key: k",
      concurrency: 2,
      timeoutMs: 500,
      yes: true,
    });
  });

  it("rejects bad api arguments", () => {
    expect(() => parseArgs(["api"])).toThrow(/Usage: mofu api/);
    expect(() => parseArgs(["api", "diff", "only-one.yaml"])).toThrow(/Usage/);
    expect(() => parseArgs(["api", "test", "s.yaml"])).toThrow(/needs --base-url/);
    expect(() => parseArgs(["api", "test", "s.yaml", "--base-url", "localhost:3000"])).toThrow(
      /http/,
    );
    expect(() => parseArgs(["api", "docs", "s.yaml", "--base-url", "http://x"])).toThrow(
      /only apply/,
    );
    expect(() =>
      parseArgs(["api", "test", "s.yaml", "--base-url", "http://x", "--concurrency", "99"]),
    ).toThrow(/1 to 16/);
    expect(() =>
      parseArgs(["api", "test", "s.yaml", "--base-url", "http://x", "--bogus", "1"]),
    ).toThrow(/Unknown option --bogus/);
  });
});
