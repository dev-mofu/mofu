import { createApp } from "./app.js";

export { UsageLimiter } from "./usage-limiter.js";

const app = createApp();

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
