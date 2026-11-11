import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import {
  CreateFlashcardsInput,
  CreateQuizInput,
  defineTool,
  documentOutline,
  dueCards,
  extractPdf,
  fetchPublicPage,
  gradeMultipleChoice,
  limitDocument,
  newProgress,
  readParts,
  ReadDocumentInput,
  review,
  ScannedPdfError,
  shuffleChoices,
  STUDY_SECTION,
  STUDY_TOOL_SPECS,
  textDocument,
  toAnkiTsv,
  type CardProgress,
  type Flashcard,
  type MofuTool,
  type PdfJsLike,
  type Quiz,
  type StudyDocument,
} from "@mofu/core";
import { mofuHome } from "./config.js";
import type { Terminal } from "./terminal.js";
import type { Printer } from "./ui.js";

/** The CLI runs on the user's own key, so it gets the higher limits. */
export const CLI_DOC_PAGES = 300;
export const CLI_DOC_CHARS = 400_000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

const SUMMARY_PROMPTS: Record<string, string> = {
  short: "Summarize this document (short: 5 bullet points), citing pages.",
  detailed: "Give me a detailed, structured summary of this document, citing pages.",
  eli12: "Explain the main ideas of this document like I'm 12, with an everyday example.",
};
const FLASHCARDS_PROMPT = "Make 15 flashcards covering the key facts of this document.";
const QUIZ_PROMPT =
  "Quiz me on this document: 6 questions, mixing multiple choice and short answer.";

export const STUDY_SLASH_HELP = `Study:
  /summary [short|detailed|eli12]  Summarize the document
  /flashcards   Make flashcards, then /review to practice them
  /review       Review due flashcards (Leitner schedule, saved in ~/.mofu/study)
  /quiz         Take a quiz on the document
  /export [file.tsv]  Save the latest deck for Anki`;

const spec = (name: string) => STUDY_TOOL_SPECS.find((s) => s.name === name)!;

/** dns.lookup returns every address so the SSRF guard can check them all. */
const nodeResolver = async (host: string) =>
  (await lookup(host, { all: true })).map((a) => a.address);

export function parsePageRange(raw: string | undefined): { from: number; to: number } | undefined {
  if (!raw) return undefined;
  const m = raw.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) throw new Error(`--pages takes a range like 10-40, not "${raw}".`);
  const from = Number(m[1]);
  const to = Number(m[2] ?? m[1]);
  if (from < 1 || to < from) throw new Error(`--pages ${raw} isn't a valid range.`);
  return { from, to };
}

async function loadDocument(
  target: string,
  range?: { from: number; to: number },
): Promise<StudyDocument> {
  if (/^https?:\/\//i.test(target)) {
    const page = await fetchPublicPage(target, nodeResolver);
    return textDocument(page.title, page.text, "web", page.url);
  }
  const abs = path.resolve(target);
  const info = await stat(abs).catch(() => null);
  if (!info?.isFile()) throw new Error(`No such file: ${target}`);
  if (info.size > MAX_FILE_BYTES)
    throw new Error(`That file is ${Math.round(info.size / 1e6)} MB; the limit is 100 MB.`);
  const bytes = new Uint8Array(await readFile(abs));
  const name = path.basename(abs);
  if (/\.pdf$/i.test(name)) {
    // The legacy build runs in Node without DOM APIs.
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJsLike;
    const from = range?.from ?? 1;
    return extractPdf(pdfjs, bytes, name, { from, to: range?.to ?? from + CLI_DOC_PAGES - 1 });
  }
  if (!/\.(txt|md|markdown|text)$/i.test(name))
    throw new Error("mofu study reads PDF, .txt and .md files, or a web link.");
  return textDocument(name.replace(/\.\w+$/, ""), new TextDecoder().decode(bytes));
}

interface Deck {
  title: string;
  cards: Flashcard[];
}

/** One study session: the document, the latest deck and quiz, and the terminal views. */
export class StudySession {
  readonly tools: MofuTool[];
  readonly modeSection: string;
  private deck: Deck | null = null;
  private pendingQuiz: Quiz | null = null;
  private deckAnnounced: Deck | null = null;

