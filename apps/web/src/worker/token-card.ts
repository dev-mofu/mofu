/**
 * The share card for a token page (og:image): a 1200×630 pixel-art PNG with the scan verdict, the
 * main code checks and how concentrated the supply is. Token names come from the contract, so
 * they're only ever drawn through the bitmap font (no markup, no fonts to inject into).
 */
import type { TokenCheck, TokenScanReport } from "../shared/api.js";
import { buildMascotGrid, MASCOT_COLORS } from "../shared/sprite.js";
import { fontSafe, PixelCanvas, textWidth } from "./pixel-png.js";

export const CARD_W = 1200;
export const CARD_H = 630;

const BASE = [
  "#0f0d0e",
  "#1b1619",
  "#3a2a35",
  "#f6eff3",
  "#a8949f",
  "#ff4f9a",
  "#5fd38d",
  "#f2b84b",
  "#ff8a80",
];
const [BG, PANEL, LINE, TEXT, MUTED, PINK, OK, WARN, BAD] = BASE.map((_, i) => i) as number[] as [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
const MASCOT_KEYS = Object.keys(MASCOT_COLORS);
const PALETTE = [...BASE, ...MASCOT_KEYS.map((k) => MASCOT_COLORS[k]!)];
const MASCOT_INDEX = Object.fromEntries(MASCOT_KEYS.map((k, i) => [k, BASE.length + i]));

export const VERDICT_TEXT: Record<TokenScanReport["verdict"], string> = {
  clean: "No red flags in the code",
  caution: "A few things to check",
  risky: "Someone has strong control",
};

const ROWS: Array<[TokenCheck["id"], string]> = [
  ["mint", "Mint"],
  ["pause", "Pause"],
  ["blacklist", "Blacklist"],
  ["fees", "Fees"],
  ["upgrade", "Upgrade"],
  ["owner", "Owner"],
];

const statusColor = (s: TokenCheck["status"] | undefined) =>
  s === "ok" ? OK : s === "warn" ? WARN : s === "risk" ? BAD : MUTED;

const pct = (n: number | null) => (n === null ? "-" : `${Number(n.toFixed(n < 10 ? 2 : 1))}%`);

/** Shortens text to fit `max` characters, marking the cut. */
function fit(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 2).trimEnd()}..`;
}

export function shortAddress(a: string): string {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

export async function renderTokenCard(r: TokenScanReport): Promise<Uint8Array> {
  const c = new PixelCanvas(CARD_W, CARD_H, PALETTE);
  c.rect(0, 0, CARD_W, CARD_H, BG);
  // A soft stepped border, like the site's cards.
  c.frame(24, 24, CARD_W - 48, CARD_H - 48, 4, LINE);
  c.rect(24, 24, 8, 8, BG);
  c.rect(CARD_W - 32, 24, 8, 8, BG);
  c.rect(24, CARD_H - 32, 8, 8, BG);
  c.rect(CARD_W - 32, CARD_H - 32, 8, 8, BG);

  const x = 72;
  c.text("Mofu token scan", x, 72, 3, PINK);

  // Name: as big as it fits in the left column.
  const name = fontSafe(r.token.name ?? (r.isContract ? "Unnamed contract" : "Not a contract"));
  const room = 780;
  let scale = 8;
  while (scale > 4 && textWidth(name, scale) > room) scale--;
  const shown = fit(name, Math.floor((room + scale) / (6 * scale)));
  c.text(shown, x, 116, scale, TEXT);
  const sub = [r.token.symbol ? `$${fit(fontSafe(r.token.symbol), 14)}` : null, "Robinhood Chain"]
    .filter(Boolean)
    .join(" - ");
  c.text(sub, x, 116 + 7 * scale + 22, 3, MUTED);

  // Verdict pill.
  const pillY = 250;
  if (r.isContract) {
    const color = r.verdict === "clean" ? OK : r.verdict === "caution" ? WARN : BAD;
    const label = VERDICT_TEXT[r.verdict];
    const w = textWidth(fontSafe(label), 4) + 48;
    c.rect(x, pillY, w, 60, color);
    c.rect(x, pillY, 6, 6, BG);
    c.rect(x + w - 6, pillY, 6, 6, BG);
    c.rect(x, pillY + 54, 6, 6, BG);
    c.rect(x + w - 6, pillY + 54, 6, 6, BG);
    c.text(label, x + 24, pillY + 16, 4, BG);
  } else {
    c.frame(x, pillY, 520, 60, 4, MUTED);
    c.text("No contract code here", x + 24, pillY + 16, 4, MUTED);
  }

  // Code checks, two columns of three.
  if (r.isContract) {
    ROWS.forEach(([id, label], i) => {
      const cx = x + (i < 3 ? 0 : 400);
      const cy = 352 + (i % 3) * 56;
      const check = r.checks.find((k) => k.id === id);
      let value: string;
      let status = check?.status;
      if (id === "owner") {
        value =
          r.owner.status === "renounced"
            ? "Renounced"
            : r.owner.status === "active"
              ? "Active"
              : "None";
        if (!status) status = r.owner.status === "active" ? "warn" : "ok";
      } else {
        value =
          status === "ok" ? "No" : status === "risk" ? "Yes" : status === "warn" ? "Check" : "-";
      }
      const color = statusColor(status);
      c.rect(cx, cy + 3, 15, 15, color);
      c.text(label, cx + 30, cy, 3, TEXT);
      c.text(value, cx + 228, cy, 3, color);
    });
  }

  // Mofu on the right, then the supply numbers.
  const mx = 900;
  c.sprite(buildMascotGrid(r.verdict === "clean" ? "found" : "ready"), MASCOT_INDEX, mx, 80, 9);
  c.rect(mx - 30, 330, 290, 4, PANEL);
  c.text("Top 10 hold", mx - 20, 352, 3, MUTED);
  c.text(pct(r.distribution.top10Percent), mx - 20, 382, 6, TEXT);
  c.text("Burned", mx - 20, 444, 3, MUTED);
  c.text(pct(r.burnedPercent), mx - 20, 474, 6, TEXT);

  // Footer.
  c.text(`mofu.works/token/${shortAddress(r.address)}`, x, 552, 3, MUTED);
  const note = "Code check, not advice";
  c.text(note, CARD_W - 72 - textWidth(fontSafe(note), 3), 552, 3, MUTED);
  return c.png();
}
