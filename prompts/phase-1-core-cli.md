# Phase 1 — Core agent and CLI foundation

Read `prompts/00-project-brief.md` first.

## Goal

Set up the monorepo and build a working `mofu` CLI. It should chat with a model through OpenRouter and act as a general coding assistant in the current directory: read, search and edit files, and run commands, always with the user's approval. Everything later phases build on comes from this phase, so the core has to be clean.

## Scope

### 1. Monorepo

- pnpm workspaces with `packages/core`, `apps/cli` and an empty placeholder for `apps/web` (built in phase 2).
- Shared TypeScript config (strict), ESLint, Prettier and Vitest.
- Root scripts: `build`, `lint`, `test`, `typecheck`, plus `mofu` to run the CLI from source.

### 2. `packages/core`

**Model provider**
- OpenRouter via the AI SDK provider.
- Takes the API key and model ID as parameters, so it holds no global state.
- Model ID comes from config: CLI flag, then `MOFU_MODEL`, then the config file, then a default.

**Agent runner**
- A function that takes a model, a system prompt, a tool set, the message history and limits.
- Streams text and tool-call events to the caller through callbacks or an async iterator, so the CLI and the web can render them differently.
- Limits: maximum steps per turn, maximum output tokens. Both have sane defaults.
- Returns token usage per turn.

**Tool registry**
- Implements the tool contract from the brief (`name`, `description`, schema, `execute`, `surfaces`, `kind`).
- Can return the tools for a given surface.
- Has an approval hook: before any `write` or `exec` tool runs, the runner calls an `approve(request)` function supplied by the surface. A refusal is returned to the model as a normal tool result ("The user declined"), not as a crash.

**System prompt**
- In English.
- Explains what Mofu is, how it uses tools, that it must not invent facts deterministic tools are responsible for, that results should be concise, and that file changes need approval.
- Kept in its own file so later phases can add mode-specific sections.

**Errors**
- Clear messages for: missing or invalid key (401), out of credits (402), rate limited (429), model doesn't support tools, and network failure.
- Never print the API key.

**Memory**
- A small interface (`load`, `append`, `clear`) with a file implementation for the CLI.
- Loaded memory is added to the system prompt.
- A `save_memory` tool lets the model store a short fact when the user asks it to remember something.

### 3. Coding tools (CLI surface)

All tools are rooted at the working directory. Resolve real paths and reject anything that escapes the root, including `..`, absolute paths and symlinks pointing outside. Truncate large outputs and say so in the result.

| Tool | Kind | Notes |
|---|---|---|
| `list_files` | read | Glob pattern support; respects `.gitignore`; skips `node_modules`, `.git` and build output |
| `read_file` | read | Line ranges; refuses binary files; size cap |
| `search_files` | read | Regex search across files with path filter; returns file:line matches; capped |
| `write_file` | write | Creates or overwrites; approval shows the full content for new files and a diff for overwrites |
| `edit_file` | write | Exact string replacement; fails if the old string is missing or not unique; approval shows a diff |
| `run_command` | exec | Runs in the working directory with a timeout; uses PowerShell or cmd on Windows and `sh` elsewhere; approval shows the exact command; returns exit code, stdout and stderr (truncated) |

### 4. First utility tools (both surfaces)

Implement two keyless utilities to prove the pattern that later phases follow:

- `wikipedia_summary`: page summary via the Wikimedia REST API, returning title, extract and URL (for attribution).
- `define_word`: Free Dictionary API, returning definitions, part of speech, phonetic and examples.

Both validate responses with zod, handle "not found" cleanly and have a request timeout.

### 5. `apps/cli`

- `mofu` starts an interactive chat. `mofu "question"` runs a single turn and exits.
- Slash commands: `/help`, `/model <id>`, `/clear`, `/memory` (show), `/forget` (clear memory), `/exit`.
- `mofu auth` saves the key to `~/.mofu/config.json` with user-only permissions where the OS supports it (explain the Windows behavior in the README).
- Streams the model's text as it arrives. Shows each tool call as one short line (for example `read_file src/index.ts`).
- Approval prompt for write/exec tools: show the diff or command, then ask `Apply? (y/n)`.
- Shows token usage after each turn in a dim line.
- Works with `npx`/`pnpm` from source; set up the `bin` entry for later publishing (do not publish).

## Out of scope

The web app, Data Analyst, Study Buddy, DependencyGuard, APIForge, git/PR workflows (phase 3), the landing page, deployment and publishing.

## Cost discipline

- Use a cheap model with reliable tool calling for all manual testing. If you aren't sure which OpenRouter model fits, list two or three candidates with their prices and ask the owner.
- Keep the whole phase under about 30 live model calls.
- Unit tests must not call the model or any external API.

## Verification

1. `pnpm build`, `pnpm lint`, `pnpm typecheck` and `pnpm test` all pass.
2. Unit tests cover:
   - path sandboxing (including `..`, absolute paths and a symlink escape)
   - `edit_file` success, missing string and non-unique string
   - the approval hook (approved, declined)
   - tool registry filtering by surface
   - output truncation
   - both utility tools against mocked responses, including not-found
3. A gated smoke test (`MOFU_LIVE_TEST=1`) runs one short real turn.
4. On Windows, manually in a scratch directory:
   - ask Mofu to read a file
   - ask it to edit a file, decline, then approve
   - ask it to run a command
   - ask for a Wikipedia summary and a definition
   - ask it to remember something, restart and check it remembers

## Report

Follow "How to work on a phase" in the brief. Also include the default model you chose and its price, and a short transcript of the manual Windows run.
