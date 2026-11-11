import path from "node:path";
import { defineConfig } from "vitest/config";

const core = (file: string) => path.resolve(import.meta.dirname, "packages/core/src", file);

export default defineConfig({
  resolve: {
    // Test against the TypeScript sources, not built output. Exact matches only,
    // so "@mofu/core" doesn't swallow "@mofu/core/web".
    alias: [
      { find: /^@mofu\/core$/, replacement: core("index.ts") },
      { find: /^@mofu\/core\/web$/, replacement: core("web.ts") },
      { find: /^@mofu\/core\/apiforge$/, replacement: core("apiforge.ts") },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
