/** Default cap for text returned to the model from a single tool call. */
export const DEFAULT_MAX_CHARS = 20_000;

/**
 * Cuts text to `maxChars` and says how much was dropped, so the model knows
 * the output is incomplete instead of assuming it saw everything.
 */
export function truncateText(text: string, maxChars = DEFAULT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const dropped = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n…[truncated ${dropped} more characters]`;
}

/** Truncates a list and reports how many items were left out. */
export function truncateList<T>(items: T[], max: number): { items: T[]; omitted: number } {
  if (items.length <= max) return { items, omitted: 0 };
  return { items: items.slice(0, max), omitted: items.length - max };
}
