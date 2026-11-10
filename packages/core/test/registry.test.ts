import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ALL_TOOLS,
  capResult,
  createDefaultRegistry,
  defineTool,
  MAX_RESULT_CHARS,
  ToolRegistry,
  truncateList,
  truncateText,
} from "../src/index.js";

describe("ToolRegistry", () => {
  it("filters tools by surface", () => {
    const registry = createDefaultRegistry();
    const web = registry.forSurface("web").map((t) => t.name);
    const cli = registry.forSurface("cli").map((t) => t.name);
    expect(web.sort()).toEqual(["define_word", "save_memory", "wikipedia_summary"]);
    expect(cli).toEqual(ALL_TOOLS.map((t) => t.name));
  });

  it("never exposes file or command tools on the web", () => {
    const web = createDefaultRegistry().forSurface("web");
    const sideEffects = web.filter((t) => t.kind !== "read").map((t) => t.name);
    // save_memory is the only write tool on the web; it writes to the user's own browser storage.
    expect(sideEffects).toEqual(["save_memory"]);
    expect(web.some((t) => t.kind === "exec")).toBe(false);
  });

  it("rejects duplicate and non-snake_case names", () => {
    const t = defineTool({
      name: "ok_name",
      description: "x",
      inputSchema: z.object({}),
      kind: "read",
      surfaces: ["cli"],
      execute: async () => null,
    });
    const registry = new ToolRegistry([t as never]);
    expect(() => registry.register(t as never)).toThrow(/Duplicate/);
    expect(() => new ToolRegistry([{ ...t, name: "BadName" } as never])).toThrow(/snake_case/);
  });

  it("builds an AI SDK tool set for a surface", () => {
    const set = createDefaultRegistry().toToolSet("web", { approve: async () => true });
    expect(Object.keys(set).sort()).toEqual(["define_word", "save_memory", "wikipedia_summary"]);
  });
});

describe("truncation", () => {
  it("truncates long text and says how much was cut", () => {
    expect(truncateText("abcdef", 3)).toBe("abc\n…[truncated 3 more characters]");
    expect(truncateText("abc", 3)).toBe("abc");
  });

  it("truncates lists", () => {
    expect(truncateList([1, 2, 3], 2)).toEqual({ items: [1, 2], omitted: 1 });
  });

  it("caps oversized tool results", () => {
    const big = { data: "x".repeat(MAX_RESULT_CHARS + 10) };
    const capped = capResult(big) as { truncated: boolean; partialJson: string };
    expect(capped.truncated).toBe(true);
    expect(capped.partialJson.length).toBeLessThan(MAX_RESULT_CHARS + 100);
    expect(capResult({ small: 1 })).toEqual({ small: 1 });
  });
});
