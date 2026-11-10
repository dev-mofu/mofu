import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

/** Short facts the user asked Mofu to remember. */
export interface MemoryStore {
  load(): Promise<string>;
  append(fact: string): Promise<void>;
  clear(): Promise<void>;
}

/** Most memory text that goes into the system prompt. */
export const MAX_MEMORY_CHARS = 4_000;

const HEADER = "# Mofu memory\n\n";

/** Markdown file, one fact per bullet. Used by the CLI (~/.mofu/memory.md). */
export class FileMemoryStore implements MemoryStore {
  constructor(private readonly file: string) {}

  async load(): Promise<string> {
    try {
      const text = await readFile(this.file, "utf8");
      return text.replace(HEADER, "").trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }

  async append(fact: string): Promise<void> {
    const clean = fact.replace(/\s+/g, " ").trim();
    if (!clean) return;
    await mkdir(path.dirname(this.file), { recursive: true });
    const existing = await this.load();
    if (!existing) await writeFile(this.file, HEADER, "utf8");
    const date = new Date().toISOString().slice(0, 10);
    await appendFile(this.file, `- ${clean} (${date})\n`, "utf8");
  }

  async clear(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, HEADER, "utf8");
  }
}

/** Keeps the newest facts when memory grows past the prompt budget. */
export function memoryForPrompt(memory: string): string {
  if (memory.length <= MAX_MEMORY_CHARS) return memory;
  const tail = memory.slice(-MAX_MEMORY_CHARS);
  return tail.slice(tail.indexOf("\n") + 1);
}
