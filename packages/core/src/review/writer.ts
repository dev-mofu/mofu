/**
 * `mofu commit` and `mofu pr`: one model call that writes the message from the diff. The CLI shows
 * it and only runs git or gh after the user says yes.
 */
import { generateText, type LanguageModel } from "ai";
import { z } from "zod";
import { extractJson } from "./index.js";

export const MAX_WRITER_DIFF_CHARS = 60_000;

const cap = (diff: string) =>
  diff.length > MAX_WRITER_DIFF_CHARS
    ? `${diff.slice(0, MAX_WRITER_DIFF_CHARS)}\n… (diff truncated)`
    : diff;

export const COMMIT_SYSTEM = `You write git commit messages from a staged diff.

- Subject: one line, at most 72 characters, imperative mood ("Add", "Fix", not "Added"), no trailing period.
- Match the style of the repository's recent subjects (shown below): if they use a "type(scope):" prefix, use one too; if they don't, don't.
- Body: optional. When the change isn't obvious from the subject, 1-4 short lines on what changed and why. Wrap at 72 characters. No bullet list of every file.
- Describe only what the diff shows. Don't claim tests were run or bugs fixed unless the diff makes that plain.

Answer with JSON only: {"subject": "...", "body": "..." }  (body may be "").`;

export const PR_SYSTEM = `You write pull request titles and descriptions from a branch's commits and diff.

- Title: at most 72 characters, plain and specific.
- Body in Markdown with these sections:
  ## Summary  (2-4 sentences: what this changes and why)
  ## Changes  (a short bullet list of the meaningful changes, not every file)
  ## How to test  (concrete steps a reviewer can follow, based on the code; if you can't tell, say what to check)
- Describe only what the diff shows. Never claim tests passed or were run.

Answer with JSON only: {"title": "...", "body": "..."}`;

const Commit = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().max(4000).default(""),
});
const PullRequest = z.object({ title: z.string().min(1).max(200), body: z.string().max(20_000) });

export type CommitMessage = z.infer<typeof Commit>;
export type PullRequestText = z.infer<typeof PullRequest>;

/** Turns a model answer into a commit message, trimming the subject to one clean line. */
export function parseCommitMessage(text: string): CommitMessage {
  const c = Commit.parse(extractJson(text));
  const subject = c.subject.split("\n")[0]!.trim().replace(/\.$/, "").slice(0, 72);
  return { subject, body: c.body.trim() };
}

export function parsePullRequest(text: string): PullRequestText {
  const p = PullRequest.parse(extractJson(text));
  return { title: p.title.split("\n")[0]!.trim().slice(0, 100), body: p.body.trim() };
}

export const commitText = (c: CommitMessage) => (c.body ? `${c.subject}\n\n${c.body}` : c.subject);

export async function writeCommitMessage(
  model: LanguageModel,
  diff: string,
  recentSubjects: string[],
): Promise<CommitMessage> {
  const res = await generateText({
    model,
    system: COMMIT_SYSTEM,
    prompt: `Recent subjects in this repository:\n${
      recentSubjects
        .slice(0, 15)
        .map((s) => `- ${s}`)
        .join("\n") || "(none yet)"
    }\n\nStaged diff:\n\`\`\`diff\n${cap(diff)}\n\`\`\``,
    maxOutputTokens: 800,
  });
  return parseCommitMessage(res.text);
}

export async function writePullRequest(
  model: LanguageModel,
  diff: string,
  commits: string[],
): Promise<PullRequestText> {
  const res = await generateText({
    model,
    system: PR_SYSTEM,
    prompt: `Commits on this branch:\n${commits.map((s) => `- ${s}`).join("\n")}\n\nDiff against the base branch:\n\`\`\`diff\n${cap(diff)}\n\`\`\``,
    maxOutputTokens: 2000,
  });
  return parsePullRequest(res.text);
}
