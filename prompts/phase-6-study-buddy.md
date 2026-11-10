# Phase 6 — Study Buddy

Read `prompts/00-project-brief.md` first. Phases 1–5 must be complete.

## Goal

Turn study material into learning tools: summaries at the level the user wants, interactive flashcards with simple spaced repetition, and graded quizzes. It can also look things up in reference sources so explanations are accurate and sourced.

## Scope

### 1. Inputs and extraction (deterministic)

- **PDF**:
  - Text extraction with pdf.js (browser on the web, `pdfjs-dist` in the CLI).
  - Keep page numbers so the model can cite pages.
  - Detect scanned PDFs (little or no extractable text) and tell the user plainly that scanned documents aren't supported yet.
- **Plain text and Markdown files.**
- **URLs**, fetched by the Worker (web) or Node (CLI):
  - http/https only
  - block private, loopback and link-local addresses, including after DNS resolution and redirects
  - size cap
  - timeout
  - main-content extraction (readability-style)
- **Limits**:
  - Free tier: 30 PDF pages and a character cap.
  - BYOK: higher configurable caps.
  - Over the limit, offer to work on a page range instead of silently truncating.

### 2. Chunking

- Split documents into page- or section-based chunks with stable IDs.
- For long material, summarize per chunk, then combine. Only send the chunks a request needs (for example, "flashcards for chapter 3" sends chapter 3).

### 3. Features

**Summaries**
- Levels: short, detailed, and "explain like I'm 12".
- Each summary cites page numbers or sections.

**Flashcards**
- Generated as structured output validated against a zod schema: `{ front, back, source (page/section), tags }`.
- **Web**:
  - Interactive deck: flip, mark "knew it" / "didn't know".
  - Simple Leitner-box spaced repetition.
  - Decks and progress stored in localStorage.
  - Export as Anki-importable TSV.
- **CLI**: review in the terminal, export TSV.

**Quizzes**
- Multiple choice and short answer, structured output.
- Grading: multiple choice is graded deterministically. Short answers are graded by the model against the source passage, with an explanation and the page reference.
- "Harder / easier" adjusts the next round.

**Explain**
- Explain any concept from the material in simpler terms, using reference tools when the material isn't enough.

### 4. Reference tools (both surfaces)

| Tool | Source | Notes |
|---|---|---|
| `wikipedia_summary` | Wikimedia REST (from phase 1) | Always show attribution |
| `define_word` | Free Dictionary API (from phase 1) | |
| `search_papers` | arXiv API (Atom XML) | Title, authors, date, abstract excerpt, link |
| `cite_doi` | Crossref REST | Fetch metadata and format APA and MLA deterministically in code; the model never writes citations itself |
| `find_books` | Open Library | Title, author, year, link |
| `related_words` | Datamuse | Synonyms, related words, "means like" |

### 5. UX

**Web (Study Buddy mode)**
- Upload or paste a link, see a document card (title, pages, word count) immediately.
- Then action buttons: Summarize, Flashcards, Quiz, Explain, plus chat.
- LED badge shows STUDYING while working.
- Flashcard and quiz views are proper components, not chat text.

**CLI**
- `mofu study <file-or-url>` opens chat with the document loaded.
- Subcommands or slash commands for summary, flashcards (`--export deck.tsv`) and quiz.

## Out of scope

OCR, audio/video, YouTube transcripts, collaborative decks, accounts.

## Cost discipline

- Chunk-targeted context only.
- Use structured output for flashcards and quizzes to avoid retries.
- Cache summaries per chunk in the session.
- No more than about 25 live calls total, using one short fixture PDF and one URL.

## Verification

1. Build, lint, typecheck and tests pass.
2. Tests cover:
   - PDF extraction with page numbers
   - scanned-PDF detection
   - the SSRF guard (private IPs, redirects to private IPs, non-http schemes)
   - chunking
   - flashcard/quiz schema validation
   - deterministic MCQ grading
   - Leitner scheduling
   - APA/MLA formatting from fixture Crossref data
   - each reference tool against mocked responses
3. Manual web run in Chrome:
   - upload a short PDF
   - summary at two levels
   - generate and review flashcards
   - export TSV
   - take a quiz and get graded
   - cite a DOI
4. Manual CLI run of the same flow.

## Report

Follow "How to work on a phase" in the brief, plus sample outputs (one summary, five flashcards, one graded quiz).
