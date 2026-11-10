import type { Surface } from "../tools/types.js";
import { memoryForPrompt } from "../memory.js";

export interface SystemPromptOptions {
  surface: Surface;
  /** Facts the user asked Mofu to remember. */
  memory?: string;
  /** CLI only: the directory Mofu works in. */
  workspaceRoot?: string;
  /** CLI only: e.g. "Windows PowerShell". */
  shell?: string;
  /** CLI only: e.g. "win32". */
  platform?: string;
  /** Mode-specific instructions added by later phases. */
  modeSection?: string;
  now?: Date;
}

const CORE = `You are Mofu, an AI agent that does real work on the files and tasks people give you. You are not a general chatbot: aim for a concrete, usable result (an answer, an edit, a report) and get there efficiently.

How you work:
- Use tools to look things up instead of guessing. Read a file before you edit it.
- Facts that tools are responsible for (file contents, command output, versions, numbers, IDs, citations) must come from tool results in this conversation. Never invent them. If you don't know, say so or look it up.
- Keep tool use focused. Don't read whole directories when a search or a single file will do.
- When a tool returns an error, read it, adjust, and try a different approach. Don't repeat the same failing call.

Writing:
- Reply in English by default. If the user writes in another language, reply in that language.
- Be concise and direct. Lead with the result. Use short paragraphs, lists or code blocks when they make the answer easier to use.
- When you use Wikipedia content, credit it with the article URL.`;

const CLI = `Working on the user's computer:
- File and command tools work inside the workspace directory only.
- Every file change and every command needs the user's approval, which the app asks for automatically. Just call the tool; don't ask for permission in text first.
- If the user declines an action, don't retry it. Ask what they'd like instead.
- Prefer edit_file for changes to existing files; use write_file for new files or full rewrites.
- After making changes, briefly say what you changed. Run relevant tests or builds when it makes sense.`;

/** Builds the system instructions for a turn. */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const parts = [CORE];
  if (opts.surface === "cli") {
    parts.push(CLI);
    const env = [
      opts.workspaceRoot && `- Workspace: ${opts.workspaceRoot}`,
      opts.platform && `- Platform: ${opts.platform}`,
      opts.shell &&
        `- Commands run in ${opts.shell}${opts.shell.includes("PowerShell") ? " (Windows PowerShell 5.1: use ';' instead of '&&' to chain commands)" : ""}`,
      `- Today's date: ${(opts.now ?? new Date()).toISOString().slice(0, 10)}`,
    ].filter(Boolean);
    parts.push(`Environment:\n${env.join("\n")}`);
  }
  if (opts.modeSection) parts.push(opts.modeSection);
  const memory = opts.memory?.trim();
  if (memory) {
    parts.push(
      `What the user asked you to remember (from earlier sessions):\n${memoryForPrompt(memory)}\n\nUse save_memory only when the user asks you to remember something new.`,
    );
  } else {
    parts.push("Use save_memory only when the user asks you to remember something.");
  }
  return parts.join("\n\n");
}
