export type ChatArgs = {
  command: "chat";
  model?: string;
  /** One-shot: run this turn and exit. */
  prompt?: string;
  /** Interactive: send this first, then keep chatting. */
  initialPrompt?: string;
  /** RepoPilot task mode (plan first, branch, tests, commit). */
  task?: boolean;
  /** mofu fix: diagnose a failing command, then fix it on a branch. */
  fix?: boolean;
  /** mofu fix --log: the file whose contents go into the first message. */
  fixLog?: string;
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

/** mofu scan <token> / mofu wallet <address>: Robinhood Chain checks through mofu.works. */
export type ChainArgs = {
  command: "scan" | "wallet";
  address: string;
  json: boolean;
  /** Exit with code 2 when the result is at least this bad. */
  failOn?: "caution" | "risky";
};

export type WebhookArgs = {
  command: "webhook";
  sub: "add" | "status" | "test" | "remove";
  json: boolean;
  url?: string;
  tokens?: string[];
  events?: string[];
  id?: string;
  secret?: string;
};

export type SecretsArgs = {
  command: "secrets";
  path?: string;
  json: boolean;
  history: boolean;
  range?: string;
};

export type AuditArgs = {
  command: "audit";
  path?: string;
  json: boolean;
  failOn?: "caution" | "risky";
};

export type ReviewArgs = {
  command: "review";
  model?: string;
  pr?: number;
  base?: string;
  comment: boolean;
  yes: boolean;
  json: boolean;
};

export type CommitArgs = { command: "commit"; model?: string; all: boolean; yes: boolean };
export type PrArgs = { command: "pr"; model?: string; base?: string; draft: boolean; yes: boolean };

export type CiArgs = {
  command: "ci";
  checks: Array<"deps" | "secrets" | "audit">;
  auditPath?: string;
  range?: string;
  format: "markdown" | "json";
  failOn: Array<"secrets" | "risky" | "deps">;
};

export type ParsedArgs =
  | { command: "help" }
  | ChainArgs
  | WebhookArgs
  | SecretsArgs
  | AuditArgs
  | ReviewArgs
  | CommitArgs
  | PrArgs
  | CiArgs
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

export const isChainArgs = (a: ParsedArgs): a is ChainArgs =>
  a.command === "scan" || a.command === "wallet";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function parseChainArgs(command: "scan" | "wallet", words: string[]): ChainArgs {
  const usage = `Usage: mofu ${command} <${command === "scan" ? "token" : "wallet"} address> [--json] [--fail-on caution|risky]`;
  let json = false;
  let failOn: ChainArgs["failOn"];
  const positional: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "--json") json = true;
    else if (w === "--fail-on" || w.startsWith("--fail-on=")) {
      const v = w.includes("=") ? w.slice("--fail-on=".length) : words[++i];
      if (v !== "caution" && v !== "risky")
        throw new ArgsError("--fail-on takes caution or risky.");
      failOn = v;
    } else if (w.startsWith("-")) throw new ArgsError(`Unknown option ${w}. ${usage}`);
    else positional.push(w);
  }
  if (positional.length !== 1) throw new ArgsError(usage);
  if (!ADDRESS.test(positional[0]!))
    throw new ArgsError("The address must be 0x followed by 40 hex characters.");
  return { command, address: positional[0]!.toLowerCase(), json, ...(failOn && { failOn }) };
}

const WEBHOOK_USAGE = `Usage:
  mofu webhook add <https-url> <token> [token…] [--events owner_changed,verdict_changed]
  mofu webhook status <id> [--secret <secret>]
  mofu webhook test <id> [--secret <secret>]
  mofu webhook remove <id> [--secret <secret>]`;

