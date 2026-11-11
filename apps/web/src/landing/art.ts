/**
 * Original pixel art for the landing page, drawn from data on canvas so it
 * stays crisp at any size. Colors come from CSS variables (theme-aware).
 */

export interface Palette {
  /** "r,g,b" of the monochrome pixel ink. */
  ink: string;
  /** "r,g,b" of the pink accent. */
  accent: string;
}

export function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  return {
    ink: css.getPropertyValue("--px-ink").trim() || "233,227,229",
    accent: css.getPropertyValue("--px-accent").trim() || "255,79,154",
  };
}

/** Sizes a canvas to its CSS box (or the given size) and returns a DPR-scaled context. */
export function fitCanvas(
  canvas: HTMLCanvasElement,
  w?: number,
  h?: number,
): CanvasRenderingContext2D | null {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(w ?? rect.width));
  const height = Math.max(1, Math.round(h ?? rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  if (w !== undefined) canvas.style.width = `${width}px`;
  if (h !== undefined) canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (ctx) ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** Deterministic random numbers, so the scenery is the same on every visit. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dot = (ctx: CanvasRenderingContext2D, x: number, y: number, size: number) => {
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size * 0.42, 0, Math.PI * 2);
  ctx.fill();
};

/** Ridge heights (in cells) by midpoint displacement; same seed, same mountains. */
export function ridge(cols: number, seed: number, base: number, rough: number): number[] {
  const rand = seeded(seed);
  let size = 1;
  while (size < cols) size *= 2;
  const h = new Array<number>(size + 1).fill(base);
  h[0] = base + rand() * rough;
  h[size] = base + rand() * rough;
  for (let step = size, amp = rough; step > 1; step /= 2, amp *= 0.55) {
    for (let i = step / 2; i < size; i += step) {
      h[i] = (h[i - step / 2]! + h[i + step / 2]!) / 2 + (rand() - 0.5) * amp * 2;
    }
  }
  return h.slice(0, cols).map((v) => Math.max(1, Math.round(v)));
}

const CLOUDS = [
  [
    "......xxxxxx..........",
    "...xxxxxxxxxxxx.......",
    "xxxxxxxxxxxxxxxxxxxxx.",
    "..xxxxxxxxxxxxxxxxxxxxx",
  ],
  ["....xxxxx.......", "..xxxxxxxxxxx...", "xxxxxxxxxxxxxxxx"],
  [".....xxxxxxx.....", "xxxxxxxxxxxxxxxxx", "...xxxxxxxxxxxx.."],
];

interface Star {
  x: number;
  y: number;
  phase: number;
  speed: number;
  big: boolean;
}

/** The hero's night sky: twinkling stars, a ringed moon, drifting clouds, mountains. */
export class NightSky {
  private stars: Star[] = [];
  private staticLayer: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private w = 0;
  private h = 0;
  private cell = 4;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private palette: Palette,
  ) {}

  setPalette(p: Palette): void {
    this.palette = p;
    this.resize();
  }

  resize(): void {
    this.ctx = fitCanvas(this.canvas);
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.round(rect.width);
    this.h = Math.round(rect.height);
    this.cell = this.w < 640 ? 3 : 4;
    const rand = seeded(7);
    const count = Math.round((this.w * this.h) / 5200);
    this.stars = Array.from({ length: count }, () => ({
      x: Math.floor((rand() * this.w) / this.cell) * this.cell,
      y: Math.floor((rand() * this.h * 0.72) / this.cell) * this.cell,
      phase: rand() * Math.PI * 2,
      speed: 0.6 + rand() * 1.6,
      big: rand() < 0.07,
    }));
    this.renderStatic();
  }

  /** Moon and mountains don't move: drawn once per resize. */
  private renderStatic(): void {
    const layer = document.createElement("canvas");
    const ctx = fitCanvas(layer, this.w, this.h);
    if (!ctx) return;
    const { ink } = this.palette;
    const c = this.cell;
    // Moon: a crescent of dots with a tilted ring of dots.
    // Below 1100px the headline spans the width, so the moon sits in the gap between the
    // navbar and the headline instead, clear of the text.
    const narrow = this.w < 1100;
    const mx = Math.round((this.w * (narrow ? 0.86 : 0.78)) / c);
    const my = Math.round((narrow ? 100 : Math.min(this.h * 0.2, 230)) / c);
    const r = this.w < 640 ? 5 : narrow ? 6 : 10;
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        const inMoon = x * x + y * y <= r * r;
        const inShadow = (x - r * 0.55) ** 2 + (y + r * 0.25) ** 2 <= (r * 0.92) ** 2;
        if (!inMoon || inShadow) continue;
        const edge = x * x + y * y > (r - 1.5) ** 2;
        ctx.fillStyle = `rgba(${ink},${edge ? 0.95 : 0.7})`;
        dot(ctx, (mx + x) * c, (my + y) * c, c);
      }
    }
    const tilt = -0.32;
    for (let a = 0; a < Math.PI * 2; a += 0.075) {
      const ex = Math.cos(a) * r * 1.9;
      const ey = Math.sin(a) * r * 0.45;
      const x = Math.round(ex * Math.cos(tilt) - ey * Math.sin(tilt));
      const y = Math.round(ex * Math.sin(tilt) + ey * Math.cos(tilt));
      // The back half of the ring hides behind the moon.
      if (Math.sin(a) < 0 && x * x + y * y < r * r) continue;
      ctx.fillStyle = `rgba(${ink},0.55)`;
      dot(ctx, (mx + x) * c, (my + y) * c, c);
    }
    // Mountains: a far, faint range and a near, denser one, dithered downwards.
    const cols = Math.ceil(this.w / c);
    const rows = Math.ceil(this.h / c);
    const layers = [
      // Heights in pixels, not a share of the hero, so tall heroes don't grow mountains over the CTA.
      { heights: ridge(cols, 11, 80 / c, 70 / c), alpha: 0.2, density: 0.5 },
      { heights: ridge(cols, 23, 40 / c, 50 / c), alpha: 0.38, density: 0.7 },
    ];
    for (const { heights, alpha, density } of layers) {
      const rand = seeded(alpha * 1000);
      heights.forEach((height, x) => {
        for (let y = 0; y < height; y++) {
          const fromTop = y / Math.max(1, height);
          const ridgeLine = height - y <= 1;
          if (!ridgeLine && rand() > density * (0.45 + fromTop * 0.55)) continue;
          ctx.fillStyle = `rgba(${ink},${ridgeLine ? alpha + 0.3 : alpha})`;
          ctx.fillRect(x * c, (rows - height + y) * c, c - 1, c - 1);
        }
      });
    }
    this.staticLayer = layer;
  }

  draw(time: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { ink } = this.palette;
    const c = this.cell;
    ctx.clearRect(0, 0, this.w, this.h);
    for (const s of this.stars) {
      const a = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(time * 0.001 * s.speed + s.phase));
      ctx.fillStyle = `rgba(${ink},${a.toFixed(3)})`;
      ctx.fillRect(s.x, s.y, c - 1, c - 1);
      if (s.big && a > 0.6) {
        ctx.fillRect(s.x - c, s.y, c - 1, c - 1);
        ctx.fillRect(s.x + c, s.y, c - 1, c - 1);
        ctx.fillRect(s.x, s.y - c, c - 1, c - 1);
        ctx.fillRect(s.x, s.y + c, c - 1, c - 1);
      }
    }
    // Clouds drift slowly and wrap; drawn as dashes, like a dot-matrix display.
    CLOUDS.forEach((shape, i) => {
      const span = this.w + shape[0]!.length * c * 2;
      const x0 = ((time * 0.006 * (i + 1) + i * span * 0.37) % span) - shape[0]!.length * c;
      const y0 = Math.round((this.h * (0.12 + i * 0.17)) / c) * c;
      ctx.fillStyle = `rgba(${ink},0.28)`;
      shape.forEach((row, ry) =>
        [...row].forEach((ch, rx) => {
          if (ch === "x" && rx % 2 === 0)
            ctx.fillRect(Math.round(x0 + rx * c), y0 + ry * c, c * 1.5, 1.5);
        }),
      );
    });
    if (this.staticLayer) ctx.drawImage(this.staticLayer, 0, 0, this.w, this.h);
  }
}

