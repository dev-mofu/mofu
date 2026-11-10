# mofu

An AI agent in your terminal that does real work on your files: it reads, searches and edits code, runs commands, and looks things up. It always asks before it changes a file or runs a command.

Mofu uses [OpenRouter](https://openrouter.ai), so you can pick almost any model. You bring your own API key.

## Requirements

- Node.js 22 or newer
- An OpenRouter API key: <https://openrouter.ai/keys>

## Set up your key

Either save it once:

```sh
mofu auth
```

or set it for the current shell (this takes priority over the saved key):

```sh
# macOS / Linux
export OPENROUTER_API_KEY=sk-or-...

# Windows PowerShell
$env:OPENROUTER_API_KEY = "sk-or-..."
```

`mofu auth` stores the key in `~/.mofu/config.json`. On macOS and Linux the file is readable only by you (mode 600). On Windows it lives in your user profile folder, which other standard users can't read.

## Use it

```sh
mofu                                # interactive chat in the current folder
mofu "what does this repo do?"      # one question, then exit
mofu task "add a --verbose flag"    # a coding task, end to end (see RepoPilot below)
mofu explain                        # explain the repository you're in
mofu tests src/utils.ts             # write and run unit tests for a file or folder
mofu -m qwen/qwen3.7-flash          # pick a model for this run
```

In chat:

| Command       | What it does                              |
| ------------- | ----------------------------------------- |
| `/help`       | List commands                             |
| `/model [id]` | Show or switch the model for this session |
| `/clear`      | Start a fresh conversation                |
| `/memory`     | Show what Mofu remembers about you        |
| `/forget`     | Clear that memory                         |
| `/exit`       | Quit                                      |

Ctrl+C stops a reply that's running. At the prompt, it quits.

## What Mofu can do

| Tool                                                   | Needs your approval |
| ------------------------------------------------------ | ------------------- |
| List, read and search files                            | No                  |
| Create, overwrite or edit files (you see a diff first) | Yes                 |
| Run a command (PowerShell on Windows, `sh` elsewhere)  | Yes                 |
| Look up Wikipedia summaries and dictionary definitions | No                  |
| Remember a fact you ask it to (`~/.mofu/memory.md`)    | Yes                 |
| Map the repository (languages, tests, entry points…)   | No                  |
| Show git status and diffs                              | No                  |
| Create a `mofu/...` branch, run tests, commit          | Yes                 |
| Push and open a GitHub pull request (needs `gh`)       | Yes                 |

File and command tools only work inside the folder you started Mofu in. Paths that escape it (`..`, absolute paths elsewhere, symlinks pointing outside) are refused.

## RepoPilot: coding tasks in a git repository

`mofu task "<instruction>"` works through a task the way a careful colleague would:

1. Maps the repository and reads only the files it needs.
2. Shows a short plan and **waits for you** to accept or change it.
3. Creates a branch named `mofu/<task>` (if you have uncommitted changes, it asks before stashing them).
4. Makes the edits and adds or updates unit tests.
5. Runs the tests; if they fail it tries to fix them, at most three times, then stops and explains.
6. Commits only the files it changed.
7. Asks whether you want a pull request, and opens one with the GitHub CLI only if you say yes.

Safety rules, enforced in code rather than just asked of the model:

- Never commits on your default branch (or `main`, `master`, `develop`, `trunk`).
- Never force-pushes, including through `run_command`.
- Every branch, commit, push and pull request needs your approval in that step.
- Git runs with argument lists, never through a shell, so file names and messages can't inject commands.

Pull requests need the [GitHub CLI](https://cli.github.com) installed and logged in (`gh auth login`).

## DependencyGuard: dependency security

```sh
mofu deps          # scan, show a table, then a prioritized upgrade plan (one model call)
mofu deps --json   # the raw scan report as JSON; no API key or model needed
mofu deps --fix    # choose upgrades, apply them on a branch, run tests, commit
```

Mofu reads `package.json` + `package-lock.json` (lockfile v2/v3) and `requirements*.txt` / `pyproject.toml` (`[project].dependencies`) in the current folder, then:

- checks every installed package, transitive ones included, against [OSV](https://osv.dev) in one batch request;
- checks direct dependencies on [deps.dev](https://deps.dev) for the latest version, deprecation and the last release date (no release in 24 months is flagged as possibly unmaintained);
- computes, per package, the smallest version that fixes every known vulnerability, skipping releases that are themselves deprecated, and flags fixes that cross a major version.

All of that is plain code; the model only explains and prioritizes. Any vulnerability ID or version in its answer that isn't in the scan is flagged in yellow. Without a lockfile, versions are the lowest each range allows and are marked as guesses. Only package names and versions leave your machine.

## Choosing a model

The model comes from, in order: `--model`, the `MOFU_MODEL` environment variable, `"model"` in `~/.mofu/config.json`, then the default (`anthropic/claude-haiku-5.5`, chosen because it's cheap and reliable with tools). The model must support tool calling. Browse models and prices at <https://openrouter.ai/models>.

Each reply ends with a token count so you can keep an eye on cost.
