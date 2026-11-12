/**
 * Tokens the agent must not touch right now, kept in paused.json so the webhook receiver and the
 * agent (two processes) share it.
 */
import { readFileSync, writeFileSync } from "node:fs";

const FILE = new URL("./paused.json", import.meta.url);

export type Paused = Record<string, { reason: string; at: string }>;

export function readPaused(): Paused {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Paused;
  } catch {
    return {};
  }
}

export function pauseToken(address: string, reason: string): void {
  const all = readPaused();
  all[address.toLowerCase()] = { reason, at: new Date().toISOString() };
  writeFileSync(FILE, JSON.stringify(all, null, 2));
}

export const isPaused = (address: string) => readPaused()[address.toLowerCase()] ?? null;
