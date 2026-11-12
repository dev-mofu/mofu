/**
 * Receives Mofu webhooks and pauses tokens that changed in a worrying way.
 *
 *   MOFU_WEBHOOK_SECRET=whsec_… node webhook-receiver.ts
 *
 * It listens on PORT (default 8787). Put it behind a public https URL (your server, or a tunnel),
 * then: npx mofu-cli webhook add https://your.domain/mofu 0xTOKEN
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pauseToken } from "./paused.ts";

/** Events that stop the agent from buying more of that token. */
const PAUSE_ON = new Set([
  "owner_changed",
  "supply_changed",
  "upgraded",
  "pause_changed",
  "liquidity_dropped",
]);

/** Checks Mofu-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">. */
export function verifySignature(
  header: string | undefined,
  body: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(
    (header ?? "").split(",").map((p) => p.split("=", 2) as [string, string]),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1 || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest();
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface MofuEvent {
  id: string;
  type: string;
  summary: string;
  token: { address: string; symbol: string | null } | null;
  before: unknown;
  after: unknown;
}

/** What to do with one event; returns a line for the log. */
export function handleEvent(e: MofuEvent, pause = pauseToken): string {
  if (!e.token) return `${e.type}: ${e.summary}`;
  const worse = e.type === "verdict_changed" && e.after !== "clean";
  if (PAUSE_ON.has(e.type) || worse) {
    pause(e.token.address, e.summary);
    return `PAUSED ${e.token.address}: ${e.summary}`;
  }
  return `${e.type}: ${e.summary}`;
}

function start() {
  const secret = process.env.MOFU_WEBHOOK_SECRET ?? "";
  if (!secret) {
    // First run: answer Mofu's ping so `mofu webhook add` can finish, then restart with the secret.
    console.log(
      "No MOFU_WEBHOOK_SECRET yet: answering pings only. Restart with the secret `mofu webhook add` prints.",
    );
  }
  const port = Number(process.env.PORT ?? 8787);
  createServer((req, res) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 100_000) req.destroy();
    });
    req.on("end", () => {
      // The ping at creation comes before you know the secret: answer it, act on nothing else unsigned.
      if (req.headers["mofu-event"] === "ping") return void res.writeHead(200).end("ok");
      if (
        !secret ||
        !verifySignature(req.headers["mofu-signature"] as string | undefined, body, secret)
      ) {
        return void res.writeHead(401).end("bad signature");
      }
      try {
        console.log(handleEvent(JSON.parse(body) as MofuEvent));
      } catch {
        return void res.writeHead(400).end("bad json");
      }
      res.writeHead(200).end("ok");
    });
  }).listen(port, () => console.log(`Listening for Mofu webhooks on :${port}`));
}

if (process.argv[1]?.endsWith("webhook-receiver.ts")) start();
