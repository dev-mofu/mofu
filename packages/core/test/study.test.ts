import { describe, expect, it } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  assertPublicUrl,
  CreateQuizInput,
  documentOutline,
  dueCards,
  extractPdf,
  fetchPublicPage,
  formatApa,
  formatMla,
  gradeMultipleChoice,
  shuffleChoices,
  htmlToText,
  isPrivateAddress,
  limitDocument,
  newProgress,
  parseArxivFeed,
  parsePartList,
  readParts,
  review,
  runTool,
  ScannedPdfError,
  splitIntoSections,
  textDocument,
  toAnkiTsv,
  UnsafeUrlError,
  citeDoiTool,
  relatedWordsTool,
  type MofuTool,
  type PdfJsLike,
} from "../src/index.js";
import { jsonFetch, testContext } from "./helpers.js";

/** A minimal valid PDF with one text line per page ("" makes an empty page). */
function makePdf(pages: string[]): Uint8Array {
  const objs: string[] = [];
  const add = (s: string) => objs.push(s);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pagesId = 1 + pages.length * 2 + 1;
  const kids: number[] = [];
  for (const text of pages) {
    const content = text ? `BT /F1 14 Tf 72 720 Td (${text}) Tj ET` : "";
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${objs.length} 0 R /Resources << /Font << /F1 1 0 R >> >> >>`,
    );
    kids.push(objs.length);
  }
  add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`);
  add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${objs.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const pdf = pdfjs as unknown as PdfJsLike;
const longLine = (n: number) =>
  `Page ${n}: ${"Mitochondria produce ATP through cellular respiration. ".repeat(2)}`;

describe("PDF extraction", () => {
  it("keeps page numbers and honors a page range", async () => {
    const bytes = makePdf([longLine(1), longLine(2), longLine(3)]);
    const doc = await extractPdf(pdf, bytes, "biology.pdf", { from: 2, to: 3 });
    expect(doc).toMatchObject({ title: "biology", kind: "pdf", unit: "page", totalParts: 3 });
    expect(doc.parts.map((p) => p.number)).toEqual([2, 3]);
    expect(doc.parts[0]?.text).toContain("Page 2: Mitochondria");
  });

  it("detects scanned PDFs (no selectable text)", async () => {
    await expect(extractPdf(pdf, makePdf(["", ""]), "scan.pdf")).rejects.toBeInstanceOf(
      ScannedPdfError,
    );
  });
});

describe("documents", () => {
  const paragraphs = Array.from(
    { length: 12 },
    (_, i) => `Paragraph ${i + 1}. ${"Word ".repeat(80)}`,
  ).join("\n\n");

  it("splits text into sections at paragraph boundaries", () => {
    const parts = splitIntoSections(paragraphs);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.text.length <= 3_100)).toBe(true);
    expect(parts[0]?.text.startsWith("Paragraph 1.")).toBe(true);
  });

  it("outlines, limits and reads parts with labels", () => {
    const doc = textDocument("Notes", paragraphs);
    expect(documentOutline(doc)).toMatch(/^# Document: Notes\nKind: text\. \d+ sections in total/);
    const { doc: small, truncated } = limitDocument(doc, 1, 100_000);
    expect(truncated).toBe(true);
    expect(small.parts).toHaveLength(1);
    const read = readParts(doc, "2");
    expect(read.text.startsWith("[section 2]\n")).toBe(true);
    expect(() => readParts(small, "9")).toThrow(/No loaded sections/);
  });

  it("parses part lists", () => {
    expect(parsePartList("2,5-7, 3", 10)).toEqual([2, 3, 5, 6, 7]);
    expect(parsePartList("8-12", 10)).toEqual([8, 9, 10]);
    expect(() => parsePartList("chapter 3", 10)).toThrow(/Couldn't read/);
  });
});

describe("web pages", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:10.0.0.1",
  ])("treats %s as private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(["93.184.216.34", "1.1.1.1", "2606:4700::1111"])("treats %s as public", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  const resolver = (map: Record<string, string[]>) => async (host: string) => map[host] ?? [];

  it("refuses non-http schemes, credentials, private names and private DNS answers", async () => {
    const resolve = resolver({
      "intranet.example.com": ["10.0.0.5"],
      "good.example.com": ["93.184.216.34"],
    });
    await expect(assertPublicUrl("file:///etc/passwd", resolve)).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    await expect(assertPublicUrl("ftp://good.example.com/x", resolve)).rejects.toThrow(
      /http and https/,
    );
    await expect(assertPublicUrl("http://user:pw@good.example.com", resolve)).rejects.toThrow(
      /credentials/,
    );
    await expect(assertPublicUrl("http://localhost:8080", resolve)).rejects.toThrow(/isn't public/);
    await expect(assertPublicUrl("http://169.254.169.254/latest", resolve)).rejects.toThrow(
      /isn't public/,
    );
    await expect(assertPublicUrl("https://intranet.example.com", resolve)).rejects.toThrow(
      /isn't public/,
    );
    await expect(assertPublicUrl("https://good.example.com/a", resolve)).resolves.toBeInstanceOf(
      URL,
    );
  });

  it("re-checks every redirect hop", async () => {
    const resolve = resolver({ "good.example.com": ["93.184.216.34"] });
    const fetchFn = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/admin" },
      })) as unknown as typeof fetch;
    await expect(fetchPublicPage("https://good.example.com/", resolve, fetchFn)).rejects.toThrow(
      /isn't public/,
    );
  });

  it("extracts the main text of a page", async () => {
    const html = `<html><head><title>Photosynthesis &amp; you</title><script>alert(1)</script></head>
      <body><nav>Home | About</nav><article><h1>Photosynthesis</h1><p>Plants turn light into sugar.</p>
      <p>${"More text. ".repeat(60)}</p><ul><li>Chlorophyll</li></ul></article><footer>© 2026</footer></body></html>`;
    const { title, text } = htmlToText(html);
    expect(title).toBe("Photosynthesis & you");
    expect(text.startsWith("Photosynthesis\n\nPlants turn light into sugar.")).toBe(true);
    expect(text).toContain("• Chlorophyll");
    expect(text).not.toMatch(/alert|Home \| About|© 2026/);
    const resolve = resolver({ "good.example.com": ["93.184.216.34"] });
    const page = await fetchPublicPage(
      "https://good.example.com/p",
      resolve,
      (async () =>
        new Response(html, {
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch,
    );
    expect(page.title).toBe("Photosynthesis & you");
  });
});

describe("flashcards and quizzes", () => {
  it("validates quizzes, including answer indexes", () => {
    const good = CreateQuizInput.parse({
      title: "Cells",
      questions: [
        {
          type: "multiple_choice",
          question: "Powerhouse?",
          choices: ["Nucleus", "Mitochondria"],
          answerIndex: 1,
          explanation: "ATP",
          source: "page 2",
        },
        {
          type: "short_answer",
          question: "What is ATP?",
          answer: "Energy currency",
          source: "page 2",
        },
      ],
    });
    expect(good.difficulty).toBe("medium");
    expect(gradeMultipleChoice(good.questions[0]!, 1)).toEqual({
      correct: true,
      answer: "Mitochondria",
    });
    expect(gradeMultipleChoice(good.questions[0]!, 0).correct).toBe(false);

    // Shuffling keeps the right answer attached and is stable per seed.
    const many = {
      ...good,
      questions: Array.from({ length: 40 }, () => ({
        type: "multiple_choice" as const,
        question: "q",
        choices: ["a", "b", "c", "d"],
        answerIndex: 1,
        explanation: "e",
        source: "page 1",
      })),
    };
    const shuffled = shuffleChoices(many, "seed-1");
    for (const q of shuffled.questions)
      if (q.type === "multiple_choice") expect(q.choices[q.answerIndex]).toBe("b");
    expect(
      new Set(shuffled.questions.map((q) => (q.type === "multiple_choice" ? q.answerIndex : -1)))
        .size,
    ).toBeGreaterThan(2);
    expect(shuffleChoices(many, "seed-1")).toEqual(shuffled);
    expect(shuffleChoices(good, "x").questions[1]).toEqual(good.questions[1]);
    const bad = CreateQuizInput.safeParse({
      title: "x",
      questions: [
        {
          type: "multiple_choice",
          question: "q",
          choices: ["a", "b"],
          answerIndex: 2,
          explanation: "",
          source: "p1",
        },
      ],
    });
    expect(bad.success).toBe(false);
  });

  it("schedules cards with Leitner boxes", () => {
    const now = new Date("2026-11-10T10:00:00Z");
    let p = newProgress(now);
    p = review(p, true, now);
    expect(p.box).toBe(2);
    expect(p.due).toBe("2026-11-11T10:00:00.000Z");
    p = review(review(review(review(p, true, now), true, now), true, now), true, now);
    expect(p.box).toBe(5); // capped
    expect(review(p, false, now)).toEqual({ box: 1, due: now.toISOString() });
    const deck = [
      { box: 3, due: "2026-11-01T00:00:00Z" },
      { box: 1, due: "2026-11-09T00:00:00Z" },
      { box: 2, due: "2026-12-01T00:00:00Z" },
    ];
    expect(dueCards(deck, now)).toEqual([1, 0]);
  });

  it("exports Anki TSV with escaped tabs and newlines", () => {
    const tsv = toAnkiTsv(
      [{ front: "ATP\tdef", back: "Energy\ncurrency", source: "page 2", tags: ["cell bio"] }],
      "Biology",
    );
    const line = tsv.trim().split("\n").at(-1)!;
    expect(line).toBe("ATP def\tEnergy<br>currency<br><small>page 2</small>\tBiology cell_bio");
    expect(tsv.startsWith("#separator:tab")).toBe(true);
  });
});

describe("citations and references", () => {
  const work = {
    DOI: "10.1038/nature12373",
    title: ["Nanometre-scale thermometry in a living cell"],
    author: [
      { given: "G.", family: "Kucsko" },
      { given: "P. C.", family: "Maurer" },
      { given: "Mikhail D.", family: "Lukin" },
    ],
    "container-title": ["Nature"],
    issued: { "date-parts": [[2013, 7, 31]] },
    volume: "500",
    issue: "7460",
    page: "54-58",
  };

  it("formats APA and MLA from Crossref data", () => {
    expect(formatApa(work)).toBe(
      "Kucsko, G., Maurer, P. C., & Lukin, M. D. (2013). Nanometre-scale thermometry in a living cell. *Nature*, *500*(7460), 54–58. https://doi.org/10.1038/nature12373",
    );
    expect(formatMla(work)).toBe(
      'Kucsko, G., et al. "Nanometre-scale thermometry in a living cell." *Nature*, vol. 500, no. 7460, 2013, pp. 54–58, https://doi.org/10.1038/nature12373.',
    );
  });

  it("cite_doi accepts doi.org links and reports unknown DOIs", async () => {
    const ok = await runTool(
      citeDoiTool as unknown as MofuTool,
      { doi: "https://doi.org/10.1038/nature12373" },
      { ...testContext(undefined), fetch: jsonFetch({ message: work }) },
    );
    expect(ok).toMatchObject({ found: true, apa: expect.stringContaining("(2013)") });
    const missing = await runTool(
      citeDoiTool as unknown as MofuTool,
      { doi: "10.9999/nope" },
      { ...testContext(undefined), fetch: jsonFetch({}, 404) },
    );
    expect(missing).toMatchObject({ found: false });
    const notDoi = await runTool(
      citeDoiTool as unknown as MofuTool,
      { doi: "hello" },
      testContext(undefined),
    );
    expect(notDoi).toMatchObject({ found: false });
  });

  it("parses arXiv's Atom feed", () => {
    const xml = `<feed><entry><id>http://arxiv.org/abs/2401.00001v1</id><published>2024-01-01T00:00:00Z</published>
      <title>Light &amp; Leaves:
        A Study</title><summary>  We study leaves.  </summary><author><name>Ada Lovelace</name></author></entry></feed>`;
    expect(parseArxivFeed(xml)).toEqual([
      {
        title: "Light & Leaves: A Study",
        authors: ["Ada Lovelace"],
        published: "2024-01-01",
        abstract: "We study leaves.",
        url: "http://arxiv.org/abs/2401.00001v1",
      },
    ]);
  });

  it("related_words returns Datamuse words", async () => {
    const out = await runTool(
      relatedWordsTool as unknown as MofuTool,
      { word: "happy", relation: "synonyms" },
      {
        ...testContext(undefined),
        fetch: jsonFetch([{ word: "glad" }, { word: "joyful" }]),
      },
    );
    expect(out).toEqual({ words: ["glad", "joyful"], source: "Datamuse" });
  });
});
