import { z } from "zod";
import { defineTool } from "./types.js";
import { fetchJson, NotFoundError } from "./http.js";

const SummarySchema = z.object({
  type: z.string(),
  title: z.string(),
  description: z.string().optional(),
  extract: z.string(),
  content_urls: z.object({ desktop: z.object({ page: z.string() }) }),
});

export const wikipediaSummaryTool = defineTool({
  name: "wikipedia_summary",
  description:
    "Get the introduction of a Wikipedia article. Use it to check facts or give background on a topic. " +
    "Returns title, short description, summary text and the article URL. Always credit Wikipedia with the URL " +
    "when you use this content.",
  inputSchema: z.object({
    title: z.string().min(1).describe("Article title or topic, e.g. 'Photosynthesis'."),
    language: z
      .string()
      .regex(/^[a-z]{2,3}$/)
      .optional()
      .describe("Wikipedia language code. Defaults to 'en'."),
  }),
  kind: "read",
  surfaces: ["web", "cli"],
  summarize: (input) => `wikipedia_summary ${input.title}`,
  async execute(input, ctx) {
    const lang = input.language ?? "en";
    const slug = encodeURIComponent(input.title.trim().replace(/ /g, "_"));
    const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${slug}?redirect=true`;
    try {
      const page = await fetchJson(url, SummarySchema, ctx);
      return {
        found: true,
        title: page.title,
        description: page.description,
        summary: page.extract,
        url: page.content_urls.desktop.page,
        ...(page.type === "disambiguation" && {
          note: "This is a disambiguation page; ask the user which meaning they want or try a more specific title.",
        }),
        attribution: "Source: Wikipedia (CC BY-SA 4.0)",
      };
    } catch (err) {
      if (err instanceof NotFoundError) {
        return { found: false, message: `No Wikipedia article found for "${input.title}".` };
      }
      throw err;
    }
  },
});
