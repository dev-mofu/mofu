import { createApp, defaultDeps } from "./app.js";
import { createMcpApp } from "./mcp.js";
import { createPagesApp, isPagesPath } from "./pages.js";
import { createPublicApi, isPublicApiPath } from "./public-api.js";

export { UsageLimiter } from "./usage-limiter.js";
export { VoteStore } from "./vote-store.js";
export { StatsStore } from "./stats-store.js";
export { WebhookStore } from "./webhook-store.js";
export { VerdictPublisher } from "./verdict-store.js";
export { RadarStore } from "./radar.js";

const app = createApp();
const mcp = createMcpApp(defaultDeps);
const pages = createPagesApp(defaultDeps);
const api = createPublicApi(defaultDeps);

export default {
  fetch: (req, env, ctx) => {
    const path = new URL(req.url).pathname;
    if (path === "/mcp") return mcp.fetch(req, env, ctx);
    if (isPublicApiPath(path)) return api.fetch(req, env, ctx);
    if (isPagesPath(path)) return pages.fetch(req, env, ctx);
    return app.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