  constructor(
    readonly doc: StudyDocument,
    private readonly printer: Printer,
  ) {
    this.modeSection = `${STUDY_SECTION}\n\n<document_outline>\n${documentOutline(doc)}\n</document_outline>`;
    this.tools = [
      defineTool({
        name: "read_document",
        description: spec("read_document").description,
        inputSchema: ReadDocumentInput,
        kind: "read",
        surfaces: ["cli"],
        summarize: (input) => `read_document ${doc.unit}s ${input.parts}`,
        execute: async ({ parts }) => {
          const read = readParts(doc, parts);
          return {
            [`${doc.unit}s`]: read.parts,
            text: read.text,
            ...(read.truncated && { note: "Stopped early; ask for fewer at a time." }),
          };
        },
      }),
      defineTool({
        name: "create_flashcards",
        description: `${spec("create_flashcards").description} In the terminal the user practices them with /review.`,
        inputSchema: CreateFlashcardsInput,
        kind: "read",
        surfaces: ["cli"],
        summarize: (input) => `create_flashcards ${input.title}`,
        execute: async (input) => {
          this.deck = { title: input.title, cards: input.cards };
          return {
            status: "saved",
            cards: input.cards.length,
            note: "Tell the user to type /review to practice or /export to save for Anki.",
          };
        },
      }),
      defineTool({
        name: "create_quiz",
        description: `${spec("create_quiz").description} In the terminal it starts as soon as your reply ends.`,
        inputSchema: CreateQuizInput,
        kind: "read",
        surfaces: ["cli"],
        summarize: (input) => `create_quiz ${input.title}`,
        execute: async (input) => {
          this.pendingQuiz = shuffleChoices(input, randomUUID());
          return {
            status: "shown",
            questions: input.questions.length,
            note: "Keep your reply to one short line; the quiz starts right after it.",
          };
        },
      }),
    ];
  }

  printCard(): void {
    const d = this.doc;
    const where =
      d.kind === "pdf"
        ? `PDF, pages ${d.parts[0]?.number}–${d.parts.at(-1)?.number} of ${d.totalParts}`
        : `${d.parts.length} sections${d.url ? ` · ${new URL(d.url).hostname}` : ""}`;
    this.printer.line();
    this.printer.line(pc.bold(d.title));
    this.printer.line(pc.dim(`${where} · ${d.words.toLocaleString("en-US")} words`));
  }

  /** Called after each reply: runs a quiz the model just made. Returns a follow-up to send, if any. */
  async afterTurn(terminal: Terminal): Promise<string | null> {
    if (this.deck && this.deckAnnounced !== this.deck) {
      this.deckAnnounced = this.deck;
      this.printer.line(
        pc.green(
          `  ${this.deck.cards.length} flashcards ready. /review to practice, /export to save for Anki.`,
        ),
      );
    }
    const quiz = this.pendingQuiz;
    if (!quiz) return null;
    this.pendingQuiz = null;
    return this.runQuiz(quiz, terminal);
  }

  private async runQuiz(quiz: Quiz, terminal: Terminal): Promise<string | null> {
    const p = this.printer;
    p.line();
    p.line(
      pc.bold(`Quiz: ${quiz.title}`) +
        pc.dim(` (${quiz.difficulty}) · Enter on an empty line skips`),
    );
    let right = 0;
    let mcq = 0;
    const written: string[] = [];
    for (const [i, q] of quiz.questions.entries()) {
      p.line();
      p.line(pc.bold(`${i + 1}. ${q.question}`));
      if (q.type === "multiple_choice") {
        mcq++;
        q.choices.forEach((c, n) => p.line(`   ${String.fromCharCode(65 + n)}. ${c}`));
        const letters = q.choices.map((_, n) => String.fromCharCode(97 + n));
        let pick: number | null = null;
        for (;;) {
          const a =
            (await terminal.ask(`   Your answer (${letters.join("/")}): `))?.trim().toLowerCase() ??
            "";
          if (!a) break;
          const n = letters.indexOf(a[0]!);
          if (n >= 0 && a.length === 1) {
            pick = n;
            break;
          }
        }
        if (pick === null) {
          p.line(
            pc.dim(
              `   Skipped. Answer: ${String.fromCharCode(65 + q.answerIndex)}. ${q.explanation} (${q.source})`,
            ),
          );
          continue;
        }
        const graded = gradeMultipleChoice(q, pick);
        if (graded.correct) right++;
        p.line(
          graded.correct
            ? pc.green(`   Correct. ${q.explanation} (${q.source})`)
            : pc.red(
                `   Not quite: it's ${String.fromCharCode(65 + q.answerIndex)}. ${q.explanation} (${q.source})`,
              ),
        );
      } else {
        const a = (await terminal.ask("   Your answer: "))?.trim() ?? "";
        if (a)
          written.push(
            `Question ${i + 1} ("${q.question}")\nMy answer: ${a}\nModel answer: ${q.answer} (${q.source})`,
          );
        else p.line(pc.dim(`   Skipped. Model answer: ${q.answer} (${q.source})`));
      }
    }
    p.line();
    if (mcq) p.line(pc.bold(`Multiple choice: ${right}/${mcq} correct.`));
    if (!written.length) {
      p.line(pc.dim("Type /quiz for another, or ask for a harder or easier one."));
      return null;
    }
    p.line(pc.dim("Mofu is checking your written answers…"));
    return `Grade my short answers. For each, say if I'm right, what's missing, and cite the page.\n\n${written.join("\n\n")}`;
  }

  private progressFile(deck: Deck): string {
    const id = createHash("sha1")
      .update(deck.cards.map((c) => c.front).join("\n"))
      .digest("hex")
      .slice(0, 16);
    return path.join(mofuHome(), "study", `${id}.json`);
  }

