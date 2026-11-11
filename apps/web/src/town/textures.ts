/**
 * Procedural surface textures for Mofu Town, drawn on canvases at startup: walls (concrete,
 * brick, corrugated metal, glass, sandstone, riveted panels), roofs and paving. Each comes with
 * a matching bump map so light catches the relief.
 */
import * as THREE from "three";

export type WallKind = "concrete" | "brick" | "metal" | "glass" | "stone" | "panel";

const SIZE = 256;

function rng(seed: number) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}

function canvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  return [c, c.getContext("2d")!];
}

/** Fine grain plus soft blotches: dirt and wear. */
function grime(x: CanvasRenderingContext2D, R: () => number, amount: number) {
  const img = x.getImageData(0, 0, SIZE, SIZE);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (R() - 0.5) * 26 * amount;
    d[i] = Math.max(0, Math.min(255, d[i]! + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1]! + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2]! + n));
  }
  x.putImageData(img, 0, 0);
  for (let k = 0; k < 14; k++) {
    const gx = R() * SIZE,
      gy = R() * SIZE,
      r = 20 + R() * 60;
    const g = x.createRadialGradient(gx, gy, 0, gx, gy, r);
    g.addColorStop(0, `rgba(0,0,0,${0.12 * amount})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = g;
    x.fillRect(0, 0, SIZE, SIZE);
  }
  // streaks running down from the top
  for (let k = 0; k < 10; k++) {
    const sx = R() * SIZE,
      w = 2 + R() * 6;
    const g = x.createLinearGradient(0, 0, 0, SIZE * (0.3 + R() * 0.5));
    g.addColorStop(0, `rgba(0,0,0,${0.16 * amount})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = g;
    x.fillRect(sx, 0, w, SIZE);
  }
}

function finish(c: HTMLCanvasElement, bump: HTMLCanvasElement) {
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  const b = new THREE.CanvasTexture(bump);
  for (const t of [map, b]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
  }
  return { map, bump: b };
}

/** A grayscale copy for the bump map, with recesses (mortar, seams) drawn darker. */
function bumpFrom(c: HTMLCanvasElement, recess: (x: CanvasRenderingContext2D) => void) {
  const [b, x] = canvas();
  x.filter = "grayscale(1) contrast(1.4)";
  x.drawImage(c, 0, 0);
  x.filter = "none";
  recess(x);
  return b;
}

