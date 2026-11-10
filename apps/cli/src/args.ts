export type ChatArgs = {
  command: "chat";
  model?: string;
  /** One-shot: run this turn and exit. */
  prompt?: string;
  /** Interactive: send this first, then keep chatting. */
  initialPrompt?: string;
  /** RepoPilot task mode (plan first, branch, tests, commit). */
  task?: boolean;
};

export type ParsedArgs =
  { command: "help" } | { command: "version" } | { command: "auth" } | ChatArgs;

export class ArgsError extends Error {
  override name = "ArgsError";
}

export const EXPLAIN_PROMPT =
  "Explain this repository: what it does, how it's structured, the main entry points, how to run it " +
  "and its tests, and where a new contributor should start. Use repo_overview, then read only the few " +
  "files you need.";

export function testsPrompt(target: string): string {
  return (
    `Write unit tests for ${target}. Use the project's existing test framework and conventions ` +
    "(check repo_overview and an existing test first). Run them with run_tests and fix failures, " +
    "at most 3 attempts. Don't change the code under test unless a test reveals a real bug; ask me first."
  );
}

/** Tiny argv parser: `mofu [auth|task|explain|tests] [--model <id>] [text...]`. */
export function parseArgs(argv: string[]): ParsedArgs {
  let model: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "-h" || arg === "--help") return { command: "help" };
    if (arg === "-v" || arg === "--version") return { command: "version" };
    if (arg === "-m" || arg === "--model") {
      const value = argv[++i];
      if (!value)
        throw new ArgsError(`${arg} needs a model ID, e.g. --model anthropic/claude-haiku-5.5`);
      model = value;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
    } else if (arg.startsWith("-") && rest.length === 0) {
      throw new ArgsError(`Unknown option: ${arg}. Run mofu --help.`);
    } else {
      rest.push(arg);
    }
  }
  const withModel = model ? { model } : {};
  const [first, ...others] = rest;
  const tail = others.join(" ").trim();

  if (first === "auth" && others.length === 0) return { command: "auth" };
  if (first === "explain" && others.length === 0) {
    return { command: "chat", ...withModel, initialPrompt: EXPLAIN_PROMPT };
  }
  if (first === "task") {
    if (!tail)
      throw new ArgsError('mofu task needs an instruction, e.g. mofu task "add a --verbose flag"');
    return { command: "chat", ...withModel, task: true, initialPrompt: tail };
  }
  if (first === "tests") {
    if (!tail)
      throw new ArgsError("mofu tests needs a file or folder, e.g. mofu tests src/utils.ts");
    return { command: "chat", ...withModel, initialPrompt: testsPrompt(tail) };
  }
  const prompt = rest.join(" ").trim();
  return { command: "chat", ...withModel, ...(prompt && { prompt }) };
}

export const HELP = `mofu: an AI agent that does real work on your files

Usage:
  mofu                        Start an interactive chat in the current directory
  mofu "<question>"           Run one turn and exit
  mofu task "<instruction>"   Do a coding task: plan, branch, edit, test, commit (and PR if you want)
  mofu explain                Explain the repository in the current directory
  mofu tests <path>           Write and run unit tests for a file or folder
  mofu auth                   Save your OpenRouter API key to ~/.mofu/config.json

Options:
  -m, --model <id>            OpenRouter model ID (default from MOFU_MODEL or config)
  -h, --help                  Show this help
  -v, --version               Show the version

In chat:
  /help  /model <id>  /clear  /memory  /forget  /exit

Mofu asks before it changes a file or runs a command. In a git repository it works on its
own mofu/... branch, never commits to your default branch and never force-pushes.
Get an API key at https://openrouter.ai/keys`;
