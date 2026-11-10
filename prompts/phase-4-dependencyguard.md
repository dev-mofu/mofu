# Phase 4 — DependencyGuard

Read `prompts/00-project-brief.md` first. Phases 1–3 must be complete.

## Goal

Scan a project's dependencies for known vulnerabilities, outdated and unmaintained packages. Rank the risks and recommend a safe upgrade order. In the CLI, apply approved upgrades on a branch and verify them with the tests.

Scanning is entirely deterministic. The model only prioritizes, explains and plans, from the scan report.

## Scope

### 1. Parsers (core, deterministic)

Supported in this phase:
- **npm**: `package.json` + `package-lock.json` (lockfile v2 and v3)
- **PyPI**: `requirements.txt` (pinned, ranged and unpinned lines, comments, `-r` includes noted but not followed on the web), and `[project.dependencies]` in `pyproject.toml`

Output: a normalized list of `{ ecosystem, name, version (resolved if known), declaredRange, direct: boolean, path }`.

Handle these explicitly and say so in the report rather than crashing:
- unpinned versions
- missing lockfile
- git/URL dependencies
- workspace packages

### 2. Data sources (core, deterministic)

- **OSV**:
  - Use the batch query endpoint for all packages, then fetch details for the vulnerability IDs returned.
  - Extract: ID, aliases (CVE), summary, severity (CVSS where present), affected ranges, fixed versions, references.
- **npm registry**: latest version, deprecation message, last publish date, repository URL.
- **PyPI JSON**: latest version, yanked status, last release date, project URLs.

Requirements:
- Concurrency limit.
- Timeouts.
- Retry with backoff on 429/5xx.
- Cache:
  - Web: Cloudflare Cache API with a short TTL.
  - CLI: in memory for the run.

### 3. Analysis (core, deterministic)

For each package compute:
- vulnerabilities with severity
- the smallest version that fixes all of them
- versions behind latest
- whether the fix or the latest version is a major-version jump (semver; PEP 440 for Python)
- deprecated or yanked status
- "possibly unmaintained" if there's been no release in 24 months

Produce a `ScanReport` (zod-typed) with per-package findings and totals.

### 4. Model's job

The model receives the `ScanReport` and writes:
- a short risk summary
- a prioritized upgrade plan, grouping changes that should ship together and calling out major-version jumps that may break things
- plain-language explanations of the worst issues

It must only reference IDs and versions that appear in the report. Add a check: any vulnerability ID or version in the model's text that isn't in the report is flagged in the UI.

### 5. Web (Dev Tools mode)

- Input:
  - upload the manifest and lockfile, or
  - paste a public GitHub URL, which the browser uses to fetch just the manifest/lockfile files (as in phase 3)
- The parse runs in the browser. The normalized package list is sent to the Worker, which queries OSV/npm/PyPI.
- Results view:
  - totals header
  - findings table rendered from the deterministic report: package, current, fixed-in, latest, severity, vulnerability IDs linking to OSV, flags
  - filters by severity and type
  - the model's summary and plan next to the table
- Export the report as Markdown.
- Mascot/LED badge shows SCANNING during the scan and FOUND when done.

### 6. CLI

- `mofu deps`: scans the current project and prints a compact table plus the model's plan. `--json` outputs the raw `ScanReport`.
- `mofu deps --fix`:
  1. The user picks which upgrades to apply from the plan.
  2. RepoPilot creates a branch.
  3. It updates manifests and runs the package manager to refresh the lockfile (approved command).
  4. It runs the tests and reports results per upgrade group.
  5. It commits and offers a PR (phase 3 tools and rules).

## Out of scope

Other ecosystems (Go, Maven, Cargo, Composer), license scanning, transitive-only fix strategies like overrides/resolutions (mention them in recommendations only), scheduled scans.

## Cost discipline

- One model call per scan for the summary and plan. Send only packages with findings plus totals, not the full package list.
- No more than about 15 live calls total.

## Verification

1. Build, lint, typecheck and tests pass.
2. Unit tests with fixtures and mocked HTTP cover:
   - each parser (including edge cases above)
   - OSV batch handling and pagination
   - fixed-version calculation
   - major-jump detection for semver and PEP 440
   - the unmaintained heuristic
   - the hallucinated-ID check
3. Manual web run with a fixture project that has at least one known-vulnerable old package (for example an old `lodash` or `requests` version).
4. Manual CLI `--fix` run on a throwaway repo: upgrade one package, run tests, commit.

## Report

Follow "How to work on a phase" in the brief, plus the fixture results.
