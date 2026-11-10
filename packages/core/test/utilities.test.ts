import { describe, expect, it } from "vitest";
import { runTool, type MofuTool } from "../src/index.js";
import { wikipediaSummaryTool } from "../src/tools/wikipedia.js";
import { defineWordTool } from "../src/tools/define-word.js";
import { jsonFetch, testContext } from "./helpers.js";

const asTool = (t: unknown) => t as MofuTool;

describe("wikipedia_summary", () => {
  it("returns summary, URL and attribution", async () => {
    const ctx = {
      ...testContext(undefined),
      fetch: jsonFetch({
        type: "standard",
        title: "Photosynthesis",
        description: "Biological process",
        extract: "Photosynthesis is a process…",
        content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Photosynthesis" } },
      }),
    };
    const out = await runTool(asTool(wikipediaSummaryTool), { title: "Photosynthesis" }, ctx);
    expect(out).toMatchObject({
      found: true,
      title: "Photosynthesis",
      url: "https://en.wikipedia.org/wiki/Photosynthesis",
      attribution: expect.stringContaining("Wikipedia"),
    });
  });

  it("flags disambiguation pages", async () => {
    const ctx = {
      ...testContext(undefined),
      fetch: jsonFetch({
        type: "disambiguation",
        title: "Mercury",
        extract: "Mercury may refer to…",
        content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Mercury" } },
      }),
    };
    const out = (await runTool(asTool(wikipediaSummaryTool), { title: "Mercury" }, ctx)) as {
      note?: string;
    };
    expect(out.note).toMatch(/disambiguation/);
  });

  it("handles not found", async () => {
    const ctx = { ...testContext(undefined), fetch: jsonFetch({ title: "Not found." }, 404) };
    const out = await runTool(asTool(wikipediaSummaryTool), { title: "Xqzzy" }, ctx);
    expect(out).toMatchObject({ found: false });
  });

  it("reports unexpected response shapes", async () => {
    const ctx = { ...testContext(undefined), fetch: jsonFetch({ nope: true }) };
    await expect(runTool(asTool(wikipediaSummaryTool), { title: "X" }, ctx)).rejects.toThrow(
      /unexpected format/,
    );
  });
});

describe("define_word", () => {
  it("returns compact definitions", async () => {
    const ctx = {
      ...testContext(undefined),
      fetch: jsonFetch([
        {
          word: "serendipity",
          phonetics: [{ text: "/ˌsɛɹ.ən.ˈdɪp.ɪ.ti/" }],
          meanings: [
            {
              partOfSpeech: "noun",
              definitions: [
                { definition: "A combination of events…", example: "It was pure serendipity." },
                { definition: "b" },
                { definition: "c" },
                { definition: "d" },
              ],
              synonyms: ["chance", "luck"],
            },
          ],
        },
      ]),
    };
    const out = (await runTool(asTool(defineWordTool), { word: "serendipity" }, ctx)) as {
      phonetic: string;
      meanings: Array<{ definitions: unknown[]; synonyms: string[] }>;
    };
    expect(out.phonetic).toBe("/ˌsɛɹ.ən.ˈdɪp.ɪ.ti/");
    expect(out.meanings[0]?.definitions).toHaveLength(3);
    expect(out.meanings[0]?.synonyms).toEqual(["chance", "luck"]);
  });

  it("handles not found", async () => {
    const ctx = {
      ...testContext(undefined),
      fetch: jsonFetch({ title: "No Definitions Found" }, 404),
    };
    expect(await runTool(asTool(defineWordTool), { word: "xqzzy" }, ctx)).toMatchObject({
      found: false,
    });
  });
});
