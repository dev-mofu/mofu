import { z } from "zod";
import { requestJson } from "../deps/http.js";
import { USER_AGENT } from "../tools/http.js";
import { defineTool, type MofuTool, type ToolContext } from "../tools/types.js";

/** Reference lookups for Study Buddy. Run in the Worker on the web, in Node in the CLI. */

const http = (ctx: ToolContext) => ({
  ...(ctx.fetch && { fetch: ctx.fetch }),
  ...(ctx.signal && { signal: ctx.signal }),
});

// ---------- Citations (Crossref), formatted by code ----------

const CrossrefWork = z.object({
  title: z.array(z.string()).optional(),
  author: z
    .array(
      z.object({
        given: z.string().optional(),
        family: z.string().optional(),
        name: z.string().optional(),
      }),
    )
    .optional(),
  "container-title": z.array(z.string()).optional(),
  issued: z.object({ "date-parts": z.array(z.array(z.number().nullable())) }).optional(),
  volume: z.string().optional(),
  issue: z.string().optional(),
  page: z.string().optional(),
  publisher: z.string().optional(),
  DOI: z.string(),
  type: z.string().optional(),
});
export type CrossrefWorkData = z.infer<typeof CrossrefWork>;

const year = (w: CrossrefWorkData) => w.issued?.["date-parts"]?.[0]?.[0] ?? null;
const clean = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

function apaAuthors(w: CrossrefWorkData): string {
  const names = (w.author ?? [])
    .map((a) =>
      a.family
        ? `${a.family}, ${(a.given ?? "")
            .split(/[\s-]+/)
            .filter(Boolean)
            .map((g) => `${g[0]}.`)
            .join(" ")}`
            .trim()
            .replace(/,$/, "")
        : (a.name ?? ""),
    )
    .filter(Boolean);
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 20) return `${names.slice(0, -1).join(", ")}, & ${names.at(-1)}`;
  return `${names.slice(0, 19).join(", ")}, … ${names.at(-1)}`;
}

/** APA 7th edition reference. */
export function formatApa(w: CrossrefWorkData): string {
  const parts = [apaAuthors(w), `(${year(w) ?? "n.d."}).`, `${clean(w.title?.[0] ?? "Untitled")}.`];
  const journal = w["container-title"]?.[0];
  if (journal) {
    let src = `*${clean(journal)}*`;
    if (w.volume) src += `, *${w.volume}*`;
    if (w.issue) src += `(${w.issue})`;
    if (w.page) src += `, ${w.page.replace("-", "–")}`;
    parts.push(`${src}.`);
  } else if (w.publisher) {
    parts.push(`${w.publisher}.`);
  }
  parts.push(`https://doi.org/${w.DOI}`);
  return parts.filter(Boolean).join(" ").replace(/\s+\./g, ".");
}

/** MLA 9th edition works-cited entry. */
export function formatMla(w: CrossrefWorkData): string {
  const authors = w.author ?? [];
  const first = authors[0];
  const name = (a: (typeof authors)[number], inverted: boolean) =>
    a.family
      ? inverted
        ? `${a.family}, ${a.given ?? ""}`.replace(/, $/, "")
        : `${a.given ?? ""} ${a.family}`.trim()
      : (a.name ?? "");
  const who =
    authors.length === 0
      ? ""
      : authors.length === 1
        ? name(first!, true)
        : authors.length === 2
          ? `${name(first!, true)}, and ${name(authors[1]!, false)}`
          : `${name(first!, true)}, et al`;
  const parts = [who ? `${who}.` : "", `"${clean(w.title?.[0] ?? "Untitled")}."`];
  const container = w["container-title"]?.[0];
  const details = [
    container ? `*${clean(container)}*` : w.publisher,
    w.volume && `vol. ${w.volume}`,
    w.issue && `no. ${w.issue}`,
    year(w) ? String(year(w)) : null,
    w.page && `pp. ${w.page.replace("-", "–")}`,
  ].filter(Boolean);
  if (details.length) parts.push(`${details.join(", ")},`);
  parts.push(`https://doi.org/${w.DOI}.`);
  return parts.filter(Boolean).join(" ");
}

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;