export function wallTexture(kind: WallKind, base: string, seed: number) {
  const R = rng(seed);
  const [c, x] = canvas();
  x.fillStyle = base;
  x.fillRect(0, 0, SIZE, SIZE);
  const shade = (k: number) => {
    const col = new THREE.Color(base).multiplyScalar(k);
    return `#${col.getHexString()}`;
  };
  let recess: (x: CanvasRenderingContext2D) => void = () => undefined;

  if (kind === "brick") {
    const bw = 32,
      bh = 16;
    for (let row = 0; row < SIZE / bh; row++) {
      for (let col = -1; col < SIZE / bw + 1; col++) {
        const ox = (row % 2) * (bw / 2);
        x.fillStyle = shade(0.8 + R() * 0.45);
        x.fillRect(col * bw + ox + 1, row * bh + 1, bw - 2, bh - 2);
      }
    }
    recess = (b) => {
      b.fillStyle = "#202020";
      for (let row = 0; row <= SIZE / bh; row++) b.fillRect(0, row * bh - 1, SIZE, 2);
      for (let row = 0; row < SIZE / bh; row++)
        for (let col = 0; col <= SIZE / bw + 1; col++)
          b.fillRect(col * bw + (row % 2) * (bw / 2) - 1, row * bh, 2, bh);
    };
    x.fillStyle = shade(0.55);
    for (let row = 0; row <= SIZE / bh; row++) x.fillRect(0, row * bh - 1, SIZE, 2);
    for (let row = 0; row < SIZE / bh; row++)
      for (let col = 0; col <= SIZE / bw + 1; col++)
        x.fillRect(col * bw + (row % 2) * (bw / 2) - 1, row * bh, 2, bh);
  } else if (kind === "concrete") {
    const p = 64;
    for (let py = 0; py < SIZE; py += p)
      for (let px = 0; px < SIZE; px += p) {
        x.fillStyle = shade(0.9 + R() * 0.2);
        x.fillRect(px, py, p, p);
        x.fillStyle = shade(0.7);
        for (const [hx, hy] of [
          [10, 10],
          [p - 10, 10],
          [10, p - 10],
          [p - 10, p - 10],
        ])
          x.fillRect(px + hx! - 1.5, py + hy! - 1.5, 3, 3);
      }
    x.fillStyle = shade(0.6);
    for (let k = 0; k <= SIZE; k += p) {
      x.fillRect(k - 1, 0, 2, SIZE);
      x.fillRect(0, k - 1, SIZE, 2);
    }
    recess = (b) => {
      b.fillStyle = "#1c1c1c";
      for (let k = 0; k <= SIZE; k += p) {
        b.fillRect(k - 1.5, 0, 3, SIZE);
        b.fillRect(0, k - 1.5, SIZE, 3);
      }
    };
  } else if (kind === "metal") {
    const w = 16;
    for (let k = 0; k < SIZE; k += w) {
      const g = x.createLinearGradient(k, 0, k + w, 0);
      g.addColorStop(0, shade(0.7));
      g.addColorStop(0.5, shade(1.15));
      g.addColorStop(1, shade(0.7));
      x.fillStyle = g;
      x.fillRect(k, 0, w, SIZE);
    }
    // rust patches
    for (let k = 0; k < 8; k++) {
      const gx = R() * SIZE,
        gy = R() * SIZE;
      const g = x.createRadialGradient(gx, gy, 0, gx, gy, 10 + R() * 26);
      g.addColorStop(0, "rgba(120,60,30,0.45)");
      g.addColorStop(1, "rgba(120,60,30,0)");
      x.fillStyle = g;
      x.fillRect(0, 0, SIZE, SIZE);
    }
    recess = (b) => {
      for (let k = 0; k < SIZE; k += w) {
        const g = b.createLinearGradient(k, 0, k + w, 0);
        g.addColorStop(0, "#202020");
        g.addColorStop(0.5, "#e0e0e0");
        g.addColorStop(1, "#202020");
        b.fillStyle = g;
        b.fillRect(k, 0, w, SIZE);
      }
    };
  } else if (kind === "glass") {
    const cw = 32,
      ch = 42;
    for (let py = 0; py < SIZE; py += ch)
      for (let px = 0; px < SIZE; px += cw) {
        const g = x.createLinearGradient(px, py, px + cw, py + ch);
        g.addColorStop(0, shade(0.7 + R() * 0.3));
        g.addColorStop(0.6, shade(1.1 + R() * 0.3));
        g.addColorStop(1, shade(0.6));
        x.fillStyle = g;
        x.fillRect(px + 2, py + 2, cw - 4, ch - 4);
      }
    x.fillStyle = "#15121a";
    for (let k = 0; k <= SIZE; k += cw) x.fillRect(k - 2, 0, 4, SIZE);
    for (let k = 0; k <= SIZE; k += ch) x.fillRect(0, k - 2, SIZE, 4);
    recess = (b) => {
      b.fillStyle = "#e8e8e8";
      for (let k = 0; k <= SIZE; k += cw) b.fillRect(k - 2, 0, 4, SIZE);
      for (let k = 0; k <= SIZE; k += ch) b.fillRect(0, k - 2, SIZE, 4);
    };
  } else if (kind === "stone") {
    let y = 0;
    while (y < SIZE) {
      const h = 22 + Math.floor(R() * 14);
      let xx = -Math.floor(R() * 30);
      while (xx < SIZE) {
        const w = 30 + Math.floor(R() * 40);
        x.fillStyle = shade(0.82 + R() * 0.36);
        x.fillRect(xx + 2, y + 2, w - 4, h - 4);
        xx += w;
      }
      y += h;
    }
    // The gaps between blocks are the background color, already dark in the grayscale copy.
  } else {
    // riveted panels
    const p = 64;
    for (let py = 0; py < SIZE; py += p)
      for (let px = 0; px < SIZE; px += p) {
        const g = x.createLinearGradient(px, py, px, py + p);
        g.addColorStop(0, shade(1.08));
        g.addColorStop(1, shade(0.85));
        x.fillStyle = g;
        x.fillRect(px + 1, py + 1, p - 2, p - 2);
        x.fillStyle = shade(1.35);
        for (let k = 6; k < p; k += 14) {
          x.fillRect(px + 4, py + k, 3, 3);
          x.fillRect(px + p - 7, py + k, 3, 3);
        }
      }
    recess = (b) => {
      b.fillStyle = "#151515";
      for (let k = 0; k <= SIZE; k += p) {
        b.fillRect(k - 1.5, 0, 3, SIZE);
        b.fillRect(0, k - 1.5, SIZE, 3);
      }
    };
  }
  grime(x, R, kind === "glass" ? 0.35 : 1);
  return finish(c, bumpFrom(c, recess));
}

export function roofTexture(seed: number) {
  const R = rng(seed);
  const [c, x] = canvas();
  x.fillStyle = "#26212b";
  x.fillRect(0, 0, SIZE, SIZE);
  grime(x, R, 1.6);
  x.strokeStyle = "rgba(0,0,0,0.35)";
  x.lineWidth = 2;
  for (let k = 0; k < SIZE; k += 48) {
    x.beginPath();
    x.moveTo(0, k + R() * 4);
    x.lineTo(SIZE, k + R() * 4);
    x.stroke();
  }
  return finish(
    c,
    bumpFrom(c, () => undefined),
  );
}

export function pavingTexture(seed: number, base = "#2c2433") {
  const R = rng(seed);
  const [c, x] = canvas();
  x.fillStyle = "#17121c";
  x.fillRect(0, 0, SIZE, SIZE);
  const s = 32;
  const col = new THREE.Color(base);
  for (let py = 0; py < SIZE; py += s)
    for (let px = 0; px < SIZE; px += s) {
      const k = 0.85 + R() * 0.3;
      x.fillStyle = `#${col.clone().multiplyScalar(k).getHexString()}`;
      x.beginPath();
      x.roundRect(px + 1.5, py + 1.5, s - 3, s - 3, 4);
      x.fill();
    }
  grime(x, R, 1.2);
  // a few wet patches that look darker and glossier
  for (let k = 0; k < 6; k++) {
    const gx = R() * SIZE,
      gy = R() * SIZE;
    const g = x.createRadialGradient(gx, gy, 0, gx, gy, 30 + R() * 40);
    g.addColorStop(0, "rgba(10,6,16,0.35)");
    g.addColorStop(1, "rgba(10,6,16,0)");
    x.fillStyle = g;
    x.fillRect(0, 0, SIZE, SIZE);
  }
  return finish(
    c,
    bumpFrom(c, (b) => {
      b.fillStyle = "#101010";
      for (let k = 0; k <= SIZE; k += s) {
        b.fillRect(k - 1.5, 0, 3, SIZE);
        b.fillRect(0, k - 1.5, SIZE, 3);
      }
    }),
  );
}
