# Phase 5 — Data Analyst

Read `prompts/00-project-brief.md` first. Phases 1–4 must be complete.

## Goal

Let users drop in a CSV, Excel or JSON file and get real analysis: answers to their questions, charts, cleaned data and a short written report.

Python (pandas, matplotlib) runs in Pyodide on the user's side (the browser on the web, Node in the CLI), so the server never executes code and the full dataset never goes to the model.

## Scope

### 1. Pyodide runtime

**Web**
- Pyodide in a dedicated Web Worker, loaded lazily the first time this mode is used, from a pinned CDN version.
- Packages: pandas, matplotlib, openpyxl (for `.xlsx`).
- Show a loading state with progress.

**CLI**
- The `pyodide` npm package in Node, with the same packages.
- The Python sandbox can only see the file the user gave and a scratch output folder.

**Both**
- An execution timeout (30 seconds by default). On the web, terminate and restart the worker on timeout.
- A memory/size cap on input files. Free tier: 20 MB on the web; configurable.

### 2. Profiling (deterministic)

When a file is loaded, Python computes a profile:
- row and column counts
- column names and inferred types
- null counts
- unique counts
- min/max/mean for numeric columns
- top values for categorical columns
- date range for date columns
- 5 sample rows
- detected problems: mixed types, duplicate rows, suspicious outliers, inconsistent date formats

The profile, not the data, is what the model sees first.

### 3. Agent tools

**`run_python`** (kind `exec`)
- Runs code in the user's Pyodide sandbox against the loaded dataframe `df`.
- Returns stdout, a truncated repr of the last expression (max rows/characters), and any figures as PNG.
- **Web:**
  - This is a client-side tool: the model's call is executed by the frontend and the result is sent back to continue the turn. Check the installed AI SDK version's mechanism for client-executed tools.
  - No approval prompt is needed, because it runs in the user's own browser sandbox with no file system or network access beyond the loaded data.
- **CLI:** it follows the normal approval rule, but offer an "approve all analysis code for this session" option because it only touches the sandbox.

**Enrichment tools**
- Fetch keyless data and write it into the sandbox as a CSV the code can join on.
- Return only a short summary to the model.

| Tool | Source | Example use |
|---|---|---|
| `fx_rates` | Frankfurter (historical range) | Convert a price column to USD using each row's date |
| `public_holidays` | Nager.Date | Check whether sales dips line up with holidays |
| `historical_weather` | Open-Meteo Historical (show the non-commercial notice in the README) | Correlate sales with rain or temperature |
| `country_info` | REST Countries | Fill in country names, regions and populations from codes |
| `economic_indicator` | World Bank | Compare against GDP, inflation or population |

On the web these fetches run in the browser where the API allows CORS, otherwise through a small Worker proxy that only allows these specific hosts (no open proxy).

### 4. Outputs

- Charts inline in the chat (PNG), each downloadable.
- `export_csv`: the cleaned or transformed dataframe as a downloadable CSV (web) or file in the working directory (CLI, approved).
- "Generate report": a Markdown report with the questions asked, key findings, charts and caveats. Downloadable.
- Numbers in the model's prose must come from tool output in this conversation. The system prompt for this mode says so explicitly, and the model should show the computed value rather than estimate.

### 5. UX

**Web**
- Drop the file, see the profile card immediately (deterministic, before any model call).
- Suggested starter questions generated from the profile, deterministically where possible.
- Then chat.
- LED badge shows ANALYZING while code runs.
- Collapsible "Code" view on each step, so users can see what ran.

**CLI**
- `mofu analyze <file>` opens chat with the file loaded.
- Figures and exports are saved to `./mofu-output/`.

## Out of scope

Databases, Google Sheets, files over the size cap, scheduled analysis, multi-file joins beyond the enrichment tools (note it as a future idea).

## Cost discipline

- The model sees the profile and small results only.
- Cap tool-result size strictly.
- No more than about 25 live calls total, using two or three small fixture datasets.

## Verification

1. Build, lint, typecheck and tests pass.
2. Tests cover:
   - profiling on fixture CSV/XLSX/JSON, including messy data
   - result truncation
   - timeout handling
   - the enrichment tools against mocked responses
   - the Worker proxy rejecting non-allowlisted hosts
3. Manual web run in Chrome with a sales-like fixture:
   - ask for monthly totals and a chart
   - convert a currency column with `fx_rates`
   - check holidays
   - export cleaned CSV and the report
4. Manual CLI run with the same fixture.

## Report

Follow "How to work on a phase" in the brief, plus the Pyodide load time on the web and a sample generated report.
