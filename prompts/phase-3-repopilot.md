# Phase 3 — RepoPilot

Read `prompts/00-project-brief.md` first. Phases 1 and 2 must be complete.

## Goal

Turn the CLI coding assistant into RepoPilot: an agent that understands a repository and completes a task end to end on a separate branch. It plans, edits, writes tests, runs them, commits and opens a pull request, with the user approving each step that changes something.

Add a light, read-only version to the web: explain a public GitHub repository.

## Scope

### 1. Repository understanding (core, both surfaces)

A deterministic `repo_overview` step that the agent can call. It produces a compact map:
- languages and their share
- package manager(s)
- frameworks detected from manifests
- entry points
- test framework and test command
- folder tree (depth-limited, ignoring build output)
- README excerpt
- notable config files

The model gets this map, not the whole repo. Cap the size.

### 2. Git workflow tools (CLI only)

Each tool shells out to the user's own `git` and `gh`. Never store credentials.

| Tool | Kind | Behavior |
|---|---|---|
| `git_status` | read | Branch, staged/unstaged changes, ahead/behind |
| `git_diff` | read | Diff of working tree or between refs, truncated |
| `git_create_branch` | exec | Creates and switches to `mofu/<short-task-slug>`; refuses if the working tree is dirty unless the user approves stashing |
| `git_commit` | exec | Stages listed files and commits with a message the model writes; approval shows files and message |
| `detect_test_command` | read | Deterministic: finds the right test command from manifests (`package.json` scripts, `pytest`, `go test`, …) |
| `run_tests` | exec | Runs the detected or given test command; returns pass/fail counts and the first failures, truncated |
| `create_pull_request` | exec | Only if `gh` is installed and authenticated; pushes the branch and opens a PR with a title and body the model writes; approval shows remote, branch, title and body |

Rules:
- Never commit to the default branch.
- Never force-push.
- Never push or open a PR without explicit approval in that same step.

### 3. Task flow (CLI)

`mofu task "<instruction>"`, and also triggered naturally in chat when the user asks for a code change in a git repo. The agent:

1. Builds the repo overview.
2. Proposes a short plan.
3. Waits for the user to accept or adjust the plan.
4. Creates the branch.
5. Makes the edits (each one approved).
6. Adds or updates unit tests for the change.
7. Runs the tests. If they fail, attempts fixes, at most 3 times, then stops and reports.
8. Commits.
9. Offers to open a PR.

It ends with a summary: files changed, tests run and their result, commit hash, PR link if any.

Also add `mofu explain` (explains the repository from the overview, reading a few key files) and `mofu tests <path>` (generates unit tests for a file and runs them).

### 4. Web: public repo explainer

- The Dev Tools mode accepts a public GitHub URL.
- The browser (not the Worker) calls the GitHub REST API unauthenticated, so the 60 requests/hour limit applies to each user's own IP. It fetches the tree, the README, manifests and up to a small capped number of key files.
- The client builds the overview and sends it to the agent, which explains architecture, entry points, how to run it and where to start contributing.
- Show a clear message when GitHub's rate limit is reached.
- Read-only. No editing, no PRs on the web.

## Out of scope

DependencyGuard (phase 4), private repositories on the web, GitHub OAuth, server-side cloning.

## Cost discipline

- The repo overview exists to save tokens. Measure overview size on a medium repository and report it.
- Live-test the full task flow at most twice, on a tiny throwaway repository you create locally.
- No more than about 30 live calls total.

## Verification

1. Build, lint, typecheck and tests pass.
2. Unit tests cover:
   - test-command detection for npm, pnpm, yarn and pytest projects (fixtures)
   - branch naming
   - refusal to commit on the default branch
   - refusal to push without approval
   - overview size caps
3. Manual CLI run on a local throwaway repo: a full task from plan to commit, including one deliberate test failure that the agent fixes. Stop before pushing unless the owner provides a disposable remote.
4. Manual web run: explain one small public repository.

## Report

Follow "How to work on a phase" in the brief, plus the overview size measurement and the CLI transcript.
