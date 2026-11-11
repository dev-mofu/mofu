/**
 * Original pixel art for the landing page, drawn from data on canvas so it
 * stays crisp at any size. Colors come from CSS variables (theme-aware).
 */

export interface Palette {
  /** "r,g,b" of the monochrome pixel ink. */
  ink: string;
  /** "r,g,b" of the pink accent. */
  accent: string;
  /** "r,g,b" of the page background (for solid, layered scenery). */
  bg: string;
}

function hexToRgb(hex: string): string | null {
  const m = hex.trim().match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m
    ? m
        .slice(1)
        .map((h) => parseInt(h, 16))
        .join(",")
    : null;
}

export function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  return {
    ink: css.getPropertyValue("--px-ink").trim() || "233,227,229",
    accent: css.getPropertyValue("--px-accent").trim() || "255,79,154",
    bg: hexToRgb(css.getPropertyValue("--bg")) ?? "15,13,14",
  };
}

/** An opaque color `t` of the way from the background to the ink (0 = background, 1 = ink). */
export function mix(p: Palette, t: number): string {
  const a = p.bg.split(",").map(Number);
  const b = p.ink.split(",").map(Number);
  return `rgb(${a.map((v, i) => Math.round(v + (b[i]! - v) * t)).join(",")})`;
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
  private lights: Array<{ x: number; y: number; phase: number; pink: boolean }> = [];
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
    // Fewer than before: the page-wide Starfield shows through the hero too.
    const count = Math.round((this.w * this.h) / 14000);
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
    this.buildCity(ctx, c);
    this.staticLayer = layer;
  }

  /**
   * A pixel city along the bottom of the hero, in three layers drawn opaque so
   * nearer blocks hide farther ones: hazy towers at the back, moonlit buildings
   * (a lit face and a shadow face, rooftop details, windows) in the middle, and
   * dark low-rise in front, whose few lights twinkle (see draw()).
   */
  private buildCity(ctx: CanvasRenderingContext2D, c: number): void {
    const p = this.palette;
    const scale = this.w < 640 ? 0.62 : 1;
    const snap = (v: number) => Math.round(v / c) * c;
    this.lights = [];
    // Tones are a share of the way from the background to the ink. At night (dark theme) the
    // front is darkest and edges catch moonlight; by day (light theme) the front is darkest too,
    // the back fades into the sky, and edges are the sunlit, lighter side.
    const day = p.bg.split(",").reduce((s, v) => s + Number(v), 0) / 3 > 128;
    const tones = day
      ? [
          { body: 0.1, lit: 0.07, edge: 0.04 },
          { body: 0.2, lit: 0.14, edge: 0.08 },
          { body: 0.34, lit: 0.27, edge: 0.18 },
        ]
      : [
          { body: 0.17, lit: 0.21, edge: 0.3 },
          { body: 0.1, lit: 0.16, edge: 0.34 },
          { body: 0.045, lit: 0.07, edge: 0.18 },
        ];
    const layers = [
      {
        seed: 31,
        minH: 90,
        maxH: 180,
        minW: 5,
        maxW: 11,
        ...tones[0]!,
        windows: 0.06,
        front: false,
      },
      {
        seed: 47,
        minH: 55,
        maxH: 135,
        minW: 7,
        maxW: 15,
        ...tones[1]!,
        windows: 0.2,
        front: false,
      },
      { seed: 59, minH: 22, maxH: 62, minW: 6, maxW: 13, ...tones[2]!, windows: 0.12, front: true },
    ];
    for (const L of layers) {
      const rand = seeded(L.seed);
      let x = -snap(rand() * 40);
      while (x < this.w) {
        const bw = Math.round(L.minW + rand() * (L.maxW - L.minW)) * c;
        const bh = snap((L.minH + rand() * (L.maxH - L.minH)) * scale);
        const top = this.h - bh;
        const litW = snap(bw * (0.3 + rand() * 0.2));
        // Body: shadow face, then the moonlit face on the left.
        ctx.fillStyle = mix(p, L.body);
        ctx.fillRect(x, top, bw, bh);
        ctx.fillStyle = mix(p, L.lit);
        ctx.fillRect(x, top, litW, bh);
        // Rooftop: a setback, an antenna, a water tank or a spire.
        const roof = rand();
        ctx.fillStyle = mix(p, L.lit);
        if (roof < 0.22 && bw > 6 * c) {
          const sw = snap(bw * 0.5);
          const sh = snap(c * (3 + rand() * 4));
          ctx.fillRect(x + snap((bw - sw) / 2), top - sh, sw, sh);
        } else if (roof < 0.42) {
          ctx.fillStyle = mix(p, L.edge);
          ctx.fillRect(
            x + snap(bw * (0.2 + rand() * 0.6)),
            top - c * (3 + Math.floor(rand() * 4)),
            Math.max(1, c / 2),
            c * 6,
          );
        } else if (roof < 0.55 && bw > 5 * c) {
          const tx = x + snap(bw * 0.6);
          ctx.fillRect(tx, top - 3 * c, 2 * c, 2 * c);
          ctx.fillRect(tx, top - c, Math.max(1, c / 2), c);
          ctx.fillRect(tx + 2 * c - Math.max(1, c / 2), top - c, Math.max(1, c / 2), c);
        } else if (roof < 0.62 && !L.front) {
          const mid = x + snap(bw / 2) - c;
          ctx.fillRect(mid, top - 4 * c, 2 * c, 4 * c);
          ctx.fillStyle = mix(p, L.edge);
          ctx.fillRect(mid + c / 2, top - 8 * c, Math.max(1, c / 2), 4 * c);
        }
        // Roofline and lit edge catch the moonlight.
        ctx.fillStyle = mix(p, L.edge);
        ctx.fillRect(x, top, bw, Math.max(1, c / 2));
        ctx.fillRect(x, top, Math.max(1, c / 2), bh);
        // Windows: a grid, some lit. The front layer's lit windows twinkle in draw().
        for (let wy = top + 2 * c; wy < this.h - 2 * c; wy += 2 * c) {
          for (let wx = x + c; wx <= x + bw - 2 * c; wx += 2 * c) {
            const r = rand();
            if (r < L.windows) {
              const pink = rand() < 0.07;
              if (L.front) this.lights.push({ x: wx, y: wy, phase: rand() * 30, pink });
              else {
                ctx.fillStyle = pink
                  ? `rgba(${p.accent},0.85)`
                  : mix(p, L.front ? 0.7 : 0.45 + rand() * 0.25);
                ctx.fillRect(wx, wy, c - 1, c - 1);
              }
            } else if (r < L.windows + 0.25) {
              // Unlit windows give the facades texture.
              ctx.fillStyle = mix(p, L.body + 0.03);
              ctx.fillRect(wx, wy, c - 1, c - 1);
            }
          }
        }
        x += bw + (L.front ? 0 : c * Math.floor(rand() * 2));
      }
    }
    // A street line along the very bottom.
    ctx.fillStyle = mix(p, 0.2);
    ctx.fillRect(0, this.h - Math.max(1, c / 2), this.w, Math.max(1, c / 2));
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
    // Lights in the front buildings switch on and off now and then.
    for (const l of this.lights) {
      if (Math.sin(time * 0.0005 + l.phase) < -0.55) continue;
      ctx.fillStyle = l.pink ? `rgba(${this.palette.accent},0.9)` : mix(this.palette, 0.75);
      ctx.fillRect(l.x, l.y, c - 1, c - 1);
    }
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

interface FieldStar {
  x: number;
  y: number;
  depth: number;
  phase: number;
  speed: number;
  big: boolean;
}

interface Meteor {
  x: number;
  y: number;
  born: number;
}

interface Mote {
  x: number;
  y: number;
  drift: number;
  phase: number;
}

/**
 * The page-wide background: twinkling stars in two depths (they shift a little
 * as you scroll), an occasional shooting star, and a few pink motes rising.
 * A fixed canvas the size of the viewport.
 */
export class Starfield {
  private ctx: CanvasRenderingContext2D | null = null;
  private stars: FieldStar[] = [];
  private motes: Mote[] = [];
  private meteor: Meteor | null = null;
  private nextMeteor = 0;
  private w = 0;
  private h = 0;
  private readonly rand = seeded(99);

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private palette: Palette,
  ) {}

  setPalette(p: Palette): void {
    this.palette = p;
  }

  resize(): void {
    this.ctx = fitCanvas(this.canvas);
    this.w = Math.round(this.canvas.getBoundingClientRect().width);
    this.h = Math.round(this.canvas.getBoundingClientRect().height);
    const rand = seeded(17);
    const count = Math.round((this.w * this.h) / 6500);
    this.stars = Array.from({ length: count }, () => ({
      x: rand() * this.w,
      y: rand() * this.h,
      depth: rand() < 0.7 ? 0.04 : 0.1,
      phase: rand() * Math.PI * 2,
      speed: 0.5 + rand() * 1.5,
      big: rand() < 0.06,
    }));
    this.motes = Array.from({ length: Math.round(this.w / 110) }, () => ({
      x: rand() * this.w,
      y: rand() * this.h,
      drift: 0.008 + rand() * 0.012,
      phase: rand() * Math.PI * 2,
    }));
  }

  draw(time: number, scrollY: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { ink, accent } = this.palette;
    ctx.clearRect(0, 0, this.w, this.h);
    for (const s of this.stars) {
      // Parallax: far stars move less than near ones.
      const y = (((s.y - scrollY * s.depth) % this.h) + this.h) % this.h;
      const a = 0.18 + 0.5 * (0.5 + 0.5 * Math.sin(time * 0.001 * s.speed + s.phase));
      ctx.fillStyle = `rgba(${ink},${a.toFixed(3)})`;
      const x = Math.round(s.x);
      const yy = Math.round(y);
      ctx.fillRect(x, yy, 2, 2);
      if (s.big && a > 0.5) {
        ctx.fillRect(x - 3, yy, 2, 2);
        ctx.fillRect(x + 3, yy, 2, 2);
        ctx.fillRect(x, yy - 3, 2, 2);
        ctx.fillRect(x, yy + 3, 2, 2);
      }
    }
    // Pink motes rise slowly and wrap around.
    for (const m of this.motes) {
      const y = (((m.y - time * m.drift - scrollY * 0.06) % this.h) + this.h) % this.h;
      const x = m.x + Math.sin(time * 0.0007 + m.phase) * 10;
      const a = 0.25 + 0.3 * (0.5 + 0.5 * Math.sin(time * 0.002 + m.phase));
      ctx.fillStyle = `rgba(${accent},${a.toFixed(3)})`;
      ctx.fillRect(Math.round(x), Math.round(y), 3, 3);
    }
    // A shooting star every 5–11 seconds: a dotted streak that fades.
    if (!this.meteor && time > this.nextMeteor) {
      this.meteor = {
        x: this.rand() * this.w * 0.8 + this.w * 0.1,
        y: this.rand() * this.h * 0.5,
        born: time,
      };
    }
    if (this.meteor) {
      const age = (time - this.meteor.born) / 900;
      if (age >= 1) {
        this.meteor = null;
        this.nextMeteor = time + 5000 + this.rand() * 6000;
      } else {
        const headX = this.meteor.x - age * 260;
        const headY = this.meteor.y + age * 130;
        for (let i = 0; i < 10; i++) {
          const a = (1 - age) * (1 - i / 10) * 0.9;
          ctx.fillStyle = `rgba(${ink},${a.toFixed(3)})`;
          ctx.fillRect(Math.round(headX + i * 6), Math.round(headY - i * 3), 2, 2);
        }
      }
    }
  }
}

