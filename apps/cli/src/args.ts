export type ParsedArgs =
  | { command: "help" }
  | { command: "version" }
  | { command: "auth" }
  | { command: "chat"; model?: string; prompt?: string };

export class ArgsError extends Error {
  override name = "ArgsError";
}

/** Tiny argv parser: `mofu [auth] [--model <id>] [prompt...]`. */
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
  if (rest[0] === "auth" && rest.length === 1) return { command: "auth" };
  const prompt = rest.join(" ").trim();
  return { command: "chat", ...(model && { model }), ...(prompt && { prompt }) };
}

export const HELP = `mofu: an AI agent that does real work on your files

Usage:
  mofu                    Start an interactive chat in the current directory
  mofu "<question>"       Run one turn and exit
  mofu auth               Save your OpenRouter API key to ~/.mofu/config.json

Options:
  -m, --model <id>        OpenRouter model ID (default from MOFU_MODEL or config)
  -h, --help              Show this help
  -v, --version           Show the version

In chat:
  /help  /model <id>  /clear  /memory  /forget  /exit

Mofu asks before it changes a file or runs a command.
Get an API key at https://openrouter.ai/keys`;