  private async loadProgress(deck: Deck): Promise<CardProgress[]> {
    try {
      const saved = JSON.parse(await readFile(this.progressFile(deck), "utf8")) as CardProgress[];
      if (Array.isArray(saved) && saved.length === deck.cards.length) return saved;
    } catch {
      // First review of this deck.
    }
    return deck.cards.map(() => newProgress(new Date()));
  }

  async review(terminal: Terminal): Promise<void> {
    const p = this.printer;
    const deck = this.deck;
    if (!deck) {
      p.line(pc.dim("No flashcards yet. Type /flashcards to make some."));
      return;
    }
    let progress = await this.loadProgress(deck);
    const due = dueCards(progress, new Date());
    if (!due.length) {
      p.line(pc.green("All caught up. Cards you knew come back in 1, 3, 7 and 14 days."));
      return;
    }
    p.line(
      pc.dim(
        `${due.length} cards due. Enter shows the answer; then y = knew it, n = didn't, q = stop.`,
      ),
    );
    let reviewed = 0;
    for (const index of due) {
      const card = deck.cards[index]!;
      p.line();
      p.line(pc.bold(`Q: ${card.front}`));
      if ((await terminal.ask(pc.dim("   (Enter to flip) "))) === null) break;
      p.line(`A: ${card.back}`);
      p.line(pc.dim(`   ${card.source}`));
      const a = await terminal.choose("   Knew it? (y/n/q) ", ["y", "n", "q"]);
      if (a === "q") break;
      progress = progress.map((x, i) => (i === index ? review(x, a === "y", new Date()) : x));
      reviewed++;
    }
    const file = this.progressFile(deck);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(progress));
    p.line();
    p.line(
      pc.dim(
        `Reviewed ${reviewed}. ${progress.filter((x) => x.box >= 4).length}/${deck.cards.length} cards learned.`,
      ),
    );
  }

  async export(file: string | undefined): Promise<void> {
    if (!this.deck) {
      this.printer.line(pc.dim("No flashcards yet. Type /flashcards to make some."));
      return;
    }
    const name = file || `${this.deck.title.replace(/[^\w-]+/g, "_").slice(0, 60) || "deck"}.tsv`;
    const abs = path.resolve(name);
    await writeFile(abs, toAnkiTsv(this.deck.cards, this.deck.title));
    this.printer.line(
      pc.green(`  saved ${path.relative(process.cwd(), abs) || name}`) +
        pc.dim(" (Anki: File → Import)"),
    );
  }

  /**
   * Handles study slash commands. Returns the message to send to Mofu, true
   * when handled locally, or false when it isn't a study command.
   */
  async slash(cmd: string, args: string[], terminal: Terminal): Promise<string | boolean> {
    switch (cmd) {
      case "summary": {
        const level = (args[0] ?? "short").toLowerCase();
        const prompt = SUMMARY_PROMPTS[level];
        if (!prompt) {
          this.printer.line("Use /summary short, /summary detailed or /summary eli12.");
          return true;
        }
        return prompt;
      }
      case "flashcards":
        return FLASHCARDS_PROMPT;
      case "quiz":
        return QUIZ_PROMPT;
      case "review":
        await this.review(terminal);
        return true;
      case "export":
        await this.export(args[0]);
        return true;
      default:
        return false;
    }
  }
}

/** Loads the document and prints its card. Returns null after printing why it failed. */
export async function startStudy(
  target: string,
  pages: string | undefined,
  printer: Printer,
): Promise<StudySession | null> {
  let doc: StudyDocument;
  try {
    const range = parsePageRange(pages);
    printer.line(pc.dim(/^https?:/i.test(target) ? "Fetching the page…" : "Reading…"));
    doc = await loadDocument(target, range);
  } catch (err) {
    printer.error(
      err instanceof ScannedPdfError
        ? "This PDF looks scanned (images of pages), so there's no text to read. Try a PDF with selectable text."
        : err instanceof Error
          ? err.message
          : String(err),
    );
    return null;
  }
  const limited = limitDocument(doc, CLI_DOC_PAGES, CLI_DOC_CHARS);
  if (!limited.doc.parts.length) {
    printer.error("No readable text was found.");
    return null;
  }
  const session = new StudySession(limited.doc, printer);
  session.printCard();
  const shown = limited.doc.parts;
  if (limited.truncated || shown.length < doc.totalParts) {
    const next = (shown.at(-1)?.number ?? 0) + 1;
    printer.line(
      pc.yellow(
        doc.kind === "pdf"
          ? `Only pages ${shown[0]?.number}–${shown.at(-1)?.number} are loaded. For more, run: mofu study ${JSON.stringify(target)} --pages ${next}-${next + CLI_DOC_PAGES - 1}`
          : "Only the first part is loaded; the rest was too long.",
      ),
    );
  }
  printer.line();
  printer.line(pc.dim(STUDY_SLASH_HELP));
  return session;
}
