import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createSessionToken, verifySessionToken } from "../src/worker/session.js";
import { evaluateUsage, nextUtcMidnight, utcDay } from "../src/worker/usage.js";
import { trimHistory } from "../src/worker/history.js";
import { verifyTurnstile } from "../src/worker/turnstile.js";
import { parseApiError } from "../src/shared/api.js";

const SECRET = "x".repeat(32);
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

describe("session tokens", () => {
  it("verifies a fresh token and rejects expired ones", async () => {
    const { token, expiresAt } = await createSessionToken(SECRET, NOW, 1000);
    expect(expiresAt).toBe(NOW + 1000);
    expect(await verifySessionToken(SECRET, token, NOW + 999)).toBe(true);
    expect(await verifySessionToken(SECRET, token, NOW + 1000)).toBe(false);
  });

  it("rejects tampered, foreign and malformed tokens", async () => {
    const { token } = await createSessionToken(SECRET, NOW, 1000);
    const [payload, sig] = token.split(".");
    const forged = `${btoa(JSON.stringify({ exp: NOW + 10 ** 9 }))}.${sig}`;
    expect(await verifySessionToken(SECRET, forged, NOW)).toBe(false);
    expect(await verifySessionToken("y".repeat(32), token, NOW)).toBe(false);
    expect(await verifySessionToken(SECRET, `${payload}.`, NOW)).toBe(false);
    expect(await verifySessionToken(SECRET, `${token}.extra`, NOW)).toBe(false);
    expect(await verifySessionToken(SECRET, undefined, NOW)).toBe(false);
  });

  it("refuses a short secret", async () => {
    await expect(createSessionToken("short", NOW, 1000)).rejects.toThrow(/at least 32/);
  });
});

describe("daily usage", () => {
  it("counts up to the limit, then blocks", () => {
    let state;
    for (let i = 1; i <= 3; i++) {
      const out = evaluateUsage(state, NOW, 3, true);
      expect(out.result).toMatchObject({ allowed: true, remaining: 3 - i });
      state = out.state;
    }
    const blocked = evaluateUsage(state, NOW, 3, true);
    expect(blocked.result).toMatchObject({ allowed: false, remaining: 0 });
    expect(blocked.state.count).toBe(3);
  });

  it("peeks without consuming", () => {
    const out = evaluateUsage({ day: utcDay(NOW), count: 1 }, NOW, 3, false);
    expect(out.result.remaining).toBe(2);
    expect(out.state.count).toBe(1);
  });

  it("resets at UTC midnight", () => {
    const tomorrow = nextUtcMidnight(NOW);
    expect(new Date(tomorrow).toISOString()).toBe("2026-11-11T00:00:00.000Z");
    const out = evaluateUsage({ day: utcDay(NOW), count: 3 }, tomorrow, 3, true);
    expect(out.result).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("a limit of zero allows nothing", () => {
    expect(evaluateUsage(undefined, NOW, 0, true).result.allowed).toBe(false);
  });
});

describe("trimHistory", () => {
  const msg = (
    role: "user" | "assistant",
    text: string,
    id = Math.random().toString(),
  ): UIMessage => ({
    id,
    role,
    parts: [{ type: "text", text }],
  });

  it("keeps everything that fits", () => {
    const history = [msg("user", "a"), msg("assistant", "b"), msg("user", "c")];
    expect(trimHistory(history, 10, 10_000)).toEqual(history);
  });

  it("drops the oldest messages first and starts with a user message", () => {
    const history = [
      msg("user", "a"),
      msg("assistant", "b"),
      msg("user", "c"),
      msg("assistant", "d"),
      msg("user", "e"),
    ];
    const out = trimHistory(history, 4, 10_000);
    expect(out?.map((m) => (m.parts[0] as { text: string }).text)).toEqual(["c", "d", "e"]);
  });

  it("respects the character budget", () => {
    const history = [msg("user", "x".repeat(500)), msg("assistant", "ok"), msg("user", "short")];
    const out = trimHistory(history, 10, 100);
    expect(out?.map((m) => m.role)).toEqual(["user"]);
  });

  it("returns null when the newest message alone is too big", () => {
    expect(trimHistory([msg("user", "x".repeat(500))], 10, 100)).toBeNull();
  });
});

describe("verifyTurnstile", () => {
  const respond = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("accepts only success: true", async () => {
    expect(await verifyTurnstile("s", "t", "1.2.3.4", respond({ success: true }))).toBe(true);
    expect(await verifyTurnstile("s", "t", undefined, respond({ success: false }))).toBe(false);
    expect(await verifyTurnstile("s", "t", undefined, respond({}, 500))).toBe(false);
  });

  it("fails closed on network errors", async () => {
    const boom = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await verifyTurnstile("s", "t", undefined, boom)).toBe(false);
  });
});

describe("parseApiError", () => {
  it("reads our JSON errors from the transport's error message", () => {
    const err = new Error(JSON.stringify({ code: "daily_limit", message: "Used up", limit: 10 }));
    expect(parseApiError(err)).toEqual({ code: "daily_limit", message: "Used up", limit: 10 });
    expect(parseApiError(new Error("plain text"))).toBeNull();
  });
});
