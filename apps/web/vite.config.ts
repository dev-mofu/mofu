import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), cloudflare()],
  resolve: {
    // Use the core package's TypeScript sources directly, in both the browser and the Worker.
    alias: {
      "@mofu/core/web": path.resolve(import.meta.dirname, "../../packages/core/src/web.ts"),
      "@mofu/core/apiforge": path.resolve(
        import.meta.dirname,
        "../../packages/core/src/apiforge.ts",
      ),
    },
  },
  environments: {
    client: {
      build: {
        // Three pages: the landing page at /, docs at /docs/ and the React app at /app/.
        rollupOptions: {
          input: {
            landing: path.resolve(import.meta.dirname, "index.html"),
            app: path.resolve(import.meta.dirname, "app/index.html"),
            docs: path.resolve(import.meta.dirname, "docs/index.html"),
            privacy: path.resolve(import.meta.dirname, "privacy/index.html"),
            terms: path.resolve(import.meta.dirname, "terms/index.html"),
            town: path.resolve(import.meta.dirname, "town/index.html"),
            guard: path.resolve(import.meta.dirname, "guard/index.html"),
            verify: path.resolve(import.meta.dirname, "verify/index.html"),
            devlog: path.resolve(import.meta.dirname, "devlog/index.html"),
            stats: path.resolve(import.meta.dirname, "stats/index.html"),
          },
        },
      },
    },
  },
});
