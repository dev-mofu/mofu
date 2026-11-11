/**
 * Per-browser storage. Everything here stays on the user's device. Every
 * access is guarded: storage can be missing or throw (private mode, blocked
 * site data), and the app must still work without it.
 */

const KEYS = {
  memory: "mofu.memory",
  byokKey: "mofu.byokKey",
  byokModel: "mofu.byokModel",
} as const;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable; the value lives only for this page view.
  }
}

export interface MemoryItem {
  id: string;
  text: string;
  savedAt: string;
}

export const MAX_MEMORY_ITEMS = 50;
export const MAX_MEMORY_ITEM_CHARS = 300;

function isMemoryItem(v: unknown): v is MemoryItem {
  const m = v as MemoryItem;
  return typeof m?.id === "string" && typeof m.text === "string" && typeof m.savedAt === "string";
}

export function loadMemory(): MemoryItem[] {
  try {
    const parsed: unknown = JSON.parse(read(KEYS.memory) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isMemoryItem) : [];
  } catch {
    return [];
  }
}

export function saveMemory(items: MemoryItem[]): void {
  write(KEYS.memory, JSON.stringify(items));
}

/** Adds a fact, skipping duplicates and keeping the newest MAX_MEMORY_ITEMS. */
export function addMemoryItem(
  items: MemoryItem[],
  text: string,
  id: string,
  now = new Date(),
): MemoryItem[] {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_ITEM_CHARS);
  if (!clean) return items;
  if (items.some((m) => m.id === id || m.text.toLowerCase() === clean.toLowerCase())) return items;
  return [...items, { id, text: clean, savedAt: now.toISOString() }].slice(-MAX_MEMORY_ITEMS);
}

export interface Settings {
  byokKey: string;
  byokModel: string;
}

export function loadSettings(): Settings {
  return {
    byokKey: read(KEYS.byokKey) ?? "",
    byokModel: read(KEYS.byokModel) ?? "",
  };
}

export function saveSettings(s: Settings): void {
  write(KEYS.byokKey, s.byokKey || null);
  write(KEYS.byokModel, s.byokModel || null);
}
