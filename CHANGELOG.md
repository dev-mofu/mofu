# Changelog

## 0.1.0 — first public release

**Web app** (free, no account; 10 messages a day or your own OpenRouter key)

- General chat with Wikipedia lookups, word definitions and memory kept in your browser.
- Data Analyst: CSV, Excel and JSON files analyzed with Python (Pyodide) in your browser, charts, Markdown reports, and joins with exchange rates, holidays, weather and World Bank data.
- Study Buddy: PDFs, notes and articles; summaries at three levels with page citations, flashcards with spaced repetition and Anki export, self-grading quizzes, and reference tools (arXiv, Open Library, Crossref citations, Datamuse).
- Dev Tools: explain a public GitHub repository, scan dependencies against OSV and deps.dev, and turn an OpenAPI spec into test cases, docs and a breaking-change report.
- Landing page and docs.
- Free-tier protection: Turnstile, per-IP daily limit in a Durable Object, kill switch, server-side caps.

**CLI** (`npx mofu-cli`)

- Interactive chat and one-shot questions in your project folder, with approval before any file change, command or git action.
- `mofu task` (plan, branch, edit, test, commit, optional pull request), `mofu explain`, `mofu tests`.
- `mofu analyze`, `mofu study`, `mofu deps` (`--json`, `--fix`), `mofu api docs|tests|test|diff`.
