import { useEffect, useRef } from "react";

/**
 * Mofu, drawn from the approved sprite in mascot/mofu-mascot.html.
 * Left half of a 26-column grid; mirrored at draw time.
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
const W = 26;
const H = HALF.length;
const COLORS: Record<string, string> = {
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

function buildGrid(state: MascotState): string[][] {
  const g = HALF.map((r) => (r + [...r].reverse().join("")).split(""));
  const set = (x: number, y: number, c: string) => {
    const row = g[y];
    if (row && row[x] !== undefined) row[x] = c;
  };
  set(20, 9, "K");
  set(19, 9, "H");
  set(12, 1, "O");
  set(13, 0, "O");
  set(14, 0, "O");
  for (const [x, y] of [
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
  ] as const) {
    set(x, y, "S");
  }
  if (state === "focus") {
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
    ] as const) {
      set(x, y, "K");
    }
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

interface MascotProps {
  state?: MascotState;
  /** Size of one sprite pixel in CSS pixels. */
  px?: number;
  className?: string;
}

export function Mascot({ state = "ready", px = 4, className }: MascotProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * px * dpr;
    canvas.height = H * px * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W * px, H * px);
    const grid = buildGrid(state);
    grid.forEach((row, y) =>
      row.forEach((ch, x) => {
        const color = COLORS[ch];
        if (!color) return;
        ctx.fillStyle = color;
        ctx.fillRect(x * px, y * px, px, px);
      }),
    );
  }, [state, px]);

  return (
    <canvas
      ref={ref}
      className={className}
      style={{ width: W * px, height: H * px }}
      aria-hidden="true"
    />
  );
}
