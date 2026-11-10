/** Short facts the user asked Mofu to remember. */
export interface MemoryStore {
  load(): Promise<string>;
  append(fact: string): Promise<void>;
  clear(): Promise<void>;
}

/** Most memory text that goes into the system prompt. */
export const MAX_MEMORY_CHARS = 4_000;

/** Keeps the newest facts when memory grows past the prompt budget. */
export function memoryForPrompt(memory: string): string {
  if (memory.length <= MAX_MEMORY_CHARS) return memory;
  const tail = memory.slice(-MAX_MEMORY_CHARS);
  return tail.slice(tail.indexOf("\n") + 1);
}

/**
 * In-memory store for one web request. The browser owns the real memory
 * (localStorage); saved facts reach it through the save_memory tool result.
 */
export class RequestMemoryStore implements MemoryStore {
  readonly saved: string[] = [];

  constructor(private readonly initial: string) {}

  async load(): Promise<string> {
    return [this.initial, ...this.saved.map((f) => `- ${f}`)].filter(Boolean).join("\n");
  }

  async append(fact: string): Promise<void> {
    const clean = fact.replace(/\s+/g, " ").trim();
    if (clean) this.saved.push(clean);
  }

  async clear(): Promise<void> {
    this.saved.length = 0;
  }
}