/**
 * A feature illustration that draws itself dot by dot (diagonal sweep) the
 * first time it's seen, then lets its pink dots shimmer.
 */
export class PixelIllustration {
  private ctx: CanvasRenderingContext2D | null = null;
  private cell = 6;
  private revealStart = -1;
  private readonly cells: Array<{ x: number; y: number; ch: string; order: number }>;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly rows: string[],
    private palette: Palette,
    private readonly animate: boolean,
  ) {
    const maxOrder = rows.length + rows[0]!.length;
    this.cells = rows.flatMap((row, y) =>
      [...row].flatMap((ch, x) => (ch === "." ? [] : [{ x, y, ch, order: (x + y) / maxOrder }])),
    );
  }

  setPalette(p: Palette): void {
    this.palette = p;
  }

  resize(): void {
    const width = this.canvas.parentElement!.clientWidth - 32;
    this.cell = Math.min(9, Math.max(4, Math.floor(width / this.rows[0]!.length)));
    this.ctx = fitCanvas(
      this.canvas,
      this.rows[0]!.length * this.cell,
      this.rows.length * this.cell,
    );
  }

  /** Starts the reveal the first time the illustration is on screen. */
  start(time: number): void {
    if (this.revealStart < 0) this.revealStart = time;
  }

  draw(time: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const c = this.cell;
    const { ink, accent } = this.palette;
    const progress = !this.animate
      ? 1
      : this.revealStart < 0
        ? 0
        : Math.min(1, (time - this.revealStart) / 1100);
    ctx.clearRect(0, 0, this.rows[0]!.length * c, this.rows.length * c);
    for (const cell of this.cells) {
      if (cell.order > progress * 1.05) continue;
      let alpha = cell.ch === ":" ? 0.35 : 0.85;
      // The newest dots flash bright as the sweep passes.
      if (progress < 1 && progress * 1.05 - cell.order < 0.06) alpha = 1;
      if (cell.ch === "+") {
        const shimmer =
          this.animate && progress >= 1
            ? 0.65 + 0.35 * Math.sin(time * 0.004 + cell.x * 0.7 + cell.y)
            : 1;
        ctx.fillStyle = `rgba(${accent},${shimmer.toFixed(3)})`;
      } else {
        ctx.fillStyle = `rgba(${ink},${alpha})`;
      }
      dot(ctx, cell.x * c, cell.y * c, c);
    }
  }
}