function parseWebhookArgs(words: string[]): WebhookArgs {
  const [sub, ...rest] = words;
  if (sub !== "add" && sub !== "status" && sub !== "test" && sub !== "remove")
    throw new ArgsError(WEBHOOK_USAGE);
  let json = false;
  let events: string[] | undefined;
  let secret: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!;
    const value = (name: string) => {
      const v = w.includes("=") ? w.slice(name.length + 1) : rest[++i];
      if (!v) throw new ArgsError(`${name} needs a value.`);
      return v;
    };
    if (w === "--json") json = true;
    else if (w === "--events" || w.startsWith("--events="))
      events = value("--events")
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
    else if (w === "--secret" || w.startsWith("--secret=")) secret = value("--secret");
    else if (w.startsWith("-")) throw new ArgsError(`Unknown option ${w}.\n${WEBHOOK_USAGE}`);
    else positional.push(w);
  }
  if (sub === "add") {
    const [url, ...tokens] = positional;
    if (!url || !url.toLowerCase().startsWith("https://") || tokens.length === 0)
      throw new ArgsError(WEBHOOK_USAGE);
    if (secret)
      throw new ArgsError("--secret is for status, test and remove; add creates a new one.");
    const bad = tokens.filter((t) => !ADDRESS.test(t));
    if (bad.length) throw new ArgsError(`Not a token address: ${bad.join(", ")}`);
    if (tokens.length > 10) throw new ArgsError("A webhook can watch up to 10 tokens.");
    return {
      command: "webhook",
      sub,
      json,
      url,
      tokens: tokens.map((t) => t.toLowerCase()),
      ...(events && { events }),
    };
  }
  if (positional.length !== 1 || !/^wh_[0-9a-f]{24}$/.test(positional[0]!))
    throw new ArgsError(`mofu webhook ${sub} needs a webhook id (wh_…).\n${WEBHOOK_USAGE}`);
  if (events) throw new ArgsError("--events only applies to mofu webhook add.");
  return { command: "webhook", sub, json, id: positional[0]!, ...(secret && { secret }) };
}

/** Splits words into positionals and --flag[=value] pairs, checking names against `known`. */
function splitFlags(words: string[], known: Record<string, "bool" | "value">, usage: string) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (!w.startsWith("-") || w === "-") {
      positional.push(w);
      continue;
    }
    const [rawName, inline] = w.replace(/^--?/, "").split(/=(.*)/s, 2) as [
      string,
      string | undefined,
    ];
    const name = rawName === "y" ? "yes" : rawName;
    const kind = known[name];
    if (!kind) throw new ArgsError(`Unknown option ${w}.\n${usage}`);
    if (kind === "bool") flags[name] = true;
    else {
      const v = inline ?? words[++i];
      if (!v) throw new ArgsError(`--${name} needs a value.\n${usage}`);
      flags[name] = v;
    }
  }
  return { positional, flags };
}

const SECRETS_USAGE = "Usage: mofu secrets [path] [--json] [--no-history] [--range main..HEAD]";
const AUDIT_USAGE = "Usage: mofu audit [file.sol or folder] [--json] [--fail-on caution|risky]";
const REVIEW_USAGE =
  "Usage: mofu review [--base <branch>] [--pr <number> [--comment] [--yes]] [--json]";
const CI_USAGE =
  "Usage: mofu ci [--checks deps,secrets,audit] [--audit-path contracts] [--range origin/main..HEAD] [--format markdown|json] [--fail-on secrets,risky,deps]";

function parseSecretsArgs(words: string[]): SecretsArgs {
  const { positional, flags } = splitFlags(
    words,
    { json: "bool", "no-history": "bool", range: "value" },
    SECRETS_USAGE,
  );
  if (positional.length > 1) throw new ArgsError(SECRETS_USAGE);
  return {
    command: "secrets",
    ...(positional[0] && { path: positional[0] }),
    json: !!flags.json,
    history: !flags["no-history"],
    ...(typeof flags.range === "string" && { range: flags.range }),
  };
}

