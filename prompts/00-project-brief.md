# Mofu — Project Brief

Read this file in full before starting any phase. Every phase prompt assumes you know what is here. If a phase prompt and this brief disagree, the phase prompt wins for that phase; flag the conflict in your report.

## What Mofu is

Mofu is an AI agent that does real work on the files people give it. A user drops in a file (a dataset, a PDF, a lockfile, an API spec, a code repository) and Mofu analyzes it, explains it and produces something usable: a chart, a report, flashcards, a list of vulnerable packages, a test suite or a pull request.

It is not a general chatbot. Every feature must end in a concrete output the user can use.

Mofu has three modes:

1. **Data Analyst**: CSV, Excel and JSON in. Analysis, charts, cleaned data and a written report out.
2. **Study Buddy**: PDFs, notes and articles in. Summaries, interactive flashcards and graded quizzes out.
3. **Dev Tools**:
   - **RepoPilot**: understands a repository and completes coding tasks on a separate git branch, runs the tests and opens a pull request (full version in the CLI only).
   - **DependencyGuard**: scans dependencies for known vulnerabilities, outdated and unmaintained packages, and recommends a safe upgrade order.
   - **APIForge**: reads OpenAPI/Swagger specs, generates test cases and documentation, detects breaking changes between versions, and runs the tests (live runs in the CLI only).

Mofu ships in two forms:

- **Web app**: free, no login, global audience. Hosted on Cloudflare.
- **CLI**: `npx mofu`, published on npm. Runs on the user's own machine with the user's own OpenRouter API key.

All user-facing text (UI copy, CLI output, system prompts, default model responses) is in **English**.

## Hard constraints

These come from the owner and are not up for redesign. If one blocks you, stop and report instead of working around it.

- **Budget.** The owner has about $6 of OpenRouter credit. The web app's free tier is paid from that. Every design decision must keep token usage low, and development and testing must use a cheap model with as few live calls as possible.
- **No login, no accounts, no database of user data.** Per-user state lives in the user's browser (web) or in `~/.mofu/` (CLI).
- **No server-side execution of user code.** The web backend never runs code that the model or the user wrote. Code runs in the user's browser (Pyodide) or, in the CLI, on the user's machine after explicit approval.
- **No Docker, no VPS.** The web app runs entirely on Cloudflare Workers.
- **Free, keyless external APIs only** (list below). Do not add a service that needs signup or an API key without asking the owner.
- **Ask before anything outward-facing**: deploying, publishing to npm, creating repos, pushing, opening pull requests on real repositories, buying domains. Prepare the command and wait for the owner.

## Architecture

TypeScript monorepo using pnpm workspaces.

```
mofu/
├── packages/
│   └── core/            # agent loop, model provider, prompts, tools, shared types
├── apps/
│   ├── web/             # React (Vite) frontend + Hono API on Cloudflare Workers
│   └── cli/             # Node CLI, published to npm as `mofu`
├── mascot/              # existing mascot concept (sprite data to reuse)
└── prompts/             # these build prompts
```

- **Model access**: OpenRouter, through the Vercel AI SDK (`ai`) with the OpenRouter provider (`@openrouter/ai-sdk-provider`). The model ID is configuration, never hardcoded in logic. The AI SDK's tool and multi-step APIs have changed between major versions (field names for tool input schemas, how the step loop is limited, how client-side tools return results). Check the documentation for the version you install instead of relying on memory.
- **Web frontend**: React + Vite, served as static assets by the same Worker.
- **Web API**: Hono on Cloudflare Workers, configured with Wrangler.
- **CLI**: Node 20+, works on Windows, macOS and Linux. The owner develops on **Windows**, so shell commands, paths and file permissions must work there.
- **Python for data work**: Pyodide. In the web app it runs in a Web Worker in the user's browser; in the CLI it runs in Node.
- **Validation**: zod for every tool input and every external API response that the code relies on.
- **Tests**: Vitest. Mock all external HTTP in unit tests. Live model calls only in explicitly gated smoke tests.

### Tool design

Each tool lives in its own file under `packages/core/src/tools/` and exports:

- `name`, `description` (written for the model: what it does, when to use it, what it returns)
- an input schema (zod)
- `execute`
- `surfaces`: which of `web` and `cli` may use it
- `kind`: `read` (no side effects), `write` (changes files) or `exec` (runs commands or code)

The web surface must never register a `write` or `exec` tool that runs on the server. The CLI must ask the user for approval before every `write` and `exec` call, showing exactly what will change or run.

Tool results returned to the model must be short: truncate long outputs, summarize large structures, and never send a full dataset or full document when a profile, excerpt or computed result will do.

### Deterministic code vs. AI

