// Bundles the CLI and the parts of @mofu/core it uses into dist/, so the published
// `mofu` package is self-contained. Third-party packages stay external: they're
// regular dependencies in package.json.
import { readFileSync, rmSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
rmSync(new URL("./dist", import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: {
    index: "src/index.ts",
    // NodePythonSandbox starts this file as a worker thread, next to index.js.
    "pyodide-node-worker": "../../packages/core/src/data/pyodide-node-worker.ts",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Read @mofu/core from its TypeScript sources (see the "mofu-source" export condition).
  conditions: ["mofu-source"],
  external: Object.keys(pkg.dependencies),
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});
