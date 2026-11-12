import { createApp, defaultDeps } from "./app.js";
import { createMcpApp } from "./mcp.js";

export { UsageLimiter } from "./usage-limiter.js";
export { VoteStore } from "./vote-store.js";
export { StatsStore } from "./stats-store.js";

const app = createApp();
const mcp = createMcpApp(defaultDeps);

export default {
  fetch: (req, env, ctx) =>
    new URL(req.url).pathname === "/mcp" ? mcp.fetch(req, env, ctx) : app.fetch(req, env, ctx),
} satisfies ExportedHandler<Env>;
