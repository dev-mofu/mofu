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
    },
  },
});