function parseAuditArgs(words: string[]): AuditArgs {
  const { positional, flags } = splitFlags(
    words,
    { json: "bool", "fail-on": "value" },
    AUDIT_USAGE,
  );
  if (positional.length > 1) throw new ArgsError(AUDIT_USAGE);
  const failOn = flags["fail-on"];
  if (failOn !== undefined && failOn !== "caution" && failOn !== "risky")
    throw new ArgsError("--fail-on takes caution or risky.");
  return {
    command: "audit",
    ...(positional[0] && { path: positional[0] }),
    json: !!flags.json,
    ...(failOn && { failOn }),
  };
}

function parseReviewArgs(words: string[], withModel: { model?: string }): ReviewArgs {
  const { positional, flags } = splitFlags(
    words,
    { json: "bool", comment: "bool", yes: "bool", pr: "value", base: "value" },
    REVIEW_USAGE,
  );
  if (positional.length) throw new ArgsError(REVIEW_USAGE);
  const pr = flags.pr === undefined ? undefined : Number(String(flags.pr).replace(/^#/, ""));
  if (pr !== undefined && (!Number.isInteger(pr) || pr <= 0))
    throw new ArgsError("--pr takes a pull request number.");
  if (flags.comment && pr === undefined) throw new ArgsError("--comment needs --pr <number>.");
  if (pr !== undefined && flags.base) throw new ArgsError("Use either --pr or --base, not both.");
  return {
    command: "review",
    ...withModel,
    ...(pr !== undefined && { pr }),
    ...(typeof flags.base === "string" && { base: flags.base }),
    comment: !!flags.comment,
    yes: !!flags.yes,
    json: !!flags.json,
  };
}

const FIX_USAGE =
  'Usage: mofu fix --run "npm test" | mofu fix --log build.log | mofu fix "<paste the error>"';
const COMMIT_USAGE = "Usage: mofu commit [--all] [--yes]";
const PR_USAGE = "Usage: mofu pr [--base main] [--draft] [--yes]";

/** The first message of a mofu fix session. A --log file's contents are added by the caller. */
export function fixPrompt(o: { run?: string; log?: string; text?: string }): string {
  const fence = "```";
  return [
    "Fix this failing build or test.",
    o.run ? `Reproduce it by running: ${o.run}` : null,
    o.log ? `Failure output:\n${fence}\n${o.log}\n${fence}` : null,
    o.text ? `What the user says:\n${o.text}` : null,
    o.run
      ? `When it's fixed, run ${o.run} again to confirm.`
      : "When it's fixed, run the project's tests to confirm.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseFixArgs(words: string[], withModel: { model?: string }): ChatArgs {
  const { positional, flags } = splitFlags(words, { run: "value", log: "value" }, FIX_USAGE);
  const text = positional.join(" ").trim();
  const run = typeof flags.run === "string" ? flags.run : undefined;
  const log = typeof flags.log === "string" ? flags.log : undefined;
  if (!run && !log && !text) throw new ArgsError(FIX_USAGE);
  return {
    command: "chat",
    ...withModel,
    fix: true,
    initialPrompt: fixPrompt({ ...(run && { run }), ...(text && { text }) }),
    ...(log && { fixLog: log }),
  };
}

function parseCiArgs(words: string[]): CiArgs {
  const { positional, flags } = splitFlags(
    words,
    { checks: "value", "audit-path": "value", range: "value", format: "value", "fail-on": "value" },
    CI_USAGE,
  );
  if (positional.length) throw new ArgsError(CI_USAGE);
  const list = <T extends string>(
    v: string | true | undefined,
    allowed: readonly T[],
    fallback: T[],
    name: string,
  ): T[] => {
    if (v === undefined) return fallback;
    const items = String(v)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const bad = items.filter((i) => !allowed.includes(i as T));
    if (bad.length)
      throw new ArgsError(`--${name} takes ${allowed.join(", ")}; not ${bad.join(", ")}.`);
    return items as T[];
  };
  const format = flags.format ?? "markdown";
  if (format !== "markdown" && format !== "json")
    throw new ArgsError("--format takes markdown or json.");
  return {
    command: "ci",
    checks: list(
      flags.checks,
      ["deps", "secrets", "audit"] as const,
      ["deps", "secrets", "audit"],
      "checks",
    ),
    ...(typeof flags["audit-path"] === "string" && { auditPath: flags["audit-path"] }),
    ...(typeof flags.range === "string" && { range: flags.range }),
    format,
    failOn:
      flags["fail-on"] === "none"
        ? []
        : list(flags["fail-on"], ["secrets", "risky", "deps"] as const, ["secrets"], "fail-on"),
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
  if (first === "scan" || first === "wallet") return parseChainArgs(first, others);
  if (first === "webhook") return parseWebhookArgs(others);
  if (first === "secrets") return parseSecretsArgs(others);
  if (first === "audit") return parseAuditArgs(others);
  if (first === "review") return parseReviewArgs(others, withModel);
  if (first === "ci") return parseCiArgs(others);
  if (first === "fix") return parseFixArgs(others, withModel);
  if (first === "commit") {
    const { positional, flags } = splitFlags(others, { all: "bool", yes: "bool" }, COMMIT_USAGE);
    if (positional.length) throw new ArgsError(COMMIT_USAGE);
    return { command: "commit", ...withModel, all: !!flags.all, yes: !!flags.yes };
  }
  if (first === "pr") {
    const { positional, flags } = splitFlags(
      others,
      { base: "value", draft: "bool", yes: "bool" },
      PR_USAGE,
    );
    if (positional.length) throw new ArgsError(PR_USAGE);
    return {
      command: "pr",
      ...withModel,
      ...(typeof flags.base === "string" && { base: flags.base }),
      draft: !!flags.draft,
      yes: !!flags.yes,
    };
  }
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
  mofu fix --run "npm test"   Find why a command fails, propose the fix, then fix it on a branch
    [--log file] ["<error>"]  (or pass a log file, or paste the error)
  mofu commit [--all] [--yes] Write the commit message for your staged changes, then commit
  mofu pr [--base main] [--draft] [--yes]
                              Write the pull request title and description, push, open it (gh)
  mofu review                 AI code review of this branch's changes (one model call)
    [--base main] [--pr 12 [--comment] [--yes]] [--json]
                              --comment posts it to the GitHub PR (asks first; needs gh)
  mofu auth                   Save your OpenRouter API key to ~/.mofu/config.json

For builders (no API key needed):
  mofu secrets [path]         Find API keys, wallet private keys and seed phrases in your
    [--no-history] [--range a..b] [--json]   files and git history (exit code 2 if found)
  mofu audit [file|folder]    Check Solidity before you deploy: what Mofu's Token Scanner will
    [--fail-on caution|risky] [--json]       say, plus common bug patterns
  mofu ci                     Dependencies + secrets + contracts in one Markdown report, for CI
    [--checks deps,secrets,audit] [--fail-on secrets,risky,deps|none] [--format json]

Robinhood Chain (no API key needed; uses mofu.works):
  mofu scan <token>           Token Scanner: what the contract allows, sell test, copycats
  mofu wallet <address>       Wallet Health: every approval (risky ones flagged) and holdings
    [--json]                  Print the raw report as JSON
    [--fail-on caution|risky] Exit with code 2 when the result is at least that bad
  mofu webhook add <url> <token…> [--events a,b]
                              Get a signed POST when a token's owner, supply, code, pause,
                              liquidity or verdict changes
  mofu webhook status|test|remove <id> [--secret s]

Options:
  -m, --model <id>            OpenRouter model ID (default from MOFU_MODEL or config)
  -h, --help                  Show this help
  -v, --version               Show the version

In chat:
  /help  /model <id>  /clear  /memory  /forget  /exit

Mofu asks before it changes a file or runs a command. In a git repository it works on its
own mofu/... branch, never commits to your default branch and never force-pushes.
Get an API key at https://openrouter.ai/keys`;
