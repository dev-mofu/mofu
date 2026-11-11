import {
  CreateFlashcardsInput,
  CreateQuizInput,
  extractPdf,
  limitDocument,
  readParts,
  ReadDocumentInput,
  textDocument,
  type PdfJsLike,
  type StudyDocument,
} from "@mofu/core/web";

/** pdf.js is large; load it only when a PDF is opened. */
async function loadPdfJs(): Promise<PdfJsLike> {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs as unknown as PdfJsLike;
}

export interface LoadedDocument {
  doc: StudyDocument;
  /** Parts were cut to fit the limits. */
  truncated: boolean;
}

export interface DocLimits {
  pages: number;
  chars: number;
}

/** Reads a PDF (optionally a page range) or a text/Markdown file in the browser. */
export async function loadStudyFile(
  file: File,
  limits: DocLimits,
  range?: { from: number; to: number },
): Promise<LoadedDocument> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let doc: StudyDocument;
  if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
    const pdfjs = await loadPdfJs();
    const from = range?.from ?? 1;
    doc = await extractPdf(pdfjs, bytes, file.name, {
      from,
      to: range?.to ?? from + limits.pages - 1,
    });
  } else {
    doc = textDocument(file.name.replace(/\.\w+$/, ""), new TextDecoder().decode(bytes));
  }
  const limited = limitDocument(doc, limits.pages, limits.chars);
  return { doc: limited.doc, truncated: limited.truncated || doc.parts.length < doc.totalParts };
}

export function documentFromPage(
  page: { url: string; title: string; text: string },
  limits: DocLimits,
): LoadedDocument {
  const doc = textDocument(page.title, page.text, "web", page.url);
  return limitDocument(doc, limits.pages, limits.chars);
}

export const STUDY_TOOLS = new Set(["read_document", "create_flashcards", "create_quiz"]);

/** Runs a Study Buddy tool in the browser (the document lives here). */
export function runStudyTool(name: string, input: unknown, doc: StudyDocument): unknown {
  if (name === "read_document") {
    const { parts } = ReadDocumentInput.parse(input);
    const read = readParts(doc, parts);
    return {
      [doc.unit + "s"]: read.parts,
      text: read.text,
      ...(read.truncated && { note: "Stopped early; ask for fewer at a time." }),
    };
  }
  // The views render straight from the validated input; validation errors go back to the model to fix.
  if (name === "create_flashcards") {
    const deck = CreateFlashcardsInput.parse(input);
    return { status: "shown", cards: deck.cards.length };
  }
  if (name === "create_quiz") {
    const quiz = CreateQuizInput.parse(input);
    return {
      status: "shown",
      questions: quiz.questions.length,
      note: "Wait for the user's answers.",
    };
  }
  throw new Error(`Unknown study tool ${name}`);
}
