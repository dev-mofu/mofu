import { describe, expect, it } from "vitest";
import { auditSolidity } from "@mofu/core";
import { ArgsError, extractTarget, HELP, parseArgs } from "../src/args.js";
import { checkKitOptions, KitError, kitFiles } from "../src/launchkit.js";
import { modelTarget, pickLocalModel, setModelTarget } from "../src/target.js";

describe("local models", () => {
  it("pulls --local and --base-url out of argv, leaving mofu api test's own --base-url", () => {
    expect(extractTarget(["--local", "task", "x"])).toEqual({ argv: ["task", "x"], local: true });
    expect(extractTarget(["--base-url", "http://localhost:1234/v1", "hi"])).toEqual({
      argv: ["hi"],
      local: false,
      baseUrl: "http://localhost:1234/v1",
    });
    expect(
      extractTarget(["api", "test", "s.yaml", "--base-url", "http://localhost:3000"]).argv,
    ).toEqual(["api", "test", "s.yaml", "--base-url", "http://localhost:3000"]);
    expect(() => extractTarget(["--base-url", "localhost"])).toThrow(ArgsError);
    expect(HELP).toContain("--local");
  });

  it("picks the asked model, else the first one the server has, and explains failures", async () => {
    expect(await pickLocalModel("http://x/v1", "llama3.1")).toEqual({ model: "llama3.1" });
    expect(
      await pickLocalModel("http://x/v1", undefined, async () => ["qwen2.5-coder:7b", "b"]),
    ).toEqual({
      model: "qwen2.5-coder:7b",
    });
    const down = await pickLocalModel("http://x/v1", undefined, async () => null);
    expect("error" in down && down.error).toContain("Can't reach a model server");
    const empty = await pickLocalModel("http://x/v1", undefined, async () => []);
    expect("error" in empty && empty.error).toContain("ollama pull");
  });

  it("sends model calls to the local server once set", () => {
    setModelTarget(undefined);
    expect(modelTarget()).toEqual({});
    setModelTarget("http://localhost:11434/v1");
    expect(modelTarget()).toEqual({ baseURL: "http://localhost:11434/v1" });
    setModelTarget(undefined);
  });
});

describe("mofu docs", () => {
  it("starts a docs session", () => {
    expect(parseArgs(["docs"])).toMatchObject({ command: "chat", docs: true });
    expect(
      (parseArgs(["docs", "the", "API", "reference"]) as { initialPrompt: string }).initialPrompt,
    ).toContain("the API reference");
    expect(HELP).toContain("mofu docs");
  });
});

describe("launch kit", () => {
  it("parses its arguments", () => {
    expect(
      parseArgs([
        "launch-kit",
        "kit",
        "--name",
        "Kitty Coin",
        "--symbol",
        "KITTY",
        "--supply",
        "1000",
      ]),
    ).toEqual({
      command: "launch-kit",
      dir: "kit",
      name: "Kitty Coin",
      symbol: "KITTY",
      supply: "1000",
    });
    expect(() => parseArgs(["launch-kit", "--name", "X"])).toThrow(/Usage: mofu launch-kit/);
  });

  it("checks the name, symbol and supply", () => {
    expect(checkKitOptions({ name: " Kitty Coin ", symbol: "kitty", supply: "1_000,000" })).toEqual(
      {
        name: "Kitty Coin",
        symbol: "KITTY",
        supply: "1000000",
      },
    );
    expect(() => checkKitOptions({ name: 'a"b', symbol: "AB", supply: "1" })).toThrow(KitError);
    expect(() => checkKitOptions({ name: "A", symbol: "A", supply: "1" })).toThrow(/symbol/);
    expect(() => checkKitOptions({ name: "A", symbol: "AB", supply: "0" })).toThrow(/supply/);
    expect(() => checkKitOptions({ name: "A", symbol: "AB", supply: "1".repeat(16) })).toThrow(
      /supply/,
    );
  });

  it("writes a Foundry project whose token Mofu's audit calls clean", () => {
    const files = kitFiles({ name: "Kitty Coin", symbol: "KITTY", supply: "1000000000" });
    expect(Object.keys(files).sort()).toEqual([
      ".gitignore",
      "README.md",
      "foundry.toml",
      "src/KittyCoin.sol",
      "test/KittyCoin.t.sol",
    ]);
    const sol = files["src/KittyCoin.sol"]!;
    expect(sol).toContain('string public constant symbol = "KITTY";');
    expect(sol).toContain("uint256 supply = 1000000000 * 10 ** 18;");
    expect(sol).not.toMatch(/onlyOwner|Ownable|function\s+mint|_mint\(|selfdestruct/);
    const audit = auditSolidity("KittyCoin.sol", sol);
    expect(audit.verdict).toBe("clean");
    expect(audit.issues).toEqual([]);
    expect(files["test/KittyCoin.t.sol"]).toContain(
      'import {KittyCoin} from "../src/KittyCoin.sol";',
    );
    expect(files["README.md"]).toContain(
      "forge create src/KittyCoin.sol:KittyCoin --rpc-url robinhood --account deployer --broadcast",
    );
    expect(files["foundry.toml"]).toContain('solc_version = "0.8.24"');
  });
});
