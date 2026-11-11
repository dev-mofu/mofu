export type ChatArgs = {
  command: "chat";
  model?: string;
  /** One-shot: run this turn and exit. */
  prompt?: string;
  /** Interactive: send this first, then keep chatting. */
  initialPrompt?: string;
  /** RepoPilot task mode (plan first, branch, tests, commit). */
  task?: boolean;
  /** Data Analyst: the file to load into the Python sandbox. */
  analyze?: string;
  /** Study Buddy: a PDF, text file or URL, with an optional page range. */
  study?: string;
  pages?: string;
};

export type DepsArgs = { command: "deps"; model?: string; json: boolean; fix: boolean };

export type ApiArgs = {
  command: "api";
  model?: string;
  sub: "docs" | "tests" | "test" | "diff";
  spec: string;
  /** diff: the new version. */
  spec2?: string;
  baseUrl?: string;
  suite?: string;
  authHeader?: string;
  concurrency?: number;
  timeoutMs?: number;
  /** Skip the confirmation before sending requests. */
  yes?: boolean;
};

export type ParsedArgs =
  | { command: "help" }
  | { command: "version" }
  | { command: "auth" }
  | DepsArgs
  | ApiArgs
  | ChatArgs;

const API_USAGE =
  "Usage: mofu api docs <spec> | mofu api tests <spec> | mofu api test <spec> --base-url <url> | mofu api diff <old> <new>";

function parseApiArgs(words: string[], withModel: { model?: string }): ApiArgs {
  const [sub, ...rest] = words;
  if (sub !== "docs" && sub !== "tests" && sub !== "test" && sub !== "diff")
    throw new ArgsError(API_USAGE);
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let yes = false;
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!;
    if (w === "--yes" || w === "-y") {
      yes = true;
      continue;
    }
    if (!w.startsWith("--")) {
      positional.push(w);
      continue;
    }
    const [name, inline] = w.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (!["base-url", "suite", "auth-header", "concurrency", "timeout"].includes(name)) {
      throw new ArgsError(`Unknown option --${name}. ${API_USAGE}`);
    }
    const value = inline ?? rest[++i];
    if (value === undefined) throw new ArgsError(`--${name} needs a value.`);
    flags[name] = value;
  }
  const wanted = sub === "diff" ? 2 : 1;
  if (positional.length !== wanted) throw new ArgsError(API_USAGE);
  if (sub === "test" && !flags["base-url"])
    throw new ArgsError("mofu api test needs --base-url, e.g. --base-url http://localhost:3000");
  if (sub !== "test" && Object.keys(flags).length)
    throw new ArgsError(`Those options only apply to mofu api test. ${API_USAGE}`);
  if (flags["base-url"] && !/^https?:\/\/[^/]/i.test(flags["base-url"]))
    throw new ArgsError("--base-url must start with http:// or https://");
  const num = (name: string, min: number, max: number) => {
    if (flags[name] === undefined) return undefined;
    const n = Number(flags[name]);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new ArgsError(`--${name} must be a whole number from ${min} to ${max}.`);
    return n;
  };
  const concurrency = num("concurrency", 1, 16);
  const timeoutMs = num("timeout", 100, 120_000);
  return {
    command: "api",
    ...withModel,
    sub,
    spec: positional[0]!,
    ...(positional[1] && { spec2: positional[1] }),
    ...(flags["base-url"] && { baseUrl: flags["base-url"] }),
    ...(flags.suite && { suite: flags.suite }),
    ...(flags["auth-header"] && { authHeader: flags["auth-header"] }),
    ...(concurrency && { concurrency }),
    ...(timeoutMs && { timeoutMs }),
    ...(yes && { yes }),
  };
}

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
  if (first === "api") return parseApiArgs(others, withModel);
  if (first === "deps") {
    const unknown = others.filter((o) => o !== "--json" && o !== "--fix");
    if (unknown.length)
      throw new ArgsError(`mofu deps takes --json or --fix, not: ${unknown.join(" ")}`);
    if (others.includes("--json") && others.includes("--fix")) {
      throw new ArgsError("Use either --json or --fix, not both.");
    }
    return {
      command: "deps",
      ...withModel,
      json: others.includes("--json"),
      fix: others.includes("--fix"),
    };
  }
  if (first === "explain" && others.length === 0) {
    return { command: "chat", ...withModel, initialPrompt: EXPLAIN_PROMPT };
  }
  if (first === "task") {
    if (!tail)
      throw new ArgsError('mofu task needs an instruction, e.g. mofu task "add a --verbose flag"');
    return { command: "chat", ...withModel, task: true, initialPrompt: tail };
  }
  if (first === "analyze") {
    if (!tail)
      throw new ArgsError(
        "mofu analyze needs a CSV, Excel or JSON file, e.g. mofu analyze sales.csv",
      );
    return { command: "chat", ...withModel, analyze: tail };
  }
  if (first === "study") {
    const words = [...others];
    let pages: string | undefined;
    const at = words.findIndex((w) => w === "--pages" || w.startsWith("--pages="));
    if (at >= 0) {
      const w = words[at]!;
      pages = w.includes("=") ? w.slice("--pages=".length) : words[at + 1];
      words.splice(at, w.includes("=") ? 1 : 2);
      if (!pages) throw new ArgsError("--pages needs a range, e.g. --pages 10-40");
    }
    const target = words.join(" ").trim();
    if (!target)
      throw new ArgsError("mofu study needs a PDF, text file or link, e.g. mofu study notes.pdf");
    return { command: "chat", ...withModel, study: target, ...(pages && { pages }) };
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
  mofu analyze <file>         Analyze a CSV, Excel or JSON file with Python (charts in ./mofu-output)
  mofu study <file-or-url>    Study a PDF, text/Markdown file or article: summaries, flashcards, quizzes
    [--pages 10-40]           Which PDF pages to load (up to 300 at a time)
  mofu api docs <spec>        Markdown docs from an OpenAPI/Swagger spec (file or URL)
  mofu api tests <spec>       Generate test cases (JSON, a Vitest file and an .http file)
  mofu api test <spec> --base-url <url>
                              Run the test cases against a server and report
    [--suite file] [--auth-header "Name: value"] [--concurrency 4] [--timeout 10000] [--yes]
  mofu api diff <old> <new>   Breaking changes between two versions of a spec
  mofu deps                   Scan dependencies for vulnerabilities and outdated packages
  mofu deps --json            Print the raw scan report as JSON (no AI involved)
  mofu deps --fix             Pick upgrades to apply on a branch, run tests, commit
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
