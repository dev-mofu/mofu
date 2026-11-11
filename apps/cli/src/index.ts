#!/usr/bin/env node
import { createRequire } from "node:module";
import pc from "picocolors";
import {
  DEPS_FIX_SECTION,
  FileMemoryStore,
  REPOPILOT_TASK_SECTION,
  type ScanReport,
} from "@mofu/core";
import { fixPrompt, printScanReport, scanCurrentDirectory, summarizeScan } from "./deps.js";
import { startAnalysis } from "./analyze.js";
import { startStudy, STUDY_SLASH_HELP, type StudySession } from "./study.js";
import { ArgsError, HELP, parseArgs } from "./args.js";
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
  const args = parseArgs(process.argv.slice(2));
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

  const apiKey = resolveApiKey(process.env, config);
  if (!apiKey) {
    console.error("No OpenRouter API key. Run `mofu auth` or set OPENROUTER_API_KEY.");
    return 1;
  }
  const model = resolveModel(args.model, process.env, config);

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

  // Chat, task, analyze and deps --fix all run as an interactive session.
  const chat =
    args.command === "deps"
      ? { initialPrompt: fixPrompt(depsReport!), modeSection: DEPS_FIX_SECTION, maxSteps: 40 }
      : analysis
        ? { modeSection: analysis.modeSection, maxSteps: 30 }
        : study
          ? { modeSection: study.modeSection, maxSteps: 20 }
          : {
              prompt: args.prompt,
              initialPrompt: args.initialPrompt,
              // Coding tasks need room for edits, test runs and fixes in one turn.
              modeSection: args.task ? REPOPILOT_TASK_SECTION : undefined,
              maxSteps: args.task ? 40 : 20,
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
    if (chat.prompt) return (await session.send(chat.prompt)) ? 0 : 1;

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