export const citeDoiTool = defineTool({
  name: "cite_doi",
  description:
    "Look up a DOI on Crossref and return ready-made APA and MLA citations. Use these exactly; never write a citation yourself.",
  inputSchema: z.object({
    doi: z.string().describe("e.g. 10.1038/nature12373 or https://doi.org/10.1038/nature12373"),
  }),
  kind: "read",
  surfaces: ["web", "cli"],
  summarize: (input) => `cite_doi ${input.doi}`,
  async execute(input, ctx) {
    const doi = input.doi
      .trim()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
      .replace(/^doi:/i, "");
    if (!DOI_PATTERN.test(doi))
      return { found: false, message: `"${input.doi}" doesn't look like a DOI.` };
    const data = await requestJson(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
      z.object({ message: CrossrefWork }),
      http(ctx),
    );
    if (!data) return { found: false, message: `Crossref has no record of ${doi}.` };
    return {
      found: true,
      doi,
      apa: formatApa(data.message),
      mla: formatMla(data.message),
      source: "Crossref",
    };
  },
});

// ---------- Papers (arXiv Atom feed) ----------

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const tag = (xml: string, name: string) =>
  unescapeXml(xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? "");

export function parseArxivFeed(xml: string) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e = ""]) => ({
    title: tag(e, "title").replace(/\s+/g, " "),
    authors: [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)]
      .map((m) => unescapeXml(m[1] ?? "").trim())
      .slice(0, 6),
    published: tag(e, "published").slice(0, 10),
    abstract: tag(e, "summary").replace(/\s+/g, " ").slice(0, 600),
    url: tag(e, "id"),
  }));
}

export const searchPapersTool = defineTool({
  name: "search_papers",
  description:
    "Search arXiv for research papers. Returns titles, authors, dates, abstract excerpts and links (newest relevant first).",
  inputSchema: z.object({
    query: z.string().min(2).max(200),
    max: z.number().int().min(1).max(8).optional(),
  }),
  kind: "read",
  surfaces: ["web", "cli"],
  summarize: (input) => `search_papers ${input.query}`,
  async execute(input, ctx) {
    const q = encodeURIComponent(`all:${input.query}`);
    const res = await (ctx.fetch ?? fetch)(
      `https://export.arxiv.org/api/query?search_query=${q}&max_results=${input.max ?? 5}&sortBy=relevance`,
      { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new Error(`arXiv returned HTTP ${res.status}.`);
    const papers = parseArxivFeed(await res.text());
    return papers.length
      ? { papers, source: "arXiv" }
      : { papers: [], message: "No papers found." };
  },
});

// ---------- Books (Open Library) ----------

export const findBooksTool = defineTool({
  name: "find_books",
  description:
    "Search Open Library for books by title, author or subject. Returns title, authors, first publication year and a link.",
  inputSchema: z.object({ query: z.string().min(2).max(200) }),
  kind: "read",
  surfaces: ["web", "cli"],
  summarize: (input) => `find_books ${input.query}`,
  async execute(input, ctx) {
    const Doc = z.object({
      title: z.string(),
      author_name: z.array(z.string()).optional(),
      first_publish_year: z.number().optional(),
      key: z.string(),
    });
    const data = await requestJson(
      `https://openlibrary.org/search.json?limit=6&fields=title,author_name,first_publish_year,key&q=${encodeURIComponent(input.query)}`,
      z.object({ docs: z.array(Doc) }),
      http(ctx),
    );
    const books = (data?.docs ?? []).map((d) => ({
      title: d.title,
      authors: (d.author_name ?? []).slice(0, 3),
      firstPublished: d.first_publish_year ?? null,
      url: `https://openlibrary.org${d.key}`,
    }));
    return books.length
      ? { books, source: "Open Library" }
      : { books: [], message: "No books found." };
  },
});

// ---------- Words (Datamuse) ----------

export const relatedWordsTool = defineTool({
  name: "related_words",
  description:
    "Find synonyms, words with a similar meaning, or words that rhyme (Datamuse). Useful for essays and vocabulary.",
  inputSchema: z.object({
    word: z.string().min(1).max(60),
    relation: z.enum(["synonyms", "means_like", "rhymes"]).default("means_like"),
  }),
  kind: "read",
  surfaces: ["web", "cli"],
  summarize: (input) => `related_words ${input.word}`,
  async execute(input, ctx) {
    const param =
      input.relation === "synonyms" ? "rel_syn" : input.relation === "rhymes" ? "rel_rhy" : "ml";
    const data = await requestJson(
      `https://api.datamuse.com/words?max=12&${param}=${encodeURIComponent(input.word)}`,
      z.array(z.object({ word: z.string() })),
      http(ctx),
    );
    return { words: (data ?? []).map((w) => w.word), source: "Datamuse" };
  },
});

export const REFERENCE_TOOLS: MofuTool[] = [
  citeDoiTool,
  searchPapersTool,
  findBooksTool,
  relatedWordsTool,
] as MofuTool[];
