/**
 * `mofu review`: an AI code review of a diff. The model sees the diff (and nothing it can run);
 * its findings are checked against the diff before anyone sees them, so a comment can only land
 * on a line that actually changed.
 */
import { generateText, type LanguageModel } from "ai";
import { z } from "zod";

export const MAX_REVIEW_DIFF_CHARS = 120_000;

export interface DiffFile {
  path: string;
  /** New-side line numbers that are in the diff (added or context lines). */
  lines: Set<number>;
  /** Lines added by the change. */
  added: Set<number>;
}

/** Parses a unified diff (git diff / gh pr diff) into the lines a review comment may point at. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let line = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) {
      const p = l.startsWith("+++ b/") ? l.slice(6) : null;
      cur = p ? { path: p.trim(), lines: new Set(), added: new Set() } : null;
      if (cur) files.push(cur);
    } else if (l.startsWith("@@")) {
      const m = /\+(\d+)/.exec(l);
      line = m ? Number(m[1]) : 0;
    } else if (
      !cur ||
      l.startsWith("diff --git") ||
      l.startsWith("--- ") ||
      l.startsWith("index ")
    ) {
      continue;
    } else if (l.startsWith("+")) {
      cur.lines.add(line);
      cur.added.add(line);
      line++;
    } else if (l.startsWith(" ")) {
      cur.lines.add(line);
      line++;
    }
  }
  return files;
}

const Finding = z.object({
  file: z.string(),
  line: z.number().int().positive().nullable().optional(),
  severity: z.enum(["bug", "security", "performance", "simplify", "nit"]),
  title: z.string().max(200),
  body: z.string().max(3000),
  suggestion: z.string().max(3000).nullable().optional(),
});
const ReviewSchema = z.object({
  summary: z.string().max(2000),
  findings: z.array(Finding).max(40),
});

export type ReviewFinding = z.infer<typeof Finding> & {
  /** False when the line isn't part of the diff: it goes in the summary, not on a line. */
  onDiff: boolean;
};

export interface Review {
  summary: string;
  findings: ReviewFinding[];
  /** Findings dropped because the file isn't in the diff at all. */
  dropped: number;
  truncated: boolean;
}

export const REVIEW_SYSTEM = `You are Mofu, reviewing a code change like a careful senior engineer.

Report only what matters, most important first:
- bug: wrong behavior, crashes, off-by-one, broken edge cases, wrong error handling.
- security: injection, secrets in code, missing auth or validation, unsafe crypto, reentrancy and access control in smart contracts.
- performance: real hot-path waste, not micro-tweaks.
- simplify: clearly simpler code that does the same thing.
- nit: only if there's almost nothing else.

Rules:
- Point at the changed code: "line" is a line number on the NEW side of the diff (the + side).
- Every finding must be specific: what goes wrong, with which input, and how to fix it. No generic advice ("add tests", "consider documenting").
- If you're not sure something is wrong, leave it out. An empty findings list is a fine answer.
- "suggestion" is optional replacement code for that line or block, only when it's short and certain.

Answer with JSON only, no prose around it:
{"summary": "<2-4 sentences on what the change does and its overall risk>", "findings": [{"file": "<path>", "line": <number or null>, "severity": "bug|security|performance|simplify|nit", "title": "<short>", "body": "<what and why>", "suggestion": "<code or null>"}]}`;

/** The user message for the model: the change, capped in size. */
export function reviewPrompt(diff: string, context: { title?: string; description?: string } = {}) {
  const truncated = diff.length > MAX_REVIEW_DIFF_CHARS;
  const body = truncated ? `${diff.slice(0, MAX_REVIEW_DIFF_CHARS)}\n… (diff truncated)` : diff;
  const head = [
    context.title ? `Pull request: ${context.title}` : null,
    context.description ? `Description:\n${context.description.slice(0, 4000)}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { text: `${head ? `${head}\n\n` : ""}Diff:\n\`\`\`diff\n${body}\n\`\`\``, truncated };
}

/** Pulls the JSON object out of a model answer (bare, or in a code fence). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fenced ? fenced[1]! : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the answer");
  return JSON.parse(raw.slice(start, end + 1));
}

/** Checks a model answer against the diff. Throws when the answer isn't usable at all. */
export function validateReview(answer: unknown, files: DiffFile[], truncated = false): Review {
  const parsed = ReviewSchema.parse(answer);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const findings: ReviewFinding[] = [];
  let dropped = 0;
  for (const f of parsed.findings) {
    const file = byPath.get(f.file.replace(/^[ab]\//, ""));
    if (!file) {
      dropped++;
      continue;
    }
    findings.push({ ...f, file: file.path, onDiff: !!f.line && file.lines.has(f.line) });
  }
  const order = { security: 0, bug: 1, performance: 2, simplify: 3, nit: 4 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { summary: parsed.summary, findings, dropped, truncated };
}

/** Runs the review: one model call, then validation against the diff. */
export async function reviewDiff(
  model: LanguageModel,
  diff: string,
  context: { title?: string; description?: string; signal?: AbortSignal } = {},
): Promise<Review & { usage: { inputTokens: number; outputTokens: number } }> {
  const files = parseDiff(diff);
  const { text: prompt, truncated } = reviewPrompt(diff, context);
  const res = await generateText({
    model,
    system: REVIEW_SYSTEM,
    prompt,
    maxOutputTokens: 6000,
    ...(context.signal && { abortSignal: context.signal }),
  });
  const review = validateReview(extractJson(res.text), files, truncated);
  return {
    ...review,
    usage: { inputTokens: res.usage.inputTokens ?? 0, outputTokens: res.usage.outputTokens ?? 0 },
  };
}

/** The GitHub "create review" payload: line comments for findings on the diff, the rest in the body. */
export function githubReviewPayload(review: Review, commitId: string) {
  const icon = {
    security: "Security",
    bug: "Bug",
    performance: "Performance",
    simplify: "Simplify",
    nit: "Nit",
  };
  const text = (f: ReviewFinding) =>
    `**${icon[f.severity]}: ${f.title}**\n\n${f.body}${f.suggestion ? `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\`` : ""}`;
  const inline = review.findings.filter((f) => f.onDiff);
  const general = review.findings.filter((f) => !f.onDiff);
  const body = [
    "<!-- mofu-review -->",
    `**Mofu review**: ${review.summary}`,
    general.length
      ? `\n${general.map((f) => `- ${f.file}${f.line ? `:${f.line}` : ""} ${text(f).replace(/\n\n/g, " ")}`).join("\n")}`
      : "",
    review.findings.length === 0 ? "\nNo issues found in this change." : "",
    review.truncated ? "\n_The diff was too long; only the first part was reviewed._" : "",
    "\n<sub>AI review by [Mofu](https://mofu.works). Check before you act on it.</sub>",
  ].join("\n");
  return {
    commit_id: commitId,
    event: "COMMENT",
    body,
    comments: inline.map((f) => ({ path: f.file, line: f.line!, side: "RIGHT", body: text(f) })),
  };
}