/** A city skyline with windows that switch on and off. */
export class Skyline {
  private ctx: CanvasRenderingContext2D | null = null;
  private windows: Array<{ x: number; y: number; phase: number; pink: boolean }> = [];
  private base: HTMLCanvasElement | null = null;
  private w = 0;
  private h = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private palette: Palette,
  ) {}

  setPalette(p: Palette): void {
    this.palette = p;
    this.resize();
  }

  resize(): void {
    this.ctx = fitCanvas(this.canvas);
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.round(rect.width);
    this.h = Math.round(rect.height);
    const c = 4;
    const rand = seeded(5);
    const layer = document.createElement("canvas");
    const ctx = fitCanvas(layer, this.w, this.h);
    if (!ctx) return;
    this.windows = [];
    let x = 0;
    while (x < this.w) {
      const bw = (4 + Math.floor(rand() * 7)) * c;
      const bh = Math.round((this.h * (0.25 + rand() * 0.6)) / c) * c;
      const top = this.h - bh;
      ctx.fillStyle = `rgba(${this.palette.ink},0.16)`;
      ctx.fillRect(x, top, bw - c, bh);
      if (rand() < 0.25) ctx.fillRect(x + Math.floor(bw / 2) - c, top - 3 * c, c, 3 * c);
      for (let wy = top + 2 * c; wy < this.h - 2 * c; wy += 2 * c) {
        for (let wx = x + c; wx < x + bw - 2 * c; wx += 2 * c) {
          if (rand() < 0.4)
            this.windows.push({ x: wx, y: wy, phase: rand() * 40, pink: rand() < 0.08 });
        }
      }
      x += bw;
    }
    this.base = layer;
  }

  draw(time: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.w, this.h);
    if (this.base) ctx.drawImage(this.base, 0, 0, this.w, this.h);
    for (const w of this.windows) {
      const on = Math.sin(time * 0.0004 + w.phase) > -0.3;
      if (!on) continue;
      ctx.fillStyle = w.pink ? `rgba(${this.palette.accent},0.9)` : `rgba(${this.palette.ink},0.6)`;
      ctx.fillRect(w.x, w.y, 3, 3);
    }
  }
}

