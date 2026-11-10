#!/usr/bin/env node
import { createRequire } from "node:module";
import pc from "picocolors";
import { FileMemoryStore, REPOPILOT_TASK_SECTION } from "@mofu/core";
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
) {
  const [cmd, ...args] = input.slice(1).trim().split(/\s+/);
  switch (cmd) {
    case "help":
      printer.line(SLASH_HELP);
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
  const apiKey = resolveApiKey(process.env, config);
  if (!apiKey) {
    console.error("No OpenRouter API key. Run `mofu auth` or set OPENROUTER_API_KEY.");
    return 1;
  }

  const printer = new Printer();
  const terminal = new Terminal();
  const memory = new FileMemoryStore(memoryPath());
  const session = new ChatSession({
    apiKey,
    model: resolveModel(args.model, process.env, config),
    workspaceRoot: process.cwd(),
    memory,
    terminal,
    printer,
    // Coding tasks need room for edits, test runs and fixes in one turn.
    limits: { maxSteps: args.task ? 40 : 20 },
    ...(args.task && { modeSection: REPOPILOT_TASK_SECTION }),
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
    if (args.prompt) return (await session.send(args.prompt)) ? 0 : 1;

    printer.line(
      `${pc.bold(pc.magenta("mofu"))} ${pc.dim(`· ${session.model} · ${process.cwd()}`)}`,
    );
    printer.line(
      pc.dim("Ask anything, or type /help. Mofu asks before changing files or running commands."),
    );
    if (args.initialPrompt) {
      printer.line();
      printer.line(`${pc.magenta("›")} ${args.initialPrompt}`);
      await session.send(args.initialPrompt);
    }
    // The blank line is printed separately: prompts must stay single-line (see Terminal.ask).
    for await (const input of terminal.lines(`${pc.magenta("›")} `, () => printer.line())) {
      const text = input.trim();
      if (!text) continue;
      if (text.startsWith("/")) {
        if (!(await handleSlash(text, session, memory, printer))) break;
        continue;
      }
      await session.send(text);
    }
    return 0;
  } finally {
    terminal.close();
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
