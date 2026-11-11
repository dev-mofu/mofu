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
mofu study notes.pdf                # summaries, flashcards and quizzes (see Study Buddy below)
mofu api tests openapi.yaml         # test cases from an API spec (see APIForge below)
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

## Data Analyst

```sh
mofu analyze sales.csv     # also .tsv, .json, .xlsx
```

Mofu loads the file into a Python sandbox ([Pyodide](https://pyodide.org): pandas, numpy, matplotlib) and prints a profile: columns and types, missing values, duplicates, mixed types, outliers and mixed date formats. Then ask questions in plain English. It answers by running Python on the data; every number comes from that code. Charts are saved as `./mofu-output/figure-N.png`, and `export_csv` writes cleaned tables to `./mofu-output/` (asking first).

It can pull in public data to join with yours: daily exchange rates (Frankfurter/ECB), public holidays (Nager.Date), historical weather (Open-Meteo, non-commercial use), and country facts and indicators like GDP or inflation (World Bank).

The sandbox runs in a separate worker thread with an empty environment (no API keys) and no network access once its packages are loaded; it sees only your file and the data Mofu fetched for it. Runs are stopped after 30 seconds. When asked to approve analysis code you can answer `a` to approve all analysis code for the rest of the session. The first run downloads Pyodide's packages (about 30 MB) into `~/.mofu/pyodide-cache`.

## Study Buddy

```sh
mofu study notes.pdf                    # also .txt and .md
mofu study textbook.pdf --pages 40-90   # pick the pages to load (up to 300 at a time)
mofu study https://example.com/article  # a public web page
```

Mofu reads the document locally (PDFs with [pdf.js](https://mozilla.github.io/pdf.js/)), prints its title, page count and word count, and sends the model only an outline. The model reads the pages it needs with `read_document` and cites them, like "(page 4)". Scanned PDFs (images of pages) have no text and are refused with a clear message.

| Command              | What it does                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/summary [short     | detailed                                                                                                                                                                                                           | eli12]` | Summary at three levels, with page citations |
| `/flashcards`        | Makes a deck (every card cites its page)                                                                                                                                                                           |
| `/review`            | Reviews due cards in the terminal: Enter flips, `y`/`n` marks, `q` stops. A Leitner schedule (again in 1, 3, 7, 14 days) is saved in `~/.mofu/study`                                                               |
| `/export [file.tsv]` | Saves the deck as a TSV that Anki imports (File → Import), with the page as a note and tags                                                                                                                        |
| `/quiz`              | Runs a quiz right in the terminal. Multiple choice is graded by code (choices are shuffled so the answer isn't always B); short answers go to the model, which grades them against the document and cites the page |

Ask anything else too. Reference tools: Wikipedia, `define_word`, `related_words` (Datamuse), `search_papers` (arXiv), `find_books` (Open Library) and `cite_doi` (Crossref; APA and MLA are formatted by code, not the model).

Web links are fetched only from public addresses: every redirect hop is checked, and localhost, private, link-local and metadata addresses are refused. Pages are capped at 2 MB.

## APIForge: OpenAPI specs

```sh
mofu api docs openapi.yaml                       # Markdown docs → ./mofu-output/<api>-docs.md
mofu api tests openapi.yaml                      # test cases → <api>.tests.json, <api>.test.ts (Vitest), <api>.http
mofu api test openapi.yaml --base-url http://localhost:3000 --auth-header "Authorization: Bearer $TOKEN"
mofu api diff v1.yaml v2.yaml                    # breaking changes → api-diff.md / api-diff.json
```

Specs can be OpenAPI 3.0/3.1 or Swagger 2.0, JSON or YAML, from a file or a public URL. Mofu validates the spec (errors come with their JSON path), resolves `$ref`s and builds an index of every endpoint. All of that is code; the model only writes test cases and short descriptions.

- **Tests:** the model works one tag at a time: a happy path, validation failures and, when the spec documents them, not-found and unauthorized cases. Every case is checked against the spec in code (real endpoint, documented status, required parameters, and happy-path bodies validated against the request schema); only rejected cases go back to the model to fix.
- **Docs:** parameter, body and response tables and the example request/response are generated from the spec; the model writes one to three sentences per endpoint.
- **Running tests** (`mofu api test`): uses `./mofu-output/<api>.tests.json` (or `--suite`; generates one first if there's none), shows the host and request count and asks before sending anything. It warns in yellow when the host isn't localhost or a private address. The auth header (`--auth-header` or `MOFU_API_AUTH`) is never printed and isn't sent with "unauthorized" cases. Runs 4 requests at a time with a 10-second timeout (`--concurrency`, `--timeout`), prints pass/fail with the failing assertion, and writes JSON and Markdown reports to `./mofu-output/`. If anything failed, Mofu summarizes likely causes and you can keep chatting, for example to open the handler code. `--yes` skips the question and exits with code 1 on failures, for scripts and CI.
- **Diff:** removed endpoints, methods and response codes, new required parameters or request fields, removed response fields, type changes, narrowed request enums (and widened response enums) and changed security are classified as breaking by code. The model explains the impact and writes a migration note.

Spec URLs go through the same public-address check as Study Buddy links, so a local server's spec has to be saved to a file first (`curl -o openapi.json http://localhost:3000/openapi.json`).

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
