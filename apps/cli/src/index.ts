#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import pc from "picocolors";
import {
  DEPS_FIX_SECTION,
  FileMemoryStore,
  REPOPILOT_TASK_SECTION,
  FIX_SECTION,
  DOCS_SECTION,
  DEFAULT_LOCAL_URL,
  type ScanReport,
} from "@mofu/core";
import { fixPrompt, printScanReport, scanCurrentDirectory, summarizeScan } from "./deps.js";
import { startAnalysis } from "./analyze.js";
import { runChain, runWebhook } from "./chain.js";
import { runAudit, runCi, runCommit, runPr, runReview, runSecrets } from "./builder.js";
import { startStudy, STUDY_SLASH_HELP, type StudySession } from "./study.js";
import { prepareApi } from "./api.js";
import { ArgsError, extractTarget, HELP, isChainArgs, parseArgs } from "./args.js";
import { pickLocalModel, setModelTarget } from "./target.js";
import { runLaunchKit } from "./launchkit.js";
import {
  loadConfig,
  memoryPath,
  resolveApiKey,
  resolveModel,
  saveConfig,
  configPath,
} from "./config.js";
import { ChatSession } from "./session.js";
import { askHidden, Terminal } from "./terminal.js";
import { Printer } from "./ui.js";

const SLASH_HELP = `Commands:
  /help         Show this help
  /model [id]   Show or switch the model for this session
  /clear        Start a fresh conversation
  /memory       Show what Mofu remembers
  /forget       Clear Mofu's memory
  /exit         Quit (Ctrl+C also stops a running reply)`;

