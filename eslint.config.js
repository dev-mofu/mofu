import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "mascot/**",
      "prompts/**",
      "coverage/**",
      "**/.wrangler/**",
      "**/worker-configuration.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // The embeddable widget: a plain browser script served from mofu.works.
    files: ["apps/web/public/widget.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        window: "readonly",
        document: "readonly",
        fetch: "readonly",
        URL: "readonly",
        MutationObserver: "readonly",
      },
    },
  },
  {
    // Plain Node build/deploy scripts.
    files: ["**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", URL: "readonly" },
    },
  },
);
