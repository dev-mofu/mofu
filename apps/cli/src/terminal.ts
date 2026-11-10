import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";

/** Line input that can be shared between the chat prompt and approval questions. */
export class Terminal {
  readonly rl: Interface;
  readonly interactive: boolean;

  constructor() {
    this.interactive = Boolean(process.stdin.isTTY);
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: this.interactive,
    });
  }

  /**
   * Resolves null when input ends (Ctrl+D / closed stdin). Prompts must be a
   * single line: readline redraws a prompt by moving the cursor up by the rows
   * it last drew, which erases our own output when the prompt spans lines.
   */
  async ask(prompt: string): Promise<string | null> {
    this.forgetLastRender();
    try {
      return await this.rl.question(prompt);
    } catch {
      return null;
    } finally {
      this.forgetLastRender();
    }
  }

  /**
   * We print output between questions that readline doesn't know about, so its
   * memory of how many rows the previous input took is stale. Left alone, the
   * next prompt moves the cursor up by that many rows and clears our lines.
   */
  private forgetLastRender(): void {
    (this.rl as unknown as { prevRows?: number }).prevRows = 0;
  }

  /**
   * Yields user input lines until input ends. Piped input arrives all at once,
   * and readline drops lines that arrive while no question is pending, so
   * non-interactive input is read through the buffered line iterator instead.
   */
  async *lines(prompt: string, beforePrompt?: () => void): AsyncGenerator<string> {
    if (!this.interactive) {
      for await (const line of this.rl) yield line;
      return;
    }
    for (;;) {
      beforePrompt?.();
      const line = await this.ask(prompt);
      if (line === null) return;
      yield line;
    }
  }

  /** y/n question. Non-interactive sessions always answer no. */
  async confirm(prompt: string): Promise<boolean> {
    if (!this.interactive) return false;
    for (;;) {
      const answer = await this.ask(prompt);
      if (answer === null) return false;
      const a = answer.trim().toLowerCase();
      if (a === "y" || a === "yes") return true;
      if (a === "n" || a === "no" || a === "") return false;
    }
  }

  close(): void {
    this.rl.close();
  }
}

/** Reads a line without echoing it (for API keys). */
export async function askHidden(prompt: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const rl = createInterface({
    input: process.stdin,
    output,
    terminal: Boolean(process.stdin.isTTY),
  });
  try {
    const answer = rl.question(prompt);
    muted = true;
    return (await answer).trim();
  } finally {
    muted = false;
    rl.close();
    process.stdout.write("\n");
  }
}
