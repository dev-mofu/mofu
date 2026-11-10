import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test against the TypeScript sources, not built output.
    alias: { "@mofu/core": path.resolve(import.meta.dirname, "packages/core/src/index.ts") },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
