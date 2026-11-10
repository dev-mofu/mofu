import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyEdit, DECLINED_RESULT, EditError, runTool } from "../src/index.js";
import { editFileTool } from "../src/tools/edit-file.js";
import { writeFileTool } from "../src/tools/write-file.js";
import { readFileTool } from "../src/tools/read-file.js";
import { listFilesTool } from "../src/tools/list-files.js";
import { searchFilesTool } from "../src/tools/search-files.js";
import { runCommandTool } from "../src/tools/run-command.js";
import type { MofuTool } from "../src/index.js";
import { tempDir, testContext } from "./helpers.js";

const asTool = (t: unknown) => t as MofuTool;

describe("applyEdit", () => {
  it("replaces a unique occurrence", () => {
    expect(applyEdit("a\nb\nc", "b", "B")).toBe("a\nB\nc");
  });

  it("fails when the old string is missing", () => {
    expect(() => applyEdit("abc", "zzz", "y")).toThrow(EditError);
    expect(() => applyEdit("abc", "zzz", "y")).toThrow(/not found/);
  });

  it("fails when the old string is not unique", () => {
    expect(() => applyEdit("x x", "x", "y")).toThrow(/appears 2 times/);
  });

  it("matches LF edits against CRLF files and keeps CRLF", () => {
    expect(applyEdit("one\r\ntwo\r\nthree", "one\ntwo", "1\n2")).toBe("1\r\n2\r\nthree");
  });

  it("treats $ in the replacement literally", () => {
    expect(applyEdit("price", "price", "$1 $&")).toBe("$1 $&");
  });
});

describe("edit_file", () => {
  it("shows a diff, applies the edit when approved", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, "f.ts"), "const a = 1;\n");
    const ctx = testContext(root, true);
    const out = await runTool(
      asTool(editFileTool),
      { path: "f.ts", oldString: "1", newString: "2" },
      ctx,
    );
    expect(out).toMatchObject({ status: "edited" });
    expect(ctx.requests[0]?.detail).toContain("-const a = 1;");
    expect(ctx.requests[0]?.detail).toContain("+const a = 2;");
    expect(await readFile(path.join(root, "f.ts"), "utf8")).toBe("const a = 2;\n");
  });

  it("leaves the file alone when declined", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, "f.ts"), "const a = 1;\n");
    const ctx = testContext(root, false);
    const out = await runTool(
      asTool(editFileTool),
      { path: "f.ts", oldString: "1", newString: "2" },
      ctx,
    );
    expect(out).toEqual(DECLINED_RESULT);
    expect(await readFile(path.join(root, "f.ts"), "utf8")).toBe("const a = 1;\n");
  });

  it("rejects an invalid edit before asking the user", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, "f.ts"), "x\n");
    const ctx = testContext(root, true);
    await expect(
      runTool(asTool(editFileTool), { path: "f.ts", oldString: "nope", newString: "y" }, ctx),
    ).rejects.toThrow(/not found/);
    expect(ctx.requests).toHaveLength(0);
  });
});

describe("write_file", () => {
  it("creates new files (including parent folders) and shows full content", async () => {
    const root = await tempDir();
    const ctx = testContext(root, true);
    const out = await runTool(
      asTool(writeFileTool),
      { path: "a/b/new.txt", content: "hello" },
      ctx,
    );
    expect(out).toMatchObject({ created: true, path: "a/b/new.txt" });
    expect(ctx.requests[0]).toMatchObject({
      title: "Create a/b/new.txt (1 lines)",
      detail: "hello",
    });
    expect(await readFile(path.join(root, "a/b/new.txt"), "utf8")).toBe("hello");
  });

  it("shows a diff when overwriting", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, "x.txt"), "old\n");
    const ctx = testContext(root, true);
    await runTool(asTool(writeFileTool), { path: "x.txt", content: "new\n" }, ctx);
    expect(ctx.requests[0]?.title).toBe("Overwrite x.txt");
    expect(ctx.requests[0]?.detail).toContain("-old");
  });

  it("refuses to write outside the workspace", async () => {
    const root = await tempDir();
    const ctx = testContext(root, true);
    await expect(
      runTool(asTool(writeFileTool), { path: "../escape.txt", content: "x" }, ctx),
    ).rejects.toThrow(/outside the workspace/);
    expect(ctx.requests).toHaveLength(0);
  });
});

describe("read tools", () => {
  it("read_file returns a line range", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, "f.txt"), "1\n2\n3\n4");
    const out = await runTool(
      asTool(readFileTool),
      { path: "f.txt", startLine: 2, endLine: 3 },
      testContext(root),
    );
    expect(out).toMatchObject({ content: "2\n3", totalLines: 4 });
  });

  it("read_file refuses binary files", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, "b.bin"), Buffer.from([1, 0, 2]));
    await expect(
      runTool(asTool(readFileTool), { path: "b.bin" }, testContext(root)),
    ).rejects.toThrow(/binary/);
  });

  it("list_files respects .gitignore and skips node_modules", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, ".gitignore"), "secret.txt\n");
    await writeFile(path.join(root, "keep.txt"), "");
    await writeFile(path.join(root, "secret.txt"), "");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "node_modules", "dep.js"), "");
    const out = (await runTool(asTool(listFilesTool), {}, testContext(root))) as {
      files: string[];
    };
    expect(out.files).toEqual([".gitignore", "keep.txt"]);
  });

  it("search_files finds matches with file and line", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, "a.ts"), "foo\nconst TODO = 1\n");
    const out = (await runTool(
      asTool(searchFilesTool),
      { pattern: "todo" },
      testContext(root),
    )) as {
      matches: string[];
    };
    expect(out.matches).toEqual(["a.ts:2: const TODO = 1"]);
  });
});

describe("run_command", () => {
  it("asks first and returns exit code and output", async () => {
    const root = await tempDir();
    const ctx = testContext(root, true);
    const out = (await runTool(asTool(runCommandTool), { command: "echo mofu" }, ctx)) as {
      exitCode: number;
      stdout: string;
    };
    expect(ctx.requests[0]).toMatchObject({ kind: "exec", detail: "echo mofu" });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("mofu");
  });

  it("does not run when declined", async () => {
    const root = await tempDir();
    const out = await runTool(
      asTool(runCommandTool),
      { command: "echo nope > made.txt" },
      testContext(root, false),
    );
    expect(out).toEqual(DECLINED_RESULT);
    await expect(readFile(path.join(root, "made.txt"))).rejects.toThrow();
  });
});