function version(): string {
  const require = createRequire(import.meta.url);
  try {
    return (require("../package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
}

async function runAuth(): Promise<void> {
  console.log("Paste your OpenRouter API key (get one at https://openrouter.ai/keys).");
  const key = await askHidden("API key: ");
  if (!key) {
    console.log("No key entered; nothing saved.");
    return;
  }
  if (!key.startsWith("sk-or-")) {
    console.log(
      pc.yellow(
        "That doesn't look like an OpenRouter key (they start with sk-or-). Saving anyway.",
      ),
    );
  }
  await saveConfig({ apiKey: key });
  console.log(pc.green(`Saved to ${configPath()}`));
}

/** Handles a slash command. Returns false when the user wants to quit. */
async function handleSlash(
  input: string,
  session: ChatSession,
  memory: FileMemoryStore,
  printer: Printer,
  study: StudySession | null,
) {
  const [cmd, ...args] = input.slice(1).trim().split(/\s+/);
  switch (cmd) {
    case "help":
      printer.line(SLASH_HELP);
      if (study) printer.line(STUDY_SLASH_HELP);
      break;
    case "model":
      if (args[0]) {
        session.model = args[0];
        printer.line(`Model for this session: ${pc.bold(session.model)}`);
      } else {
        printer.line(`Current model: ${pc.bold(session.model)}`);
      }
      break;
    case "clear":
      session.clear();
      printer.line(pc.dim("Conversation cleared."));
      break;
    case "memory": {
      const text = await memory.load();
      printer.line(text || pc.dim("Nothing saved yet. Ask Mofu to remember something."));
      break;
    }
    case "forget":
      await memory.clear();
      printer.line(pc.dim("Memory cleared."));
      break;
    case "exit":
    case "quit":
      return false;
    default:
      printer.line(`Unknown command /${cmd}. Type /help.`);
  }
  return true;
}

async function main(): Promise<number> {
  const target = extractTarget(process.argv.slice(2));
  const args = parseArgs(target.argv);
  if (args.command === "help") {
    console.log(HELP);
    return 0;
  }
  if (args.command === "version") {
    console.log(version());
    return 0;
  }
  if (args.command === "auth") {
    await runAuth();
    return 0;
  }
  // Robinhood Chain checks go through mofu.works: no key, no model.
  if (isChainArgs(args)) return runChain(args, new Printer(), version());
  if (args.command === "webhook") return runWebhook(args, new Printer(), version());
  // Builder checks are plain code: no key, no model.
  if (args.command === "secrets") return runSecrets(args, new Printer());
  if (args.command === "audit") return runAudit(args, new Printer());
  if (args.command === "ci") return runCi(args, new Printer());
  if (args.command === "launch-kit") return runLaunchKit(args, new Printer());

  const config = await loadConfig();
  const printer = new Printer();

  // `mofu deps --json` is fully deterministic: no key, no model.
  let depsReport: ScanReport | null = null;
  if (args.command === "deps") {
    depsReport = await scanCurrentDirectory(printer, args.json);
    if (!depsReport) return 1;
    if (args.json) {
      console.log(JSON.stringify(depsReport, null, 2));
      return 0;
    }
    printScanReport(depsReport, printer);
    if (depsReport.findings.length === 0) return 0;
  }

  // A local or other OpenAI-compatible server instead of OpenRouter: --local, --base-url, MOFU_BASE_URL.
  const baseURL =
    target.baseUrl ??
    (target.local ? (process.env.MOFU_BASE_URL ?? DEFAULT_LOCAL_URL) : process.env.MOFU_BASE_URL);
  let apiKey: string;
  let model: string;
  if (baseURL) {
    setModelTarget(baseURL);
    // Never send the saved OpenRouter key to another server.
    apiKey = process.env.MOFU_LOCAL_API_KEY ?? "local";
    const picked = await pickLocalModel(baseURL, args.model ?? process.env.MOFU_LOCAL_MODEL);
    if ("error" in picked) {
      console.error(picked.error);
      return 1;
    }
    model = picked.model;
    printer.line(pc.dim(`Local model ${model} at ${baseURL}. Nothing goes to OpenRouter.`));
  } else {
    const key = resolveApiKey(process.env, config);
    if (!key) {
      console.error(
        "No OpenRouter API key. Run `mofu auth`, set OPENROUTER_API_KEY, or use a local model with `mofu --local`.",
      );
      return 1;
    }
    apiKey = key;
    model = resolveModel(args.model, process.env, config);
  }
  if (args.command === "review") return runReview(args, printer, apiKey, model);
  if (args.command === "commit") return runCommit(args, printer, apiKey, model);
  if (args.command === "pr") return runPr(args, printer, apiKey, model);

  if (args.command === "deps" && depsReport && !args.fix) {
    return (await summarizeScan(depsReport, { apiKey, model, printer })) ? 0 : 1;
  }

  // mofu analyze: load the file into a Python sandbox before the chat starts.
  const analysis =
    args.command === "chat" && args.analyze ? await startAnalysis(args.analyze, printer) : null;
  if (args.command === "chat" && args.analyze && !analysis) return 1;

  // mofu study: read the document before the chat starts.
  const study =
    args.command === "chat" && args.study
      ? await startStudy(args.study, args.pages, printer)
      : null;
  if (args.command === "chat" && args.study && !study) return 1;

  // mofu api: load (and for diff, compare) specs before any model call.
  const api = args.command === "api" ? await prepareApi(args, printer) : null;
  if (args.command === "api" && !api) return 1;

  // mofu fix --log: the failure output goes into the first message (its end, where errors are).
  let initialPrompt = args.command === "chat" ? args.initialPrompt : undefined;
  if (args.command === "chat" && args.fixLog) {
    const log = await readFile(args.fixLog, "utf8").catch(() => null);
    if (log === null) {
      printer.error(`Couldn't read ${args.fixLog}.`);
      return 1;
    }
    const tail = log.length > 20_000 ? `…\n${log.slice(-20_000)}` : log;
    initialPrompt = `${initialPrompt ?? ""}\n\nFailure output (${args.fixLog}):\n\`\`\`\n${tail}\n\`\`\``;
  }

  // Chat, task, fix, analyze, study, api and deps --fix all run through a session.
  const chat =
    args.command === "api"
      ? { modeSection: api!.modeSection, maxSteps: api!.maxSteps }
      : args.command === "deps"
        ? { initialPrompt: fixPrompt(depsReport!), modeSection: DEPS_FIX_SECTION, maxSteps: 40 }
        : analysis
          ? { modeSection: analysis.modeSection, maxSteps: 30 }
          : study
            ? { modeSection: study.modeSection, maxSteps: 20 }
            : {
                prompt: args.prompt,
                initialPrompt,
                // Coding tasks need room for edits, test runs and fixes in one turn.
                modeSection: args.docs
                  ? DOCS_SECTION
                  : args.fix
                    ? FIX_SECTION
                    : args.task
                      ? REPOPILOT_TASK_SECTION
                      : undefined,
                maxSteps: args.task || args.fix || args.docs ? 40 : 20,
              };

  const terminal = new Terminal();
  const memory = new FileMemoryStore(memoryPath());
  const session = new ChatSession({
    apiKey,
    model,
    workspaceRoot: process.cwd(),
    memory,
    terminal,
    printer,
    limits: { maxSteps: chat.maxSteps },
    ...(chat.modeSection && { modeSection: chat.modeSection }),
    ...(analysis && { extraTools: analysis.tools, approveAllOffer: ["run_python"] }),
    ...(study && { extraTools: study.tools }),
    ...(api && { extraTools: api.tools }),
  });

  // Ctrl+C stops a running reply; at the prompt it closes input, which ends the loop below.
  terminal.rl.on("SIGINT", () => {
    if (session.busy) session.abort();
    else {
      printer.line();
      terminal.close();
    }
  });

  try {
    if ("prompt" in chat && chat.prompt) return (await session.send(chat.prompt)) ? 0 : 1;
    if (api) {
      const outcome = await api.run({ session, terminal, apiKey, model });
      if (outcome !== "chat") return outcome;
    }

    printer.line(
      `${pc.bold(pc.magenta("mofu"))} ${pc.dim(`· ${session.model} · ${process.cwd()}`)}`,
    );
    printer.line(
      pc.dim("Ask anything, or type /help. Mofu asks before changing files or running commands."),
    );
    if (chat.initialPrompt) {
      printer.line();
      // The deps --fix prompt carries the whole report; show just its first line.
      printer.line(`${pc.magenta("›")} ${chat.initialPrompt.split("\n")[0]}`);
      await sendStudyAware(session, chat.initialPrompt, study, terminal);
    }
    // The blank line is printed separately: prompts must stay single-line (see Terminal.ask).
    for await (const input of terminal.lines(`${pc.magenta("›")} `, () => printer.line())) {
      const text = input.trim();
      if (!text) continue;
      let message = text;
      if (text.startsWith("/")) {
        const [cmd = "", ...rest] = text.slice(1).trim().split(/\s+/);
        const handled = study ? await study.slash(cmd, rest, terminal) : false;
        if (handled === true) continue;
        if (handled === false) {
          if (!(await handleSlash(text, session, memory, printer, study))) break;
          continue;
        }
        message = handled;
        printer.line(pc.dim(message));
      }
      await sendStudyAware(session, message, study, terminal);
    }
    return 0;
  } finally {
    terminal.close();
    await analysis?.sandbox.close();
  }
}

/** Sends a message; in study mode, runs any quiz Mofu made and sends the written answers back for grading. */
async function sendStudyAware(
  session: ChatSession,
  text: string,
  study: StudySession | null,
  terminal: Terminal,
): Promise<void> {
  let next: string | null = text;
  while (next) {
    if (!(await session.send(next)) || !study) return;
    next = await study.afterTurn(terminal);
  }
}

// Set exitCode instead of calling process.exit(): exiting while fetch sockets
// are closing trips a libuv assertion on Windows.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof ArgsError) console.error(err.message);
    else
      console.error(
        pc.red(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`),
      );
    process.exitCode = 1;
  },
);
