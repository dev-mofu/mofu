# @mofu/web

The Mofu web app: a React chat workspace and a Hono API, served by one Cloudflare Worker. It uses the shared agent from `packages/core` (through `@mofu/core/web`, which contains no Node.js-only code).

## Run it locally

```sh
cp apps/web/.dev.vars.example apps/web/.dev.vars   # then fill in the values
pnpm dev:web                                       # http://localhost:5173
```

`.dev.vars` needs:

| Name                   | What it is                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`   | The owner's key that pays for the free tier                                                       |
| `TURNSTILE_SECRET_KEY` | `1x0000000000000000000000000000000AA` locally (Cloudflare's always-passes test secret)            |
| `SESSION_SECRET`       | 32+ random characters, e.g. `node -e "console.log(crypto.randomBytes(32).toString('base64url'))"` |

Values in `.dev.vars` override the `vars` in `wrangler.jsonc`, so you can add `FREE_DAILY_LIMIT=2` there to test the limit. Local Durable Object state (the per-IP counters) lives in `.wrangler/state`; delete that folder to reset it.

Local development needs no Cloudflare login. After changing `wrangler.jsonc`, run `npx wrangler types` to refresh `worker-configuration.d.ts`.

## How it's put together

```
src/worker/   Hono API (/api/*), session cookies, Turnstile, per-IP limiter
src/client/   React app: chat, settings (own key, model, theme), memory
src/shared/   Types and limits shared by both
```

| Route                 | Purpose                                                                         |
| --------------------- | ------------------------------------------------------------------------------- |
| `GET /api/config`     | Public settings: Turnstile site key, default model, free limit                  |
| `GET /api/usage`      | Free messages left today for this IP (doesn't use one up)                       |
| `POST /api/session`   | Verifies a Turnstile token and sets a signed, HttpOnly session cookie (2 hours) |
| `POST /api/key/check` | Checks a user's own OpenRouter key against OpenRouter's free key-info endpoint  |
| `POST /api/chat`      | Streams the agent's reply (AI SDK UI message stream)                            |

## Dev Tools: explain a public GitHub repository

In Dev Tools mode the user pastes a GitHub URL. The **browser** (not the Worker) reads it:

- 2 GitHub API calls: repository info and the recursive file tree. GitHub allows 60 anonymous API calls per hour per IP, so each user spends their own allowance; the UI shows the reset time when it runs out.
- Manifests, the README and up to 4 entry-point excerpts come from `raw.githubusercontent.com`, which doesn't count against that limit (12 files at most).
- `buildRepoOverview` from `@mofu/core/web` turns that into a compact overview (capped at 15,000 characters), sent with each message as `context`. The Worker accepts at most 16,000 characters and wraps it in `<repository_overview>` tags, telling the model it's data, not instructions, so a README can't steer the agent.

It's read-only: no editing, cloning or pull requests on the web. For those, the model points people to `npx mofu task`.

## Dev Tools: dependency scan

The "Scan dependencies" tab takes uploaded manifests or a public GitHub URL (manifests fetched in the browser as above). The scan itself, `scanDependencies` from `@mofu/core/web`, also runs **in the browser**: OSV, deps.dev and GitHub all allow cross-origin requests, and a Worker on the free plan may make only 50 outbound requests per invocation, which a real project's vulnerability lookups can exceed. So the Worker never sees the files and spends nothing on the scan.

The results table is rendered from the deterministic report. "Get upgrade plan" sends a compact version of it (findings and totals only) as `context` of kind `dep-scan`; the Worker wraps it in `<dependency_scan>` tags with the same review instructions the CLI uses. The UI flags any vulnerability ID or version in the model's answer that isn't in the scan. "Export Markdown" downloads the table plus the latest plan.

## Free tier protection

- **Turnstile** before the first message; the session cookie is required for chat and key checks.
- **10 messages per IP per UTC day** (`FREE_DAILY_LIMIT`). Counted in a Durable Object, one per IP. A Durable Object handles one request at a time, so bursts can't slip past the limit (KV is eventually consistent, and the Workers rate-limit binding only supports minute-scale windows). Each counter deletes itself an hour after the daily reset.
- **Kill switch:** set `FREE_TIER_ENABLED` to `"false"` to stop all free-tier spending instantly. Bring-your-own-key keeps working.
- **Caps, all enforced in the Worker:** 200 KB request body, 40 messages / 60,000 characters of history (oldest trimmed first), 50 memory items, 6 agent steps, 2,000 output tokens per step, 90-second timeout.
- **Bring your own key:** a key in the `X-OpenRouter-Key` header skips the daily limit and may choose the model (`X-Mofu-Model`). The key is kept only in the user's browser and is never logged or stored by the Worker.

## Security notes

- The web tool set has no file or command tools; nothing on the server runs model- or user-written code.
- Request bodies and keys are never logged. The error handler logs only the error type.
- Non-GET requests from other origins are rejected. Session cookies are `HttpOnly`, `Secure`, `SameSite=Strict`, scoped to `/api`.
- Memory lives in the user's localStorage and is sent with each message; the server never stores it.

## Tests

`pnpm test` from the repository root runs the Worker tests (`test/`) with a mocked model: sessions, the daily limit, the kill switch, BYOK, request caps, origin checks and the web tool set.
