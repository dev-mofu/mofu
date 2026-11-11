# Mofu

**The AI agent that does the work.** Drop a spreadsheet, a PDF, a project or an API spec, and Mofu works on it with real tools: Python for the numbers, page-cited study notes and quizzes, vulnerability databases for your dependencies, and your own tests for code changes.

Use it free in your browser (no account), or in your terminal with `npx mofu-cli`.

![Mofu landing page](assets/screenshots/landing.png)

| Study Buddy                                            | Dependency scan                                            | API test cases                                 |
| ------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------- |
| ![Flashcards](assets/screenshots/study-flashcards.png) | ![Dependency scan](assets/screenshots/dependency-scan.png) | ![API tests](assets/screenshots/api-tests.png) |

## What it does

- **Data Analyst:** CSV, Excel and JSON files analyzed with Python (pandas) in a sandbox, with charts and reports, plus exchange rates, holidays, weather and World Bank data.
- **Study Buddy:** summaries at three levels, flashcards with spaced repetition and Anki export, and quizzes, all citing the page.
- **Dev Tools:** explain a GitHub repository, find vulnerable or deprecated dependencies, generate tests, docs and breaking-change reports from an OpenAPI spec.
- **In the terminal:** coding tasks on a branch with your tests, dependency upgrades, API test runs. It asks before every change.

## Quick start

**Web:** open the app, pick a mode, drop a file. 10 free messages a day, or add your own [OpenRouter](https://openrouter.ai) key in Settings.

**CLI** (Node.js 22.13+ and an OpenRouter key):

```sh
npx mofu-cli auth                 # save your key once
npx mofu-cli                      # chat in the current folder
npx mofu-cli task "add a --verbose flag"
npx mofu-cli study notes.pdf
npx mofu-cli deps
```

Full documentation: the `/docs/` page of the web app ([source](apps/web/docs/index.html)) and the [CLI README](apps/cli/README.md).

## Repository layout

```
packages/core   Agent loop, tools, prompts, and the data, study, dependency and API modules
apps/cli        The `mofu` command (published to npm, bundled with esbuild)
apps/web        Cloudflare Worker (Hono API) + landing page, docs and React app
assets/         Screenshots
legal/          Draft privacy policy and terms (not legal advice; see AUDIT.md)
mascot/         The approved mascot concept
prompts/        The build brief and per-phase prompts
```

## Development

Requires Node.js 22.13+ and pnpm.

```sh
pnpm install
pnpm mofu            # run the CLI from source
pnpm dev:web         # web app at http://localhost:5173 (copy apps/web/.dev.vars.example to .dev.vars first)
pnpm test            # unit tests (no network, no model calls)
pnpm typecheck
pnpm lint
pnpm build
```

Set `OPENROUTER_API_KEY` (or run `pnpm mofu auth`) before chatting.

**Live smoke test** (one real, billed model call with the cheap default model):

```powershell
$env:MOFU_LIVE_TEST = "1"; pnpm test
```

**Adding a tool**

1. Create `packages/core/src/tools/<name>.ts` with `defineTool({ name, description, inputSchema, kind, surfaces, execute })`. Write and exec tools also need `describeApproval`, which builds what the user sees before approving.
2. Add it to `ALL_TOOLS` in `packages/core/src/tools/all.ts`.
3. Add tests under `packages/core/test/` with mocked network calls.

## Self-hosting

The web app is one Cloudflare Worker with a Durable Object (free plan works). You need an OpenRouter key and a Turnstile widget. [LAUNCH.md](LAUNCH.md) walks through the setup, secrets, deploy, custom domain and the recovery playbook; [AUDIT.md](AUDIT.md) has the security, cost and licensing review.

## Data sources

Wikipedia (CC BY-SA 4.0), Free Dictionary API, Datamuse, arXiv, Crossref, Open Library, Frankfurter (ECB rates), Nager.Date, Open-Meteo (CC BY 4.0, non-commercial), World Bank, OSV, deps.dev and GitHub. Models via OpenRouter. Thank you to arXiv for use of its open access interoperability. Mofu isn't affiliated with any of them.

## License

[MIT](LICENSE)
