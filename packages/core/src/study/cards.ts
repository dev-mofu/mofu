import { z } from "zod";

/** Flashcards and quizzes: structured, validated, graded by code where possible. */

export const FlashcardSchema = z.object({
  front: z.string().min(1).max(400).describe("Question or term."),
  back: z.string().min(1).max(1200).describe("Answer or definition."),
  source: z.string().max(40).describe("Where it comes from, e.g. 'page 4' or 'section 2'."),
  tags: z.array(z.string().max(30)).max(5).default([]),
});
export type Flashcard = z.infer<typeof FlashcardSchema>;

export const CreateFlashcardsInput = z.object({
  title: z.string().max(120).describe("Deck name, e.g. 'Chapter 3: Cell respiration'."),
  cards: z.array(FlashcardSchema).min(1).max(40),
});

const McqSchema = z.object({
  type: z.literal("multiple_choice"),
  question: z.string().min(1).max(600),
  choices: z.array(z.string().min(1).max(300)).min(2).max(6),
  answerIndex: z.number().int().min(0).describe("Index of the correct choice (0-based)."),
  explanation: z.string().max(800).describe("Why the answer is right."),
  source: z.string().max(40),
});

const ShortSchema = z.object({
  type: z.literal("short_answer"),
  question: z.string().min(1).max(600),
  answer: z.string().min(1).max(800).describe("A model answer to grade against."),
  source: z.string().max(40),
});

export const QuizQuestionSchema = z.discriminatedUnion("type", [McqSchema, ShortSchema]);
export type QuizQuestion = z.infer<typeof QuizQuestionSchema>;

export const CreateQuizInput = z
  .object({
    title: z.string().max(120),
    difficulty: z.enum(["easy", "medium", "hard"]).default("medium"),
    questions: z.array(QuizQuestionSchema).min(1).max(20),
  })
  .superRefine((quiz, ctx) => {
    quiz.questions.forEach((q, i) => {
      if (q.type === "multiple_choice" && q.answerIndex >= q.choices.length) {
        ctx.addIssue({
          code: "custom",
          path: ["questions", i, "answerIndex"],
          message: "answerIndex is past the last choice.",
        });
      }
    });
  });
export type Quiz = z.infer<typeof CreateQuizInput>;

/** Multiple-choice grading is exact; no model involved. */
export function gradeMultipleChoice(
  q: QuizQuestion,
  chosen: number,
): { correct: boolean; answer: string } {
  if (q.type !== "multiple_choice")
    throw new Error("Only multiple-choice questions are graded automatically.");
  return { correct: chosen === q.answerIndex, answer: q.choices[q.answerIndex] ?? "" };
}

/** Small seeded PRNG (mulberry32) so a quiz shuffles the same way on every render. */
function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Models tend to put the right answer in the same slot (often B), which makes
 * quizzes guessable. Shuffle every question's choices in code, deterministically per seed.
 */
export function shuffleChoices(quiz: Quiz, seed: string): Quiz {
  const random = seededRandom(seed);
  return {
    ...quiz,
    questions: quiz.questions.map((q) => {
      if (q.type !== "multiple_choice") return q;
      const order = q.choices.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      return {
        ...q,
        choices: order.map((i) => q.choices[i]!),
        answerIndex: order.indexOf(q.answerIndex),
      };
    }),
  };
}

// ---------- Leitner spaced repetition ----------

/** Days until a card in box N is due again (box 1 = every session). */
export const LEITNER_INTERVAL_DAYS = [0, 1, 3, 7, 14] as const;
export const LEITNER_BOXES = LEITNER_INTERVAL_DAYS.length;

export interface CardProgress {
  box: number; // 1..LEITNER_BOXES
  due: string; // ISO date
}

export function newProgress(now: Date): CardProgress {
  return { box: 1, due: now.toISOString() };
}

/** "Knew it" moves a card up a box; "didn't know" sends it back to box 1. */
export function review(progress: CardProgress, knewIt: boolean, now: Date): CardProgress {
  const box = knewIt ? Math.min(progress.box + 1, LEITNER_BOXES) : 1;
  const days = LEITNER_INTERVAL_DAYS[box - 1] ?? 0;
  return { box, due: new Date(now.getTime() + days * 86_400_000).toISOString() };
}

/** Cards due now, lowest box first. */
export function dueCards(progress: CardProgress[], now: Date): number[] {
  return progress
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => new Date(p.due) <= now)
    .sort((a, b) => a.p.box - b.p.box || a.i - b.i)
    .map(({ i }) => i);
}

// ---------- Anki export ----------

const ankiField = (s: string) => s.replace(/\t/g, " ").replace(/\r?\n/g, "<br>");

/** Tab-separated front, back, tags: Anki's "Import File" reads it directly. */
export function toAnkiTsv(cards: Flashcard[], deckTag?: string): string {
  const tag = (t: string) => t.trim().replace(/\s+/g, "_");
  const lines = ["#separator:tab", "#html:true", "#tags column:3"];
  for (const c of cards) {
    const tags = [...(deckTag ? [deckTag] : []), ...c.tags].map(tag).filter(Boolean).join(" ");
    lines.push(
      [ankiField(c.front), ankiField(`${c.back}<br><small>${c.source}</small>`), tags].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}
