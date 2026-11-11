/**
 * Study documents: PDFs (page by page), plain text/Markdown and web pages
 * (split into sections). The model sees an outline and reads only the pages it
 * needs through read_document. Web-safe: no Node.js APIs.
 */

export interface DocumentPart {
  /** 1-based page (PDF) or section (text/web) number. */
  number: number;
  text: string;
}

export interface StudyDocument {
  title: string;
  kind: "pdf" | "text" | "web";
  /** "page" for PDFs, "section" otherwise; used in citations like "page 4". */
  unit: "page" | "section";
  parts: DocumentPart[];
  /** Total parts in the source before any page-range limit. */
  totalParts: number;
  url?: string;
  words: number;
}

/** The subset of pdf.js used here; the caller passes the right build for its runtime. */
export interface PdfJsLike {
  getDocument(src: { data: Uint8Array; verbosity?: number; isEvalSupported?: boolean }): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{
        getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
      }>;
      getMetadata(): Promise<{ info?: { Title?: string } }>;
    }>;
  };
}

export class ScannedPdfError extends Error {
  constructor() {
    super(
      "This PDF has almost no selectable text, so it's probably scanned images. Scanned documents aren't supported yet; try a PDF with real text.",
    );
    this.name = "ScannedPdfError";
  }
}

const SECTION_CHARS = 3_000;
/** Below this many characters per page on average, treat the PDF as scanned. */
const SCANNED_CHARS_PER_PAGE = 40;

const countWords = (text: string) => (text.match(/\S+/g) ?? []).length;

function finish(doc: Omit<StudyDocument, "words">): StudyDocument {
  return { ...doc, words: doc.parts.reduce((n, p) => n + countWords(p.text), 0) };
}

/** Extracts text page by page. Only pages in `range` (1-based, inclusive) are kept. */
export async function extractPdf(
  pdfjs: PdfJsLike,
  bytes: Uint8Array,
  fileName: string,
  range?: { from: number; to: number },
): Promise<StudyDocument> {
  const pdf = await pdfjs.getDocument({ data: bytes, verbosity: 0, isEvalSupported: false })
    .promise;
  const from = Math.max(1, range?.from ?? 1);
  const to = Math.min(pdf.numPages, range?.to ?? pdf.numPages);
  const parts: DocumentPart[] = [];
  for (let n = from; n <= to; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    const text = content.items
      .map((i) => (i.str ?? "") + (i.hasEOL ? "\n" : " "))
      .join("")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    parts.push({ number: n, text });
  }
  const chars = parts.reduce((n, p) => n + p.text.length, 0);
  if (parts.length && chars / parts.length < SCANNED_CHARS_PER_PAGE) throw new ScannedPdfError();
  const meta = await pdf.getMetadata().catch(() => null);
  const title = meta?.info?.Title?.trim() || fileName.replace(/\.pdf$/i, "");
  return finish({ title, kind: "pdf", unit: "page", parts, totalParts: pdf.numPages });
}

/** Splits text into ~3,000-character sections at paragraph boundaries. */
export function splitIntoSections(text: string): DocumentPart[] {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const parts: DocumentPart[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) parts.push({ number: parts.length + 1, text: current.trim() });
    current = "";
  };
  for (const p of paragraphs) {
    if (current && current.length + p.length > SECTION_CHARS) push();
    // A single huge paragraph is cut on sentence boundaries.
    if (p.length > SECTION_CHARS) {
      for (const piece of p.match(new RegExp(`[\\s\\S]{1,${SECTION_CHARS}}(?=\\s|$)`, "g")) ?? [
        p,
      ]) {
        current = piece;
        push();
      }
      continue;
    }
    current += `${current ? "\n\n" : ""}${p}`;
  }
  push();
  return parts;
}

export function textDocument(
  title: string,
  text: string,
  kind: "text" | "web" = "text",
  url?: string,
): StudyDocument {
  const parts = splitIntoSections(text);
  return finish({
    title,
    kind,
    unit: "section",
    parts,
    totalParts: parts.length,
    ...(url && { url }),
  });
}

/** Keeps at most `maxParts` parts and `maxChars` characters; reports what was cut. */
export function limitDocument(
  doc: StudyDocument,
  maxParts: number,
  maxChars: number,
): { doc: StudyDocument; truncated: boolean } {
  const parts: DocumentPart[] = [];
  let chars = 0;
  for (const p of doc.parts) {
    if (parts.length >= maxParts || chars + p.text.length > maxChars) break;
    parts.push(p);
    chars += p.text.length;
  }
  const truncated = parts.length < doc.parts.length;
  return { doc: truncated ? finish({ ...doc, parts }) : doc, truncated };
}

const firstLine = (text: string) => {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 3) ?? "";
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
};

/** What the model gets up front: a card and one line per page/section. */
export function documentOutline(doc: StudyDocument): string {
  const loaded = doc.parts.length
    ? `${doc.unit}s ${doc.parts[0]!.number}–${doc.parts.at(-1)!.number}`
    : `no ${doc.unit}s`;
  const lines = [
    `# Document: ${doc.title}`,
    `Kind: ${doc.kind}${doc.url ? ` (${doc.url})` : ""}. ${doc.totalParts} ${doc.unit}s in total; loaded: ${loaded}. ${doc.words.toLocaleString("en-US")} words.`,
    "",
    `## ${doc.unit === "page" ? "Pages" : "Sections"} (first line of each)`,
  ];
  for (const p of doc.parts) {
    lines.push(`- ${p.number}: ${firstLine(p.text)}`);
    if (lines.join("\n").length > 6_000) {
      lines.push(`- … (${doc.parts.at(-1)!.number - p.number} more)`);
      break;
    }
  }
  return lines.join("\n");
}

/** Parses "3", "1-4", "2,5-7" into part numbers. */
export function parsePartList(spec: string, max: number): number[] {
  const out = new Set<number>();
  for (const piece of spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const m = piece.match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
    if (!m) throw new Error(`Couldn't read "${piece}". Use numbers like 3, 1-4 or 2,5-7.`);
    const a = Number(m[1]);
    const b = Number(m[2] ?? m[1]);
    for (let n = Math.min(a, b); n <= Math.min(Math.max(a, b), max); n++) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

export const MAX_READ_CHARS = 14_000;

/** Text of the requested parts for the model, labeled so it can cite them. */
export function readParts(
  doc: StudyDocument,
  spec: string,
): { text: string; parts: number[]; truncated: boolean } {
  const wanted = new Set(parsePartList(spec, doc.totalParts));
  const available = doc.parts.filter((p) => wanted.has(p.number));
  if (!available.length) {
    throw new Error(
      `No loaded ${doc.unit}s match "${spec}". Loaded ${doc.unit}s are ${doc.parts[0]?.number}–${doc.parts.at(-1)?.number}.`,
    );
  }
  let text = "";
  const parts: number[] = [];
  for (const p of available) {
    const block = `[${doc.unit} ${p.number}]\n${p.text}\n\n`;
    if (text.length + block.length > MAX_READ_CHARS && parts.length) {
      return {
        text: `${text}…[stopped at ${MAX_READ_CHARS} characters; ask for fewer ${doc.unit}s]`,
        parts,
        truncated: true,
      };
    }
    text += block;
    parts.push(p.number);
  }
  return { text: text.trimEnd(), parts, truncated: false };
}
