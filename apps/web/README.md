# @mofu/web

The Mofu web app: a React chat workspace and a Hono API, served by one Cloudflare Worker. It uses the shared agent from `packages/core` (through `@mofu/core/web`, which contains no Node.js-only code).

## Run it locally

```sh
cp apps/web/.dev.vars.example apps/web/.dev.vars   # then fill in the values
pnpm dev:web                                       # landing: http://localhost:5173/  app: /app/
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
index.html     Landing page (/), plain TypeScript, no React
app/index.html The app (/app/)
docs/index.html Docs (/docs/): web app, CLI, keys, limits, privacy
src/landing/  Landing and docs pages: pixel scenes, starfield, hero demo, timeline
src/worker/   Hono API (/api/*), session cookies, Turnstile, per-IP limiter
src/client/   React app: chat, settings (own key, model, theme), memory
src/shared/   Types and limits shared by both, and the mascot sprite
```

## Landing page

`/` is a separate, lightweight page (about 6 KB of JS and 4 KB of CSS, gzipped) so it loads fast on phones. All pixel art (night sky, moon, mountains, skyline, feature illustrations, the mascot) is drawn on canvas from data in `src/landing/art.ts` and `src/shared/sprite.ts`, so it's crisp at any size and follows the light/dark theme. A page-wide starfield (twinkling stars, shooting stars, pink motes; 30 fps) sits behind every section, illustrations draw themselves dot by dot, sections fade in as you scroll and the terminal types itself out. Animations use one `requestAnimationFrame` loop, stop while off screen or in a background tab, and under `prefers-reduced-motion` the page is static (the demo shows a finished result, and its Data/Dev/Study buttons still work). `public/og.png` was rendered from the same sprite.

Body fonts use `display=optional` so a late font never shifts the layout (the pixel font swaps; it only appears in fixed-size badges). The docs page shares the same styles and scripts (`src/landing/common.ts`).

Every privacy, FAQ and docs claim matches the code in this repository; update the page when limits or data handling change.

| Route                  | Purpose                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET /api/config`      | Public settings: Turnstile site key, default model, free limit                                                 |
| `GET /api/usage`       | Free messages left today for this IP (doesn't use one up)                                                      |
| `POST /api/session`    | Verifies a Turnstile token and sets a signed, HttpOnly session cookie (2 hours)                                |
| `POST /api/key/check`  | Checks a user's own OpenRouter key against OpenRouter's free key-info endpoint                                 |
| `POST /api/chat`       | Streams the agent's reply (AI SDK UI message stream)                                                           |
| `POST /api/fetch-page` | Fetches a public web page for Study Buddy (readable text), or with `kind: "document"` a raw JSON/YAML API spec |

## Data Analyst

The file never leaves the browser. Pyodide (pinned to 314.0.7, loaded from jsDelivr the first time the mode is used) runs pandas and matplotlib in a Web Worker:

1. The worker loads the file and builds a profile (columns, types, missing values, problems). The profile, capped at 12,000 characters, is sent as `context` of kind `dataset`; the Worker wraps it in `<dataset_profile>` tags.
2. The model calls `run_python`, the enrichment tools (`fx_rates`, `public_holidays`, `historical_weather`, `country_info`, `economic_indicator`) and `export_csv`. The Worker declares them **without** `execute`, so the AI SDK sends the call to the browser; `onToolCall` runs it (Python in the worker, public APIs via `fetch`, which all allow CORS) and `addToolOutput` returns the result. `sendAutomaticallyWhen` continues the turn.
3. Charts and CSV exports stay in the page. The model only gets text: printed output, the truncated value of the last line, errors and a chart count.

Safety: after packages load, the worker deletes `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts` and `WebTransport`, so model-written Python can't send data anywhere. A run longer than 30 seconds terminates the worker; the next call starts a fresh one and reloads the file. Files are limited to 20 MB.

Cost: tool results come back as follow-up requests. They don't use a free message, but they're capped at 10 per free message per IP per day (a separate `followups` counter in the same Durable Object).

## Study Buddy

Documents are read **in the browser**. PDFs use pdf.js (6.5.438, loaded only when a PDF is opened); `.txt` and `.md` are split into sections of about 3,000 characters.

- **Limits:** 30 pages / 60,000 characters on the free tier, 300 pages / 400,000 characters with your own key. Longer PDFs aren't cut silently: the user picks a page range, and the card says when only part is loaded.
- **Only what's needed goes to the model.** Each message carries an outline (title, page numbers, the start of each page; at most 6,000 characters) as `context` of kind `document`, wrapped in `<document_outline>` tags. The model calls `read_document` for the pages it needs (at most about 14,000 characters per call), which the browser answers from the loaded text.
- **Flashcards and quizzes** are tool calls (`create_flashcards`, `create_quiz`) validated with zod in the browser; invalid ones go back to the model as errors to fix. The deck flips, tracks "knew it / didn't" on a Leitner schedule in `localStorage`, and exports a TSV for Anki. Multiple choice is graded in code with the choices shuffled per quiz; short answers are sent to the model with the model answer and page.
- **Links:** `POST /api/fetch-page` (session required; each fetch counts as a follow-up) fetches the page from the Worker. Before every request and every redirect hop it resolves the host over DNS-over-HTTPS and refuses localhost, private, link-local, CGNAT, multicast and metadata addresses, non-http(s) URLs and URLs with credentials. Only HTML or plain text up to 2 MB is accepted; scripts, navigation and footers are stripped.
- **Reference tools** (`wikipedia_summary`, `define_word`, `related_words`, `search_papers`, `find_books`, `cite_doi`) run in the Worker, because arXiv doesn't allow cross-origin requests. Citations are formatted by code from Crossref data.

## Dev Tools: APIForge (OpenAPI specs)

The "API spec" tab takes an uploaded, pasted or linked OpenAPI 3.x / Swagger 2.0 spec. Parsing, validation (`@scalar/openapi-parser`), `$ref` resolution, the endpoint index, request-body checks (`@cfworker/json-schema`, no `eval`) and the breaking-change diff all run **in the browser** from `@mofu/core/apiforge`, a separate chunk (about 110 KB gzipped) loaded only when the tab is used. The Worker bundle doesn't include it.

- Each message sends the endpoint list (and the diff, when there is one) as `context` of kind `api-spec`, wrapped in `<api_spec>` tags, at most 16,000 characters.
- The model calls `get_endpoint_group`, `create_test_cases` and `write_endpoint_docs`. The Worker declares them without `execute`; the browser runs them against the loaded spec, rejecting invalid cases with reasons so only those are regenerated.
- Results are tables with downloads: the suite as JSON, a Vitest file and an `.http` file; Markdown docs; the diff as Markdown. Tables, examples and breaking/non-breaking classification come from code.
- The web app never sends requests to the user's API. It shows the `npx mofu api test` command instead.
- Spec links are fetched by `/api/fetch-page` with `kind: "document"`, behind the same public-address checks as Study Buddy links (up to 2 MB).

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
