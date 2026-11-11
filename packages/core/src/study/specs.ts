import { z } from "zod";
import { CreateFlashcardsInput, CreateQuizInput } from "./cards.js";

/**
 * Study tools that act on the loaded document or show interactive views.
 * On the web the browser runs them (it holds the document); in the CLI they
 * run in-process. The server only declares them.
 */

export const ReadDocumentInput = z.object({
  parts: z.string().max(100).describe("Pages or sections to read, e.g. '3', '1-4' or '2,5-7'."),
});

export interface StudyToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodType;
}

export const STUDY_TOOL_SPECS: StudyToolSpec[] = [
  {
    name: "read_document",
    description:
      "Read pages (PDF) or sections (text, web pages) of the user's document. The text is labeled like [page 4] so you can cite it. " +
      "Read only what the request needs; at most about 14,000 characters per call.",
    inputSchema: ReadDocumentInput,
  },
  {
    name: "create_flashcards",
    description:
      "Show the user an interactive flashcard deck. Every card needs a source like 'page 4'. Base cards only on text you read with read_document.",
    inputSchema: CreateFlashcardsInput,
  },
  {
    name: "create_quiz",
    description:
      "Show the user an interactive quiz. Multiple-choice questions are graded automatically and their choices are shuffled before display, so never refer to answers by letter; short-answer questions include a model answer you'll grade against when the user replies. Every question needs a source.",
    inputSchema: CreateQuizInput,
  },
];

export const STUDY_TOOL_NAMES = new Set(STUDY_TOOL_SPECS.map((s) => s.name));