- **Deterministic code** does parsing, scanning, validation, diffing, version comparison, vulnerability lookup, statistics and test execution. These results must be exact and reproducible.
- **The model** does planning, analysis, prioritization, explanation and writing.
- The model must never invent facts that deterministic code is responsible for: CVE IDs, version numbers, row counts, test results, citations. The UI renders those from the deterministic data, and the model's prose may only reference them.

## Free external APIs

All are free and need no key. Respect each one's rate limits and terms, send a descriptive `User-Agent` where the API asks for one (use a generic project contact, never a personal email), and cache responses where sensible.

| Purpose | API | Used by |
|---|---|---|
| Vulnerabilities | OSV (`api.osv.dev`) | DependencyGuard |
| npm package metadata | npm registry | DependencyGuard, RepoPilot |
| Python package metadata | PyPI JSON API | DependencyGuard, RepoPilot |
| Public repositories | GitHub REST API, unauthenticated (about 60 requests/hour per IP) | RepoPilot, DependencyGuard |
| Exchange rates (historical) | Frankfurter | Data Analyst |
| Public holidays | Nager.Date | Data Analyst |
| Historical weather | Open-Meteo Historical (free tier is non-commercial only) | Data Analyst |
| Country data | REST Countries | Data Analyst |
| Economic indicators | World Bank API | Data Analyst |
| Encyclopedia | Wikipedia / Wikimedia REST (attribution required) | Study Buddy |
| Dictionary | Free Dictionary API | Study Buddy |
| Papers | arXiv API | Study Buddy |
| Citations | Crossref REST API | Study Buddy |
| Books | Open Library | Study Buddy |
| Words and synonyms | Datamuse | Study Buddy |

Web search is not part of Mofu (it costs money per query on OpenRouter). Fetching a URL that the user provides is allowed, with SSRF protection.

## Web app rules

- **Free tier**: the owner's OpenRouter key (a Worker secret) and a default cheap model with reliable tool calling.
  - Limit: 10 messages per IP per day (configurable).
  - Cloudflare Turnstile to block bots.
  - Caps on upload size, PDF pages (30), agent steps per request and output tokens.
- **Bring your own key (BYOK)**: the user can paste their own OpenRouter key in settings. It is stored only in their browser's localStorage, sent with each request, and never logged or stored on the server. BYOK users skip the free-tier limits and can choose any model.
- **Memory**: per-user memory lives in localStorage. Users can view and delete it.
- **Privacy**: raw datasets and documents stay in the browser wherever possible. Only profiles, excerpts and computed results go to the model. Do not log request contents on the server.

## CLI rules

- Command: `mofu`. API key from `OPENROUTER_API_KEY`, or saved with `mofu auth` to `~/.mofu/config.json`.
- Works inside the current directory. Refuses to read or write outside it unless the user passes a path explicitly.
- Asks for approval (y/n) before every write and every command, showing a diff or the exact command.
- Memory in `~/.mofu/memory.md`.

## Brand and design

- **Name**: Mofu (from Japanese "mofumofu", fluffy). Lowercase `mofu` for the command and package.
- **Look**: dark, warm near-black background with a subtle dot grid. White text. Pink accent (`#ff4f9a`). White pill-shaped primary buttons. Monochrome pixel-art and dot-matrix illustrations (night sky, stars, moon, mountains, skyline). LED dot-matrix status badges. Thin geometric sans-serif headings (Raleway style), rounded readable body text (Lato style), pixel font for badges (Silkscreen style). Light mode supported.
- **Mascot**: Mofu is a round, fluffy white creature with pointed pink-lined ears, a small hair tuft, big glossy eyes, pink blush and faint pink spots. The approved pixel sprite and its three expressions are in `mascot/mofu-mascot.html`. Reuse that sprite data, don't redraw it.
  - **READY**: idle
  - **SCANNING / ANALYZING / STUDYING**: pink glasses, focused
  - **FOUND**: happy ^ ^ eyes, sparkles
- **Style reference**: `referensi tampilan web nya.mp4` in the project root shows the landing page style the owner likes. It belongs to an unrelated travel product. Use it for style only. Never copy its name, mascot, illustrations, copy or exact layout.

## Engineering standards

- TypeScript `strict`. No `any` without a comment explaining why.
- Small modules, clear names, no dead code, no speculative abstractions.
- Every phase leaves the repository building, linting and passing tests.
- Secrets only in environment variables or Wrangler secrets. Never commit them. Provide `.env.example` / `.dev.vars.example`.
- Write a short README section for anything a user or the owner needs to run.

## How to work on a phase

1. Read this brief and the phase prompt.
2. Inspect the current repository state. Earlier phases may have changed things.
3. If something essential is ambiguous, ask the owner before building. For small decisions, pick the sensible default and note it in your report.
4. Build only what the phase asks for. Do not start the next phase.
5. Verify: build, lint, tests, and a manual run where the phase says so.
6. Report: what you built, how to run it, what you verified and how, what you skipped or could not verify, any decisions you made, and roughly how many live model calls you used.
