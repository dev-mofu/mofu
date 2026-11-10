# Mofu

Mofu is an AI agent that does real work on the files people give it. See [prompts/00-project-brief.md](prompts/00-project-brief.md) for the full product brief and [prompts/README.md](prompts/README.md) for the build phases.

**Status:** phase 1 (core agent + CLI) is done. The web app comes in phase 2.

## Repository layout

```
packages/core   Agent loop, OpenRouter model provider, system prompt, tools, memory
apps/cli        The `mofu` command-line app (see apps/cli/README.md)
apps/web        Placeholder for phase 2
mascot/         Approved mascot concept (sprite data reused by the web app)
prompts/        Build prompts, one per phase
```

## Development

Requires Node.js 22+ and pnpm.

```sh
pnpm install
pnpm mofu            # run the CLI from source
pnpm mofu --help
pnpm test            # unit tests (no network, no model calls)
pnpm typecheck
pnpm lint
pnpm build           # compile packages/core and apps/cli to dist/
```

Set `OPENROUTER_API_KEY` (or run `pnpm mofu auth`) before chatting. Copy `.env.example` for the list of variables.

### Live smoke test

One real, billed model call with the default cheap model:

```powershell
$env:MOFU_LIVE_TEST = "1"; pnpm test
```

### Adding a tool

1. Create `packages/core/src/tools/<name>.ts` with `defineTool({ name, description, inputSchema, kind, surfaces, execute })`. Write and exec tools also need `describeApproval`, which builds what the user sees before approving.
2. Add it to `ALL_TOOLS` in `packages/core/src/tools/all.ts`.
3. Add tests under `packages/core/test/` with mocked network calls.

Tools return small results: `capResult` truncates anything over 25,000 characters, and the model is told when output was cut.
