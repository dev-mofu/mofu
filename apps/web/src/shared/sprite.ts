/**
 * Mofu, from the approved sprite in mascot/mofu-mascot.html. Framework-free so
 * both the React app and the landing page draw the same pixels.
 * The left half of a 26-column grid; mirrored when built.
 */
const HALF = [
  "....OO.......",
  "...OEEO......",
  "...OEEWOOOOOO",
  "...OEWWWWWWWW",
  "..OWWWWWWWWWW",
  "..OWWWWWWWWWW",
  ".OWWWWWWWWWWW",
  ".OWWWWWWWWWWW",
  ".OWWWKKWWWWWW",
  ".OWWKHKKWWWWW",
  "OWWWKKKKWWWWW",
  "OWWWKKKKWWWWW",
  ".OWWWKKWWWWWW",
  ".OWppWWWWWWKW",
  ".OWppWWWWWWWK",
  ".OWWWWWWWWWWW",
  "OWWWWWWWWWWWW",
  ".OLWWWWWWWWWW",
  ".OLWWWWWWWWWW",
  "..OLWWWWWWWWW",
  "..OLLWWWWWWWW",
  "...OLLLWWWWWW",
  "....OOLLLLLLL",
  "......OOOOOOO",
];

export const MASCOT_W = 26;
export const MASCOT_H = HALF.length;

export const MASCOT_COLORS: Record<string, string> = {
  O: "#3a2a35",
  W: "#f6eff3",
  L: "#dccfd8",
  E: "#ff8fc0",
  K: "#1d1519",
  H: "#ffffff",
  p: "#ff9ccb",
  P: "#ff4f9a",
  S: "#f2c6dc",
  G: "#ff4f9a",
};

export type MascotState = "ready" | "focus" | "found";

/** Big paws (resting on a card edge): placed under the face when peeking. */
const PAW = [".OOOO.", "OWWWWO", "OWLWLO", "OOOOOO"];
export const PAW_ROWS = PAW.length;

/** The sprite as a grid of color keys ("." is transparent). */
export function buildMascotGrid(state: MascotState): string[][] {
  const g = HALF.map((r) => (r + [...r].reverse().join("")).split(""));
  const set = (x: number, y: number, c: string) => {
    const row = g[y];
    if (row && row[x] !== undefined) row[x] = c;
  };
  // The right eye's highlight sits on the same side as the left one; a small tuft on top.
  set(20, 9, "K");
  set(19, 9, "H");
  set(12, 1, "O");
  set(13, 0, "O");
  set(14, 0, "O");
  const spots = [
    [5, 17],
    [6, 17],
    [5, 18],
    [6, 18],
    [19, 19],
    [20, 19],
    [19, 20],
    [20, 20],
    [12, 20],
    [13, 20],
  ] as const;
  for (const [x, y] of spots) set(x, y, "S");
  if (state === "focus") {
    // Half-closed eyes behind pink glasses.
    for (const [x, y] of [
      [5, 8],
      [6, 8],
      [19, 8],
      [20, 8],
    ] as const)
      set(x, y, "L");
    for (const x0 of [3, 17]) {
      for (let x = x0; x <= x0 + 5; x++) {
        set(x, 7, "G");
        set(x, 13, "G");
      }
      for (let y = 7; y <= 13; y++) {
        set(x0, y, "G");
        set(x0 + 5, y, "G");
      }
    }
    for (let x = 9; x <= 16; x++) set(x, 9, "G");
    set(11, 13, "W");
    set(14, 13, "W");
    set(12, 14, "K");
    set(13, 14, "K");
  }
  if (state === "found") {
    // Happy ^ ^ eyes and an open smile.
    for (let y = 8; y <= 12; y++) for (const x of [4, 5, 6, 7, 18, 19, 20, 21]) set(x, y, "W");
    for (const [x, y] of [
      [5, 9],
      [6, 9],
      [4, 10],
      [7, 10],
      [19, 9],
      [20, 9],
      [18, 10],
      [21, 10],
    ] as const)
      set(x, y, "K");
    set(11, 13, "K");
    set(12, 13, "P");
    set(13, 13, "P");
    set(14, 13, "K");
    set(11, 14, "W");
    set(12, 14, "K");
    set(13, 14, "K");
    set(14, 14, "W");
  }
  return g;
}

/** The top `rows` of the sprite with paws resting below the cut, for peeking over a card. */
export function buildPeekGrid(state: MascotState, rows = 16): string[][] {
  const g = buildMascotGrid(state).slice(0, rows);
  const paws = PAW.map(() => new Array<string>(MASCOT_W).fill("."));
  for (const x0 of [2, 18])
    PAW.forEach((r, dy) => [...r].forEach((ch, dx) => (paws[dy]![x0 + dx] = ch)));
  return [...g, ...paws];
}

export interface DrawOptions {
  px: number;
  x?: number;
  y?: number;
  /** Round dots instead of squares (the dot-matrix look). */
  dots?: boolean;
  colors?: Record<string, string>;
}

/** Draws a grid of color keys onto a 2D context (already scaled for devicePixelRatio). */
/** The bits of a 2D canvas context we use (src/shared is also compiled without DOM types). */
export interface PixelContext {
  fillStyle: string | object;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  fill(): void;
}

export function drawGrid(ctx: PixelContext, grid: string[][], opts: DrawOptions): void {
  const { px, x = 0, y = 0, dots = false, colors = MASCOT_COLORS } = opts;
  grid.forEach((row, gy) =>
    row.forEach((ch, gx) => {
      const color = colors[ch];
      if (!color) return;
      ctx.fillStyle = color;
      const X = x + gx * px;
      const Y = y + gy * px;
      if (dots) {
        ctx.beginPath();
        ctx.arc(X + px / 2, Y + px / 2, px * 0.42, 0, Math.PI * 2);
        ctx.fill();
      } else ctx.fillRect(X, Y, px, px);
    }),
  );
}
