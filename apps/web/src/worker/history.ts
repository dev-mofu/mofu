import type { UIMessage } from "ai";

/**
 * Keeps the newest messages that fit the count and size budget, then drops
 * leading non-user messages so the history starts with the user.
 * Returns null if even the newest message alone is too large.
 */
export function trimHistory(
  messages: UIMessage[],
  maxMessages: number,
  maxChars: number,
): UIMessage[] | null {
  const kept: UIMessage[] = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0 && kept.length < maxMessages; i--) {
    const message = messages[i];
    if (!message) continue;
    const size = JSON.stringify(message.parts).length;
    if (chars + size > maxChars) break;
    chars += size;
    kept.unshift(message);
  }
  if (kept.length === 0) return null;
  while (kept.length > 0 && kept[0]?.role !== "user") kept.shift();
  return kept.length > 0 ? kept : null;
}