/*
 * Feature illustrations: '#' ink, '+' accent, ':' faint ink, '.' empty.
 */
export const ILLUSTRATIONS: Record<string, string[]> = {
  chart: [
    "............................",
    ".:..................+++.....",
    ".:.................+..+.....",
    ".:........###.....+....+....",
    ".:.......#...#...+......+...",
    ".:..##..#.....###.......+...",
    ".:.#..##....................",
    ".:#.....................#...",
    ".:..................##..#...",
    ".:.......##.........##..#...",
    ".:.......##....##...##..#...",
    ".:..##...##....##...##..#...",
    ".:..##...##....++...##..#...",
    ".:..##...##....++...##..#...",
    ".:..##...##....++...##..#...",
    ".::::::::::::::::::::::::::.",
  ],
  study: [
    "............................",
    "...........++++++++++++.....",
    "...........+..........+.....",
    "...........+..###.....+.....",
    "...........+..........+.....",
    "...........+..#####...+.....",
    "...........++++++++++++.....",
    "............................",
    "..#########....#########....",
    ".#.........#..#.........#...",
    ".#.:::::::.#..#.:::::::.#...",
    ".#.........#..#.........#...",
    ".#.:::::::.#..#.:::::::.#...",
    ".#.........#..#.........#...",
    "..##########::##########....",
    "............................",
  ],
  dev: [
    "............................",
    "........#####...............",
    ".......#.....#..............",
    "......#..+++..#.............",
    "......#.+...+.#.............",
    "......#.+...+.#.............",
    "......#..+++..#.............",
    ".......#..+..#..............",
    "........#...#...##########..",
    ".........###....#........#..",
    "................#.+.......#.",
    "................#..+......#.",
    "................#.+..###..#.",
    "................#........#..",
    "................##########..",
    "............................",
  ],
  cli: [
    "............................",
    "..######################....",
    "..#.+.+.+..............#....",
    "..######################....",
    "..#....................#....",
    "..#.+..................#....",
    "..#..+..#####..........#....",
    "..#.+..................#....",
    "..#....................#....",
    "..#.:::::::::..........#....",
    "..#.::::::.............#....",
    "..#....................#....",
    "..#.+..++..............#....",
    "..#....................#....",
    "..######################....",
    "............................",
  ],
};

/** The pixel pointer that travels down the features timeline. */
export const CURSOR = [
  "+.....",
  "++....",
  "+++...",
  "++++..",
  "+++++.",
  "+++...",
  "+.++..",
  "...++.",
];

export function drawPixels(
  ctx: CanvasRenderingContext2D,
  rows: string[],
  cell: number,
  palette: Palette,
  dots = true,
): void {
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      ctx.fillStyle =
        ch === "+"
          ? `rgba(${palette.accent},1)`
          : ch === ":"
            ? `rgba(${palette.ink},0.35)`
            : `rgba(${palette.ink},0.85)`;
      if (dots) dot(ctx, x * cell, y * cell, cell);
      else ctx.fillRect(x * cell, y * cell, cell, cell);
    }),
  );
}
