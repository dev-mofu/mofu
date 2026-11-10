import { describe, expect, it } from "vitest";
import {
  assertAllowedCommand,
  branchNameFor,
  buildRepoOverview,
  buildTree,
  detectTestCommand,
  formatOverview,
  summarizeTestOutput,
  type RepoSnapshot,
} from "../src/index.js";

function snapshot(files: Record<string, string>, extra: string[] = []): RepoSnapshot {
  return {
    files: [...Object.keys(files), ...extra],
    readFile: async (p) => files[p] ?? null,
  };
}

const pkg = (scripts: Record<string, string>, devDependencies: Record<string, string> = {}) =>
  JSON.stringify({ name: "demo", scripts, devDependencies });

describe("detectTestCommand", () => {
  it.each([
    ["pnpm-lock.yaml", "pnpm test"],
    ["yarn.lock", "yarn test"],
    ["package-lock.json", "npm test"],
    ["bun.lock", "bun test"],
  ])("uses the package manager from %s", async (lockfile, command) => {
    const snap = snapshot({
      "package.json": pkg({ test: "vitest run" }, { vitest: "^5" }),
      [lockfile]: "",
    });
    expect(await detectTestCommand(snap)).toMatchObject({ command, framework: "vitest" });
  });

  it("ignores npm's placeholder test script and falls back to the framework", async () => {
    const snap = snapshot({
      "package.json": pkg({ test: 'echo "Error: no test specified" && exit 1' }, { jest: "^30" }),
    });
    expect(await detectTestCommand(snap)).toMatchObject({ command: "npx jest", framework: "jest" });
  });

  it("detects pytest with the right runner", async () => {
    expect(await detectTestCommand(snapshot({ "tests/test_app.py": "" }))).toMatchObject({
      command: "python -m pytest",
    });
    expect(
      await detectTestCommand(
        snapshot({ "pyproject.toml": "[tool.pytest.ini_options]", "uv.lock": "" }),
      ),
    ).toMatchObject({ command: "uv run pytest" });
    expect(
      await detectTestCommand(snapshot({ "conftest.py": "", "poetry.lock": "" })),
    ).toMatchObject({ command: "poetry run pytest" });
  });

  it("detects go and cargo, and returns null when there's nothing", async () => {
    expect((await detectTestCommand(snapshot({ "go.mod": "module x" })))?.command).toBe(
      "go test ./...",
    );
    expect((await detectTestCommand(snapshot({ "Cargo.toml": "" })))?.command).toBe("cargo test");
    expect(await detectTestCommand(snapshot({ "README.md": "hi" }))).toBeNull();
  });
});

describe("buildRepoOverview", () => {
  it("summarizes a JS project", async () => {
    const snap = snapshot(
      {
        "package.json": JSON.stringify({
          name: "web-app",
          main: "dist/index.js",
          bin: { webapp: "./bin/cli.js" },
          scripts: { dev: "vite", test: "vitest run" },
          dependencies: { react: "^19", hono: "^4" },
          devDependencies: { vitest: "^5", vite: "^8" },
        }),
        "pnpm-lock.yaml": "",
        "README.md": "# Web app\nDoes things.",
        "tsconfig.json": "{}",
        ".github/workflows/ci.yml": "",
        "src/index.ts": "",
      },
      ["src/components/Button.tsx", "src/lib/util.ts"],
    );
    const o = await buildRepoOverview(snap);
    expect(o.name).toBe("web-app");
    expect(o.packageManagers).toEqual(["pnpm"]);
    expect(o.frameworks).toEqual(expect.arrayContaining(["React", "Hono", "Vite"]));
    expect(o.entryPoints).toEqual(["dist/index.js", "bin/cli.js", "src/index.ts"]);
    expect(o.test?.command).toBe("pnpm test");
    expect(o.languages[0]).toMatchObject({ language: "TypeScript", files: 3, share: 100 });
    expect(o.configFiles).toEqual(
      expect.arrayContaining(["tsconfig.json", ".github/workflows/ci.yml"]),
    );
    expect(o.readme).toContain("Does things");
    const text = formatOverview(o);
    expect(text).toContain("Tests: `pnpm test`");
    expect(text).toContain("src/ (3 files)");
  });

  it("detects Python frameworks from requirements and entry points", async () => {
    const o = await buildRepoOverview(
      snapshot({ "requirements.txt": "fastapi==0.120\npandas>=2\nuvicorn", "main.py": "" }),
    );
    expect(o.frameworks).toEqual(["FastAPI", "pandas"]);
    expect(o.entryPoints).toEqual(["main.py"]);
    expect(o.packageManagers).toEqual(["pip"]);
  });

  it("caps the README excerpt", async () => {
    const o = await buildRepoOverview(snapshot({ "README.md": "x".repeat(5000) }));
    expect(o.readme?.length).toBeLessThanOrEqual(1501);
  });
});

describe("buildTree", () => {
  it("limits depth and line count", () => {
    const files = Array.from({ length: 300 }, (_, i) => `a/b/c/d/e/f${i}.ts`).concat(
      Array.from({ length: 300 }, (_, i) => `dir${i}/x.ts`),
    );
    const tree = buildTree(files, 3, 50);
    expect(tree.split("\n").length).toBeLessThanOrEqual(51);
    expect(tree).toContain("(tree truncated)");
    expect(buildTree(["a/b/c/d/e.ts"], 2)).not.toContain("c/");
  });
});

describe("summarizeTestOutput", () => {
  it.each([
    [
      " Test Files  2 passed (2)\n      Tests  12 passed | 1 skipped (13)",
      "12 passed | 1 skipped (13)",
    ],
    ["Tests:       1 failed, 5 passed, 6 total", "1 failed, 5 passed, 6 total"],
    ["===== 2 failed, 10 passed in 0.31s =====", "2 failed, 10 passed"],
    ["test result: ok. 4 passed; 0 failed", "ok. 4 passed; 0 failed"],
    ["--- FAIL: TestX (0.00s)\nFAIL\tpkg\t0.01s", "1 failed"],
  ])("reads %j", (output, expected) => {
    expect(summarizeTestOutput(output)).toBe(expected);
  });
});

describe("git safety helpers", () => {
  it("builds clean branch names", () => {
    expect(branchNameFor("Add Dark Mode!")).toBe("mofu/add-dark-mode");
    expect(branchNameFor("Ünïcödé & spaces  ")).toBe("mofu/unicode-spaces");
    expect(branchNameFor("!!!")).toBe("mofu/task");
    expect(branchNameFor("x".repeat(80)).length).toBe("mofu/".length + 50);
  });

  it.each([
    "git push --force",
    "git push -f origin main",
    "git push origin +main",
    "git push --force-with-lease",
    "cd repo; git push -uf origin x",
  ])("refuses force-push: %s", (cmd) => {
    expect(() => assertAllowedCommand(cmd)).toThrow(/Force-pushing/);
  });

  it.each(["git push -u origin mofu/x", "git status", "npm test -- --force-exit", "git fetch -f"])(
    "allows: %s",
    (cmd) => {
      expect(() => assertAllowedCommand(cmd)).not.toThrow();
    },
  );
});
