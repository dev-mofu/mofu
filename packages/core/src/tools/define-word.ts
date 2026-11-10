import { z } from "zod";
import { defineTool } from "./types.js";
import { fetchJson, NotFoundError } from "./http.js";

const EntrySchema = z.object({
  word: z.string(),
  phonetic: z.string().optional(),
  phonetics: z.array(z.object({ text: z.string().optional() })).optional(),
  meanings: z.array(
    z.object({
      partOfSpeech: z.string(),
      definitions: z.array(
        z.object({
          definition: z.string(),
          example: z.string().optional(),
        }),
      ),
      synonyms: z.array(z.string()).optional(),
    }),
  ),
});

const MAX_MEANINGS = 4;
const MAX_DEFINITIONS = 3;
const MAX_SYNONYMS = 6;

export const defineWordTool = defineTool({
  name: "define_word",
  description:
    "Look up an English word in the dictionary. Returns pronunciation, part of speech, definitions, " +
    "example sentences and synonyms.",
  inputSchema: z.object({
    word: z.string().min(1).max(60).describe("A single English word or short phrase."),
  }),
  kind: "read",
  surfaces: ["web", "cli"],
  summarize: (input) => `define_word ${input.word}`,
  async execute(input, ctx) {
    const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(input.word.trim())}`;
    try {
      const entries = await fetchJson(url, z.array(EntrySchema), ctx);
      const first = entries[0];
      if (!first) return { found: false, message: `No definition found for "${input.word}".` };
      const phonetic = first.phonetic ?? first.phonetics?.find((p) => p.text)?.text;
      return {
        found: true,
        word: first.word,
        phonetic,
        meanings: entries
          .flatMap((e) => e.meanings)
          .slice(0, MAX_MEANINGS)
          .map((m) => ({
            partOfSpeech: m.partOfSpeech,
            definitions: m.definitions.slice(0, MAX_DEFINITIONS),
            synonyms: (m.synonyms ?? []).slice(0, MAX_SYNONYMS),
          })),
      };
    } catch (err) {
      if (err instanceof NotFoundError) {
        return { found: false, message: `No definition found for "${input.word}".` };
      }
      throw err;
    }
  },
});
