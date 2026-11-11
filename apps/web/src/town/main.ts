/**
 * Mofu Town: a small voxel plaza at night. Walk as Mofu; each building opens a feature, and the
 * $MOFU tower in the middle shows the top holder wallets. Everything is built from boxes in code.
 */
import "./town.css";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { buildMascotGrid, MASCOT_COLORS } from "../shared/sprite.js";
import { createMofu } from "./mofu3d.js";
import { pavingTexture, roofTexture, wallTexture, type WallKind } from "./textures.js";
import { PLACES, type Place } from "./places.js";

const MOFU_CA = "0xf76593c1c321c2a2f77775025e9677999ce7ea8c";
const EXPLORER = "https://robinhoodchain.blockscout.com/address/";
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const coarse = matchMedia("(pointer: coarse)").matches;

// ---------------------------------------------------------------- the places list (no WebGL needed)
const placesPanel = byId("places");
const placesToggle = byId<HTMLButtonElement>("places-toggle");
{
  const list = byId("places-list");
  const items = [
    ...PLACES.map((p) => ({ href: p.href, color: p.color, name: p.name, kicker: p.kicker })),
    { href: `/app/?scan=${MOFU_CA}`, color: "#ff8fc0", name: "$MOFU Tower", kicker: "TOP HOLDERS" },
  ];
  for (const p of items) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = p.href;
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = p.color;
    dot.style.color = p.color;
    const strong = document.createElement("strong");
    strong.textContent = p.name;
    const small = document.createElement("small");
    small.textContent = p.kicker;
    a.append(dot, strong, small);
    li.append(a);
    list.append(li);
  }
  placesToggle.addEventListener("click", () => {
    const open = placesPanel.hidden;
    placesPanel.hidden = !open;
    placesToggle.setAttribute("aria-expanded", String(open));
  });
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

const rng = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

// ---------------------------------------------------------------- voxel building blocks
const LIT = new THREE.MeshLambertMaterial({ vertexColors: true });
const GLOW = new THREE.MeshBasicMaterial({ vertexColors: true });

/** Collects boxes and merges them into two meshes: lit surfaces and glowing ones. */
class Vox {
  private lit: THREE.BufferGeometry[] = [];
  private glow: THREE.BufferGeometry[] = [];
  /** x/z are the center, y is the bottom. */
  box(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: string,
    glow = false,
  ) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y + h / 2, z);
    const c = new THREE.Color(color);
    const n = g.attributes.position!.count;
    const cols = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) cols.set([c.r, c.g, c.b], i * 3);
    g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    (glow ? this.glow : this.lit).push(g);
    return this;
  }
  build(): THREE.Group {
    const group = new THREE.Group();
    if (this.lit.length) group.add(new THREE.Mesh(mergeGeometries(this.lit), LIT));
    if (this.glow.length) group.add(new THREE.Mesh(mergeGeometries(this.glow), GLOW));
    for (const g of [...this.lit, ...this.glow]) g.dispose();
    return group;
  }
}

function canvasTexture(w: number, h: number, draw: (x: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function signTexture(text: string, color: string) {
  return canvasTexture(512, 128, (x) => {
    x.fillStyle = "#120f10";
    x.beginPath();
    x.roundRect(4, 4, 504, 120, 22);
    x.fill();
    x.strokeStyle = color;
    x.lineWidth = 6;
    x.shadowColor = color;
    x.shadowBlur = 18;
    x.stroke();
    x.font = '600 60px "Pixelify Sans"';
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillStyle = color;
    x.fillText(text, 256, 68);
    x.shadowBlur = 0;
    x.fillStyle = "#fff6fa";
    x.globalAlpha = 0.55;
    x.fillText(text, 256, 68);
  });
}

function glowSprite(color: string, size: number, opacity = 0.8) {
  const tex = canvasTexture(64, 64, (x) => {
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
  });
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  s.scale.set(size, size, 1);
  return s;
}

/** Mofu as voxels: the 26×24 sprite, rounded front to back, face only on the front. */
function mascotMesh(scale: number): THREE.InstancedMesh {
  const grid = buildMascotGrid("ready");
  const rows = grid.length;
  const face = new Set(["K", "H", "p"]);
  const cells: Array<{ x: number; y: number; z: number; color: string; shade: number }> = [];
  grid.forEach((row, y) =>
    row.forEach((ch, x) => {
      const color = MASCOT_COLORS[ch];
      if (!color) return;
      const nx = (x - 12.5) / 13.5;
      const ny = (y - 12) / 13;
      const depth = Math.max(1, Math.round(5 * Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))) + 1);
      for (let z = -depth; z <= depth; z++) {
        const isFront = z === depth;
        const isBack = z === -depth;
        // The sprite's dark outline only belongs on the front and back faces; inside, Mofu is
        // white body, so it doesn't show as a dark slab from above or the side.
        const c = face.has(ch)
          ? isFront
            ? color
            : MASCOT_COLORS.W!
          : ch === "O" && !isFront && !isBack
            ? MASCOT_COLORS.L!
            : color;
        // Unlit voxels keep the sprite's exact colors; a little shade gives the round body depth.
        const shade = 0.8 + 0.2 * ((z + depth) / (2 * depth)) - (y > rows - 4 ? 0.06 : 0);
        cells.push({ x, y, z, color: c, shade });
      }
    }),
  );
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial(),
    cells.length,
  );
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  cells.forEach((c, i) => {
    m.makeScale(scale, scale, scale);
    m.setPosition((c.x - 12.5) * scale, (rows - 1 - c.y) * scale + scale / 2, c.z * scale);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, col.set(c.color).multiplyScalar(c.shade));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

// ---------------------------------------------------------------- world
interface BuiltPlace {
  place: Place;
  group: THREE.Group;
  door: THREE.Vector3;
  center: THREE.Vector3;
  radius: number;
  spin?: THREE.Object3D;
  blink?: THREE.Object3D;
}

const BUILDING_R = 18;

const WALLS: Record<Place["id"], { kind: WallKind; color: string }> = {
  data: { kind: "concrete", color: "#6f8a90" },
  study: { kind: "brick", color: "#8a4652" },
  dev: { kind: "metal", color: "#7a6a58" },
  scanner: { kind: "glass", color: "#5a3a5a" },
  holder: { kind: "stone", color: "#b19a6a" },
  mcp: { kind: "panel", color: "#566a8c" },
};
const doorWidth = (id: Place["id"]) => (id === "dev" ? 3.4 : 1.8);

function shadowsOn(o: THREE.Object3D) {
  o.traverse((m) => {
    if ((m as THREE.Mesh).isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
}
const PLAZA_R = 27;

function buildPlace(p: Place, i: number): BuiltPlace {
  const v = new Vox();
  const R = rng(97 + i * 13);
  const slim = p.id === "scanner";
  const W = slim ? 5.4 : 7.2;
  const D = slim ? 5.4 : 6.2;
  const H = { data: 7, study: 8, dev: 6, scanner: 12, holder: 6.5, mcp: 8 }[p.id];
  const base = 0.4;
  v.box(0, 0, 0, W + 0.8, base, D + 0.8, "#241d2a");
  const surface = WALLS[p.id];
  const tex = wallTexture(surface.kind, surface.color, 11 + i * 7);
  tex.map.repeat.set(W / 3.2, H / 3.2);
  tex.bump.repeat.copy(tex.map.repeat);
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(W, H, D),
    new THREE.MeshStandardMaterial({
      map: tex.map,
      bumpMap: tex.bump,
      bumpScale: surface.kind === "glass" ? 0.6 : 2.2,
      roughness: surface.kind === "glass" ? 0.25 : surface.kind === "metal" ? 0.55 : 0.92,
      metalness: surface.kind === "glass" ? 0.35 : surface.kind === "metal" ? 0.35 : 0,
    }),
  );
  wall.position.y = base + H / 2;
  // corner pillars and a glowing trim under the roof
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) v.box((sx * W) / 2, base, (sz * D) / 2, 0.45, H, 0.45, "#1e1922");
  v.box(0, base + H - 0.3, D / 2 + 0.04, W, 0.16, 0.08, p.color, true);
  v.box(W / 2 + 0.04, base + H - 0.3, 0, 0.08, 0.16, D, p.color, true);
  v.box(-W / 2 - 0.04, base + H - 0.3, 0, 0.08, 0.16, D, p.color, true);
  const roofTex = roofTexture(40 + i);
  roofTex.map.repeat.set((W + 0.5) / 3, (D + 0.5) / 3);
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(W + 0.5, 0.35, D + 0.5),
    new THREE.MeshStandardMaterial({
      map: roofTex.map,
      bumpMap: roofTex.bump,
      bumpScale: 1.5,
      roughness: 0.95,
    }),
  );
  roof.position.y = base + H + 0.175;
  // a low parapet around the roof edge
  for (const [px, pz, pw, pd] of [
    [0, D / 2 + 0.2, W + 0.5, 0.12],
    [0, -D / 2 - 0.2, W + 0.5, 0.12],
    [W / 2 + 0.2, 0, 0.12, D + 0.5],
    [-W / 2 - 0.2, 0, 0.12, D + 0.5],
  ] as const)
    v.box(px, base + H + 0.35, pz, pw, 0.35, pd, "#2c2532");
  // the step in front of the door
  v.box(0, 0.4, D / 2 + 0.45, doorWidth(p.id) + 0.8, 0.14, 0.8, "#3a3340");

  // door with a glowing frame
  const doorW = doorWidth(p.id);
  v.box(0, base, D / 2 + 0.03, doorW, 2.6, 0.1, "#100c13");
  v.box(0, base + 2.6, D / 2 + 0.06, doorW + 0.3, 0.14, 0.08, p.color, true);
  v.box(-doorW / 2 - 0.08, base, D / 2 + 0.06, 0.14, 2.7, 0.08, p.color, true);
  v.box(doorW / 2 + 0.08, base, D / 2 + 0.06, 0.14, 2.7, 0.08, p.color, true);
  if (p.id === "dev")
    for (let k = 0; k < 3; k++)
      v.box(0, base + 0.5 + k * 0.7, D / 2 + 0.09, doorW - 0.3, 0.07, 0.05, p.color, true);

  // windows: warm or neon when lit, dark otherwise
  const win = (x: number, y: number, z: number, side: boolean) => {
    const lit = R() > 0.28;
    const pick = R();
    const color = lit
      ? pick > 0.62
        ? "#ffd9a8"
        : pick > 0.4
          ? "#ffe9c9"
          : pick > 0.25
            ? "#cfe0ff"
            : p.color
      : "#1b1620";
    const frame = "#17121b";
    if (side) {
      const out = Math.sign(x);
      v.box(x, y - 0.08, z, 0.1, 1.06, 0.86, frame);
      v.box(x + out * 0.03, y, z, 0.08, 0.9, 0.7, color, lit);
      v.box(x + out * 0.08, y - 0.14, z, 0.18, 0.08, 0.96, "#4a4250");
      if (lit && R() > 0.5) v.box(x + out * 0.06, y + 0.42, z, 0.06, 0.06, 0.7, "#2a2030");
    } else {
      v.box(x, y - 0.08, z, 0.86, 1.06, 0.1, frame);
      v.box(x, y, z + 0.03, 0.7, 0.9, 0.08, color, lit);
      v.box(x, y - 0.14, z + 0.08, 0.96, 0.08, 0.18, "#4a4250");
      if (lit && R() > 0.5) v.box(x, y + 0.42, z + 0.06, 0.7, 0.06, 0.06, "#2a2030");
    }
  };
  for (let y = base + 3.4; y < base + H - 1.2; y += 1.6) {
    for (let x = -W / 2 + 1.1; x <= W / 2 - 1; x += 1.3) win(x, y, D / 2 + 0.05, false);
    for (let z = -D / 2 + 1.1; z <= D / 2 - 1; z += 1.3) {
      win(W / 2 + 0.05, y, z, true);
      win(-W / 2 - 0.05, y, z, true);
    }
  }
  for (const x of [-W / 2 + 1.1, W / 2 - 1.1])
    if (Math.abs(x) > doorW / 2 + 0.6) win(x, base + 1.1, D / 2 + 0.05, false);

  const top = base + H + 0.35;
  let spin: THREE.Object3D | undefined;
  let blink: THREE.Object3D | undefined;
  const extras = new THREE.Group();
  if (p.id === "data") {
    [1, 1.8, 2.6, 3.4].forEach((h, k) => v.box(-2.1 + k * 1.4, top, 0, 0.9, h, 0.9, p.color, true));
  } else if (p.id === "study") {
    v.box(0, top, 0, W - 2, 1.4, D - 2, p.wall).box(
      0,
      top + 1.4,
      0,
      W - 1.6,
      0.3,
      D - 1.6,
      "#1a1520",
    );
    ["#ff8fc0", "#ffd166", "#4fd1c5"].forEach((c, k) =>
      v.box(0, top + 1.7 + k * 0.45, 0, 2.6 - k * 0.4, 0.4, 1.6, c),
    );
  } else if (p.id === "dev") {
    v.box(W / 2 - 1.2, top, -D / 2 + 1.2, 1, 2.4, 1, "#2a2026").box(
      W / 2 - 1.2,
      top + 2.4,
      -D / 2 + 1.2,
      1.2,
      0.25,
      1.2,
      p.color,
      true,
    );
    const gear = new Vox();
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      gear.box(Math.cos(a) * 0.9, Math.sin(a) * 0.9 - 0.25, 0, 0.5, 0.5, 0.3, p.color, true);
    }
    gear.box(0, -0.6, 0, 1.2, 1.2, 0.35, "#2a2026");
    spin = gear.build();
    spin.position.set(-1.4, top + 1.4, 0);
    extras.add(spin);
  } else if (p.id === "scanner") {
    v.box(0, top, 0, 1.2, 1.2, 1.2, "#2a1f29");
    const dish = new THREE.Group();
    const bowl = new THREE.Mesh(
      new THREE.CylinderGeometry(1.7, 0.5, 0.5, 18, 1, true),
      new THREE.MeshLambertMaterial({ color: "#d9cfe0", side: THREE.DoubleSide }),
    );
    bowl.rotation.x = -0.9;
    bowl.position.y = 0.9;
    const tip = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 10, 8),
      new THREE.MeshBasicMaterial({ color: p.color }),
    );
    tip.position.set(0, 1.5, 0.6);
    const beam = new THREE.Mesh(
      new THREE.ConeGeometry(2.2, 9, 18, 1, true),
      new THREE.MeshBasicMaterial({
        color: p.color,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    beam.rotation.x = -Math.PI / 2 - 0.25;
    beam.position.set(0, 2.2, 4.8);
    dish.add(bowl, tip, beam);
    dish.position.y = top + 1.2;
    spin = dish;
    extras.add(dish);
  } else if (p.id === "holder") {
    for (const sx of [-1, 1])
      v.box(sx * (doorW / 2 + 1.1), base, D / 2 + 0.9, 0.6, 3.4, 0.6, "#c9a75a").box(
        sx * (doorW / 2 + 1.1),
        base + 3.4,
        D / 2 + 0.9,
        0.9,
        0.25,
        0.9,
        p.color,
        true,
      );
    v.box(0, base + 3.65, D / 2 + 0.9, doorW + 3.2, 0.25, 1, "#c9a75a");
    const coin = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 0.3, 24), [
      new THREE.MeshBasicMaterial({ color: "#c9a75a" }),
      new THREE.MeshBasicMaterial({ map: signTexture("$", p.color) }),
      new THREE.MeshBasicMaterial({ color: "#ffd166" }),
    ]);
    coin.rotation.x = Math.PI / 2;
    const holderCoin = new THREE.Group();
    holderCoin.add(coin);
    holderCoin.position.y = top + 1.8;
    spin = holderCoin;
    extras.add(holderCoin);
  } else if (p.id === "mcp") {
    v.box(0, top, 0, 0.35, 4.2, 0.35, "#3a3f55");
    for (let k = 0; k < 3; k++)
      v.box(0, top + 1.2 + k * 1.1, 0, 2.2 - k * 0.5, 0.14, 0.14, "#6f7a99");
    const light = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 12, 10),
      new THREE.MeshBasicMaterial({ color: p.color }),
    );
    light.position.y = top + 4.45;
    blink = light;
    extras.add(light);
    // a plug on the front wall
    v.box(0, base + 3.2, D / 2 + 0.06, 1.6, 1.1, 0.12, "#1b2030")
      .box(-0.35, base + 4.3, D / 2 + 0.06, 0.18, 0.6, 0.1, p.color, true)
      .box(0.35, base + 4.3, D / 2 + 0.06, 0.18, 0.6, 0.1, p.color, true);
  }

  // rooftop machinery
  const R2 = rng(500 + i);
  if (p.id !== "scanner" && p.id !== "study") {
    const ax = -W / 2 + 1.4 + R2() * 1.2,
      az = -D / 2 + 1.3;
    v.box(ax, top, az, 1.2, 0.75, 0.9, "#7d7684").box(
      ax,
      top + 0.75,
      az,
      1.0,
      0.06,
      0.7,
      "#5c5562",
    );
    v.box(ax + 0.62, top + 0.15, az, 0.04, 0.45, 0.6, "#2a2430");
  }
  if (p.id === "study" || p.id === "data") {
    const tx = W / 2 - 1.3,
      tz = -D / 2 + 1.3;
    for (const [lx, lz] of [
      [-0.4, -0.4],
      [0.4, -0.4],
      [-0.4, 0.4],
      [0.4, 0.4],
    ] as const)
      v.box(tx + lx, top, tz + lz, 0.1, 0.8, 0.1, "#3a3036");
    const tank = new THREE.Mesh(
      new THREE.CylinderGeometry(0.62, 0.62, 1.2, 16),
      new THREE.MeshStandardMaterial({
        color: "#6b5248",
        roughness: 0.8,
        bumpMap: tex.bump,
        bumpScale: 1,
      }),
    );
    tank.position.set(tx, top + 1.4, tz);
    const cap = new THREE.Mesh(
      new THREE.ConeGeometry(0.7, 0.45, 16),
      new THREE.MeshStandardMaterial({ color: "#4a3a34", roughness: 0.8 }),
    );
    cap.position.set(tx, top + 2.22, tz);
    extras.add(tank, cap);
  }
  if (p.id === "study" || p.id === "holder") {
    // a striped awning over the door
    for (let k = 0; k < 6; k++) {
      const awn = new THREE.Mesh(
        new THREE.BoxGeometry((doorW + 1.2) / 6, 0.08, 1.1),
        new THREE.MeshStandardMaterial({ color: k % 2 ? "#f4eee6" : p.color, roughness: 0.85 }),
      );
      awn.position.set(
        -((doorW + 1.2) / 2) + ((k + 0.5) * (doorW + 1.2)) / 6,
        base + 3.05,
        D / 2 + 0.55,
      );
      awn.rotation.x = 0.32;
      extras.add(awn);
    }
  }
  // flower boxes under the ground-floor windows
  for (const x of [-W / 2 + 1.1, W / 2 - 1.1])
    if (Math.abs(x) > doorW / 2 + 0.6 && p.id !== "scanner") {
      v.box(x, base + 0.45, D / 2 + 0.2, 0.9, 0.22, 0.28, "#4a3a34");
      for (let k = 0; k < 4; k++)
        v.box(
          x - 0.33 + k * 0.22,
          base + 0.67,
          D / 2 + 0.2,
          0.16,
          0.16,
          0.16,
          ["#ff8fc0", "#ffd166", "#b48cff", "#7ed9a0"][k]!,
          true,
        );
    }

  const group = v.build();
  group.add(wall, roof, extras);
  // the sign above the door
  const signW = Math.min(W - 0.6, 5.2);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(signW, signW / 4),
    new THREE.MeshBasicMaterial({ map: signTexture(p.name, p.color), transparent: true }),
  );
  sign.position.set(0, base + 2.6 + 0.35 + signW / 8, D / 2 + 0.12);
  group.add(sign);

  const a = (i / PLACES.length) * Math.PI * 2 + Math.PI / 6;
  const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
  group.position.copy(dir).multiplyScalar(BUILDING_R);
  group.rotation.y = a + Math.PI;
  group.traverse((o) => (o.userData.placeId = p.id));
  const center = group.position.clone();
  const door = center.clone().addScaledVector(dir, -(D / 2 + 1.7));
  return { place: p, group, door, center, radius: Math.max(W, D) / 2 + 0.9, spin, blink };
}

function buildTower() {
  const v = new Vox();
  v.box(0, 0, 0, 9, 0.5, 9, "#231c29").box(0, 0.5, 0, 8, 0.3, 8, "#2d2434");
  const sections: Array<[number, number]> = [
    [6, 7],
    [5, 6],
    [4, 5],
  ];
  let y = 0.8;
  const towerTex = wallTexture("panel", "#4a3352", 77);
  const towerParts: THREE.Mesh[] = [];
  for (const [s, h] of sections) {
    const mapR = towerTex.map.clone();
    mapR.repeat.set(s / 3, h / 3);
    mapR.needsUpdate = true;
    const bumpR = towerTex.bump.clone();
    bumpR.repeat.copy(mapR.repeat);
    bumpR.needsUpdate = true;
    const part = new THREE.Mesh(
      new THREE.BoxGeometry(s, h, s),
      new THREE.MeshStandardMaterial({
        map: mapR,
        bumpMap: bumpR,
        bumpScale: 2,
        roughness: 0.6,
        metalness: 0.3,
      }),
    );
    part.position.y = y + h / 2;
    towerParts.push(part);
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        v.box((sx * s) / 2, y, (sz * s) / 2, 0.22, h, 0.22, "#ff4f9a", true);
    for (let k = 1; k < h; k += 1.5)
      for (const side of [-1, 1]) {
        v.box(0, y + k, (side * s) / 2 + side * 0.03, s - 1, 0.1, 0.06, "#b48cff", true);
        v.box((side * s) / 2 + side * 0.03, y + k, 0, 0.06, 0.1, s - 1, "#b48cff", true);
      }
    y += h;
    v.box(0, y, 0, s + 0.6, 0.3, s + 0.6, "#1a1520");
    y += 0.3;
  }
  v.box(0, y, 0, 1, 2.2, 1, "#2b1f30").box(0, y + 2.2, 0, 0.5, 0.5, 0.5, "#ff4f9a", true);
  const group = v.build();
  group.add(...towerParts);
  // "$MOFU" signs on all four sides
  for (let k = 0; k < 4; k++) {
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(4.6, 1.15),
      new THREE.MeshBasicMaterial({ map: signTexture("$MOFU", "#ff4f9a"), transparent: true }),
    );
    const a = (k * Math.PI) / 2;
    sign.position.set(Math.sin(a) * 3.07, 4.2, Math.cos(a) * 3.07);
    sign.rotation.y = a;
    group.add(sign);
  }
  const statue = new THREE.Group();
  statue.add(mascotMesh(0.13));
  statue.position.y = y + 2.9;
  group.add(statue);
  const halo = glowSprite("rgba(255,79,154,0.9)", 9, 0.5);
  halo.position.y = y + 4.4;
  group.add(halo);
  group.traverse((o) => (o.userData.placeId = "tower"));
  return { group, statue, top: y };
}

// ---------------------------------------------------------------- top holders on the tower
interface Holder {
  address: string;
  balance: string;
  percent: number;
  kind: "wallet" | "contract" | "burn";
}
type HoldersResponse = { status: "ok"; holders: Holder[] } | { status: "unavailable" };

function holderCard(rank: number | null, h: Holder | null, message?: string) {
  return canvasTexture(512, 176, (x) => {
    x.fillStyle = "rgba(18,15,16,0.92)";
    x.beginPath();
    x.roundRect(4, 4, 504, 168, 26);
    x.fill();
    const g = x.createLinearGradient(0, 0, 512, 176);
    g.addColorStop(0, "#ffc2dc");
    g.addColorStop(0.45, "#ff4f9a");
    g.addColorStop(1, "#b48cff");
    x.strokeStyle = g;
    x.lineWidth = 5;
    x.stroke();
    x.textBaseline = "middle";
    if (!h) {
      x.textAlign = "center";
      x.font = '600 44px "Pixelify Sans"';
      x.fillStyle = "#f4f0f1";
      x.fillText("TOP $MOFU HOLDERS", 256, 66);
      x.font = '34px "VT323"';
      x.fillStyle = "#a8a0a3";
      x.fillText(message ?? "coming soon", 256, 122);
      return;
    }
    x.textAlign = "left";
    x.font = '64px "VT323"';
    x.fillStyle = "#ff4f9a";
    x.shadowColor = "#ff4f9a";
    x.shadowBlur = 14;
    x.fillText(`#${rank}`, 28, 70);
    x.shadowBlur = 0;
    x.font = '40px "VT323"';
    x.fillStyle = "#f4f0f1";
    x.fillText(`${h.address.slice(0, 6)}…${h.address.slice(-4)}`, 150, 62);
    x.font = '500 26px "DM Sans"';
    x.fillStyle = "#a8a0a3";
    const label =
      h.kind === "burn" ? "burned" : h.kind === "contract" ? "contract (pool or curve)" : "wallet";
    x.fillText(label, 150, 116);
    x.textAlign = "right";
    x.font = '600 44px "Pixelify Sans"';
    x.fillStyle = h.kind === "burn" ? "#a8a0a3" : "#ffd166";
    x.fillText(`${h.percent < 0.01 ? "<0.01" : h.percent.toFixed(2)}%`, 486, 92);
  });
}

// ---------------------------------------------------------------- main
async function main() {
  const loading = byId("loading");
  const hint = byId("hint");
  hint.textContent = coarse
    ? "Tap to walk · swipe to look around · tap a building to go there"
    : "WASD or arrows to walk · drag to look · click a building to go there";
  if (!webglAvailable()) {
    loading.classList.add("done");
    placesPanel.hidden = false;
    placesToggle.setAttribute("aria-expanded", "true");
    hint.textContent = "This browser can't show 3D. Pick a place from the list.";
    return;
  }
  await Promise.all([
    document.fonts.load('600 60px "Pixelify Sans"'),
    document.fonts.load('40px "VT323"'),
    document.fonts.load('500 26px "DM Sans"'),
  ]).catch(() => undefined);

  const canvas = byId<HTMLCanvasElement>("town");
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.5 : 2));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#0d0a12");
  scene.fog = new THREE.Fog("#140e1c", 38, 125);
  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 500);

  // sky dome
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(300, 24, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {},
      vertexShader:
        "varying float h; void main(){ h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader:
        "varying float h; void main(){ vec3 low = vec3(0.16,0.07,0.17); vec3 mid = vec3(0.07,0.04,0.12); vec3 top = vec3(0.02,0.015,0.04); vec3 c = mix(low, mid, smoothstep(-0.05,0.25,h)); c = mix(c, top, smoothstep(0.25,0.9,h)); gl_FragColor = vec4(c,1.0); }",
    }),
  );
  scene.add(sky);

  // stars and moon
  {
    const R = rng(7);
    const pos: number[] = [];
    for (let i = 0; i < 700; i++) {
      const th = R() * Math.PI * 2,
        ph = Math.acos(R() * 0.92);
      pos.push(
        Math.sin(ph) * Math.cos(th) * 280,
        Math.cos(ph) * 280,
        Math.sin(ph) * Math.sin(th) * 280,
      );
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    scene.add(
      new THREE.Points(
        g,
        new THREE.PointsMaterial({
          color: "#efe6ff",
          size: 1.6,
          sizeAttenuation: false,
          fog: false,
        }),
      ),
    );
    const moon = glowSprite("rgba(255,230,245,1)", 26, 0.95);
    moon.position.set(-120, 140, -180);
    (moon.material as THREE.SpriteMaterial).fog = false;
    scene.add(moon);
  }

  scene.add(new THREE.HemisphereLight("#9c8ce8", "#22142c", 1.35));
  const moonLight = new THREE.DirectionalLight("#cfc6ff", 1.35);
  moonLight.position.set(-40, 60, -30);
  moonLight.castShadow = true;
  moonLight.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
  Object.assign(moonLight.shadow.camera, {
    left: -38,
    right: 38,
    top: 38,
    bottom: -38,
    near: 5,
    far: 160,
  });
  moonLight.shadow.bias = -0.0006;
  moonLight.shadow.normalBias = 0.04;
  scene.add(moonLight);

  // ground: dark tiles, a lighter plaza, glowing rings and paths
  {
    const tiles = canvasTexture(64, 64, (x) => {
      x.fillStyle = "#1a1420";
      x.fillRect(0, 0, 64, 64);
      x.fillStyle = "#231b2b";
      x.fillRect(2, 2, 28, 28);
      x.fillRect(34, 34, 28, 28);
      x.fillStyle = "#1e1725";
      x.fillRect(34, 2, 28, 28);
      x.fillRect(2, 34, 28, 28);
    });
    void tiles;
    const pave = pavingTexture(5, "#241d2b");
    pave.map.repeat.set(36, 36);
    pave.bump.repeat.set(36, 36);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(240, 240),
      new THREE.MeshStandardMaterial({
        map: pave.map,
        bumpMap: pave.bump,
        bumpScale: 1.4,
        roughness: 0.82,
      }),
    );
    ground.receiveShadow = true;
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    const plazaTex = canvasTexture(64, 64, (x) => {
      x.fillStyle = "#2a2131";
      x.fillRect(0, 0, 64, 64);
      x.fillStyle = "#33283b";
      x.fillRect(3, 3, 26, 26);
      x.fillRect(35, 35, 26, 26);
      x.fillStyle = "#2e2436";
      x.fillRect(35, 3, 26, 26);
      x.fillRect(3, 35, 26, 26);
    });
    void plazaTex;
    const plazaPave = pavingTexture(9, "#3a2f42");
    plazaPave.map.repeat.set(14, 14);
    plazaPave.bump.repeat.set(14, 14);
    const plaza = new THREE.Mesh(
      new THREE.CircleGeometry(PLAZA_R, 64),
      new THREE.MeshStandardMaterial({
        map: plazaPave.map,
        bumpMap: plazaPave.bump,
        bumpScale: 1.6,
        roughness: 0.7,
      }),
    );
    plaza.receiveShadow = true;
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.y = 0.01;
    scene.add(plaza);
    const ring = (r0: number, r1: number, color: string, opacity: number) => {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(r0, r1, 96),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.03;
      scene.add(m);
    };
    ring(PLAZA_R - 0.35, PLAZA_R, "#ff4f9a", 0.55);
    ring(7.4, 7.7, "#b48cff", 0.45);
    ring(11.6, 11.8, "#ff4f9a", 0.25);
  }

  // buildings
  const places = PLACES.map(buildPlace);
  for (const b of places) {
    scene.add(b.group);
    shadowsOn(b.group);
    const light = new THREE.PointLight(b.place.color, 22, 13, 1.6);
    light.position.copy(b.door).setY(3);
    scene.add(light);
    // a glowing path from the plaza ring to the door
    const dir = b.center.clone().normalize();
    const len = BUILDING_R - 7.7 - 3.2;
    const path = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, len),
      new THREE.MeshBasicMaterial({
        color: b.place.color,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
      }),
    );
    path.rotation.x = -Math.PI / 2;
    path.rotation.z = -Math.atan2(dir.x, dir.z);
    path.position
      .copy(dir)
      .multiplyScalar(7.7 + len / 2)
      .setY(0.025);
    scene.add(path);
  }

  // the tower
  const tower = buildTower();
  scene.add(tower.group);
  shadowsOn(tower.group);
  const towerLight = new THREE.PointLight("#ff4f9a", 30, 16, 1.5);
  towerLight.position.set(0, 4, 0);
  scene.add(towerLight);

  // lamps, trees and a distant skyline, merged
  {
    const v = new Vox();
    const lampHeads: THREE.Vector3[] = [];
    for (let k = 0; k < 12; k++) {
      const a = ((k + 0.5) / 12) * Math.PI * 2;
      const x = Math.sin(a) * 12.6,
        z = Math.cos(a) * 12.6;
      v.box(x, 0, z, 0.22, 3.2, 0.22, "#3a3140").box(
        x,
        3.2,
        z,
        0.6,
        0.35,
        0.6,
        k % 2 ? "#ffd9a8" : "#ff8fc0",
        true,
      );
      lampHeads.push(new THREE.Vector3(x, 3.4, z));
    }
    const R = rng(31);
    for (let k = 0; k < PLACES.length; k++) {
      const a = ((k + 0.5) / PLACES.length) * Math.PI * 2 + Math.PI / 6;
      for (const r of [22.5, 24.8]) {
        const x = Math.sin(a + (R() - 0.5) * 0.15) * r,
          z = Math.cos(a + (R() - 0.5) * 0.15) * r;
        const h = 1.2 + R() * 1.2;
        v.box(x, 0, z, 0.5, h, 0.5, "#3b2a2a");
        const leaf = ["#2f5a55", "#3d3a6b", "#5a2f55"][Math.floor(R() * 3)]!;
        v.box(x, h, z, 2.4, 1.3, 2.4, leaf)
          .box(x, h + 1.3, z, 1.7, 1.1, 1.7, leaf)
          .box(x, h + 2.4, z, 0.9, 0.8, 0.9, leaf);
      }
    }
    for (let k = 0; k < 70; k++) {
      const a = (k / 70) * Math.PI * 2 + R() * 0.05;
      const r = 52 + R() * 22,
        w = 4 + R() * 6,
        h = 6 + R() * 26;
      const x = Math.sin(a) * r,
        z = Math.cos(a) * r;
      v.box(x, 0, z, w, h, w, R() > 0.5 ? "#1d1724" : "#221a2a");
      for (let y = 2; y < h - 1; y += 2.2)
        if (R() > 0.62)
          v.box(
            x,
            y,
            z + (z > 0 ? -w / 2 - 0.05 : w / 2 + 0.05),
            w * 0.6,
            0.5,
            0.1,
            R() > 0.8 ? "#ff8fc0" : "#ffd9a8",
            true,
          );
    }
    const props = v.build();
    shadowsOn(props);
    scene.add(props);
    for (const p of lampHeads) {
      const halo = glowSprite("rgba(255,190,220,0.8)", 3.2, 0.55);
      halo.position.copy(p);
      scene.add(halo);
    }
  }

  // fireflies
  const flies = (() => {
    const R = rng(3);
    const n = reduced ? 40 : 120;
    const base: number[] = [];
    for (let i = 0; i < n; i++)
      base.push((R() - 0.5) * 56, 0.6 + R() * 5, (R() - 0.5) * 56, R() * 6.28);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    const pts = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        color: "#ffb6d8",
        size: 0.22,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    scene.add(pts);
    return { pts, base, n };
  })();

  // holder cards orbiting the tower
  const cards = new THREE.Group();
  scene.add(cards);
  const cardSprites: THREE.Sprite[] = [];
  const setCards = (list: Array<{ tex: THREE.Texture; address?: string }>) => {
    for (const s of cardSprites) {
      (s.material as THREE.SpriteMaterial).map?.dispose();
      s.material.dispose();
      cards.remove(s);
    }
    cardSprites.length = 0;
    list.forEach((c, i) => {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: c.tex, transparent: true, depthWrite: false }),
      );
      s.scale.set(5.2, 1.79, 1);
      s.userData = { index: i, count: list.length, address: c.address };
      cards.add(s);
      cardSprites.push(s);
    });
  };
  setCards([{ tex: holderCard(null, null, "loading…") }]);
  const loadHolders = async () => {
    try {
      const res = await fetch("/api/town/holders");
      const data = (await res.json()) as HoldersResponse;
      if (data.status === "ok" && data.holders.length) {
        setCards([
          { tex: holderCard(null, null, "live from Robinhood Chain") },
          ...data.holders.map((h, i) => ({ tex: holderCard(i + 1, h), address: h.address })),
        ]);
      } else setCards([{ tex: holderCard(null, null, "coming soon") }]);
    } catch {
      setCards([{ tex: holderCard(null, null, "couldn't load right now") }]);
    }
  };
  void loadHolders();
  window.setInterval(() => void loadHolders(), 120_000);

  // Mofu
  const player = new THREE.Group();
  const mofu = createMofu({ furLayers: coarse ? 12 : 20 });
  player.add(mofu.group);
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.9, 24),
    new THREE.MeshBasicMaterial({
      color: "#000000",
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.04;
  shadow.scale.set(1.25, 1, 1);
  player.add(shadow);
  player.position.set(0, 0, 9.5);
  scene.add(player);
  const playerGlow = new THREE.PointLight("#fff0f6", 14, 7, 1.6);
  playerGlow.position.set(0, 2.2, 0);
  player.add(playerGlow);

  // ---------------------------------------------------------------- input
  const keys = new Set<string>();
  let yaw = 0;
  let camYaw = 0;
  let dist = coarse ? 15 : 13;
  let target: THREE.Vector3 | null = null;
  // Mofu starts facing the camera, to say hi.
  let heading = 0;
  // Buildings and the tower as cylinders, so the camera never ends up inside a wall.
  const colliders = [
    ...places.map((b) => ({ x: b.center.x, z: b.center.z, r: b.radius + 0.4, h: 30 })),
    { x: 0, z: 0, r: 4.9, h: 40 },
  ];
  const clipCamera = (from: THREE.Vector3, to: THREE.Vector3) => {
    const dx = to.x - from.x,
      dz = to.z - from.z;
    const a = dx * dx + dz * dz;
    if (a < 1e-6) return;
    let tMin = 1;
    for (const c of colliders) {
      const fx = from.x - c.x,
        fz = from.z - c.z;
      const b = 2 * (fx * dx + fz * dz),
        cc = fx * fx + fz * fz - c.r * c.r;
      const disc = b * b - 4 * a * cc;
      if (disc < 0) continue;
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t > 0 && t < tMin && from.y + (to.y - from.y) * t < c.h) tMin = t;
    }
    if (tMin < 1) to.lerpVectors(from, to, Math.max(0.22, tMin - 0.04));
  };
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if ((e.target as HTMLElement | null)?.closest("input,textarea")) return;
    const k = e.key.toLowerCase();
    if (
      ["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "shift"].includes(k)
    ) {
      keys.add(k);
      target = null;
      if (k.startsWith("arrow")) e.preventDefault();
    }
    if ((k === "e" || k === "enter") && current) {
      location.href = current.href;
    }
  });
  window.addEventListener("keyup", (e: KeyboardEvent) => keys.delete(e.key.toLowerCase()));
  addEventListener("blur", () => keys.clear());
  canvas.addEventListener(
    "wheel",
    (e) => {
      dist = THREE.MathUtils.clamp(dist + e.deltaY * 0.01, 9, 26);
      e.preventDefault();
    },
    { passive: false },
  );

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let down: { x: number; y: number; moved: boolean; id: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!down || down.id !== e.pointerId) return;
    const dx = e.clientX - down.x;
    if (!down.moved && Math.hypot(dx, e.clientY - down.y) > 7) {
      down.moved = true;
      canvas.classList.add("dragging");
    }
    if (down.moved) {
      yaw -= (e.movementX || 0) * 0.006;
    }
  });
  canvas.addEventListener("pointerup", (e) => {
    canvas.classList.remove("dragging");
    const wasTap = down && !down.moved;
    down = null;
    if (!wasTap) return;
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const cardHit = ray.intersectObjects(cardSprites, false)[0];
    const addr = cardHit?.object.userData.address as string | undefined;
    if (addr) {
      window.open(EXPLORER + addr, "_blank", "noopener");
      return;
    }
    const hit = ray.intersectObjects([...places.map((p) => p.group), tower.group], true)[0];
    const id = hit?.object.userData.placeId as string | undefined;
    if (id === "tower") {
      target = new THREE.Vector3(0, 0, 0).addScaledVector(
        player.position.clone().setY(0).normalize(),
        6.2,
      );
      return;
    }
    const b = places.find((p) => p.place.id === id);
    if (b) {
      target = b.door.clone();
      return;
    }
    const pt = new THREE.Vector3();
    if (ray.ray.intersectPlane(groundPlane, pt)) target = pt;
  });

  // ---------------------------------------------------------------- prompt
  const prompt = byId("prompt");
  const promptKicker = byId("prompt-kicker");
  const promptTitle = byId("prompt-title");
  const promptBody = byId("prompt-body");
  const promptEnter = byId<HTMLAnchorElement>("prompt-enter");
  let current: { id: string; href: string } | null = null;
  const show = (id: string, kicker: string, title: string, bodyText: string, href: string) => {
    if (current?.id === id) return;
    current = { id, href };
    promptKicker.textContent = kicker;
    promptTitle.textContent = title;
    promptBody.textContent = bodyText;
    promptEnter.href = href;
    promptEnter.firstChild!.textContent = coarse ? "Enter " : "Enter ";
    promptEnter.querySelector("kbd")!.hidden = coarse;
    prompt.hidden = false;
  };
  const hide = () => {
    if (!current) return;
    current = null;
    prompt.hidden = true;
  };

  // ---------------------------------------------------------------- loop
  const clock = new THREE.Clock();
  const move = new THREE.Vector3();
  const camTarget = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  // Intro time advances per frame (dt is capped), so slow devices still see the whole glide.
  let introClock = 0;
  let first = true;

  const resize = () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
  };
  addEventListener("resize", resize);

  if (import.meta.env.DEV) {
    (window as unknown as { __town: unknown }).__town = {
      player,
      places,
      view: (h: number, camYawTo: number, d: number) => {
        heading = h;
        yaw = camYawTo;
        dist = d;
      },
    };
  }

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;

    // movement
    move.set(0, 0, 0);
    const fx = -Math.sin(camYaw),
      fz = -Math.cos(camYaw);
    if (keys.has("w") || keys.has("arrowup")) move.add(new THREE.Vector3(fx, 0, fz));
    if (keys.has("s") || keys.has("arrowdown")) move.add(new THREE.Vector3(-fx, 0, -fz));
    if (keys.has("a") || keys.has("arrowleft")) move.add(new THREE.Vector3(fz, 0, -fx));
    if (keys.has("d") || keys.has("arrowright")) move.add(new THREE.Vector3(-fz, 0, fx));
    if (move.lengthSq() === 0 && target) {
      move.subVectors(target, player.position).setY(0);
      if (move.length() < 0.25) {
        target = null;
        move.set(0, 0, 0);
      }
    }
    const moving = move.lengthSq() > 0;
    if (moving) {
      move.normalize();
      const speed = keys.has("shift") ? 10 : 6.5;
      player.position.addScaledVector(move, speed * dt);
      heading = Math.atan2(move.x, move.z);
    }
    // collisions: buildings, the tower, the plaza edge
    const pushOut = (cx: number, cz: number, r: number) => {
      const dx = player.position.x - cx,
        dz = player.position.z - cz;
      const d = Math.hypot(dx, dz);
      if (d < r && d > 0.0001) {
        player.position.x = cx + (dx / d) * r;
        player.position.z = cz + (dz / d) * r;
      }
    };
    for (const b of places) pushOut(b.center.x, b.center.z, b.radius);
    pushOut(0, 0, 5.1);
    const fromCenter = Math.hypot(player.position.x, player.position.z);
    if (fromCenter > PLAZA_R - 1) player.position.multiplyScalar((PLAZA_R - 1) / fromCenter);

    // facing and a little hop while walking
    let diff = heading - player.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    player.rotation.y += diff * Math.min(1, dt * 12);
    mofu.update(dt, {
      moving,
      speed: keys.has("shift") ? 1 : 0,
      happy: current !== null && !moving,
    });
    const lift = mofu.group.children[0]!.position.y;
    (shadow.material as THREE.MeshBasicMaterial).opacity = 0.38 - lift * 0.8;

    // camera follows from behind, smoothed
    camYaw += (yaw - camYaw) * Math.min(1, dt * 8);
    // On arrival the camera starts high above the tower and glides down to Mofu.
    introClock += dt;
    const intro = reduced ? 1 : THREE.MathUtils.smootherstep(introClock, 0.2, 3.2);
    const pitch = THREE.MathUtils.lerp(0.95, 0.68, intro);
    const d = THREE.MathUtils.lerp(46, dist, intro);
    camTarget.copy(player.position).add(new THREE.Vector3(0, 1.4, 0));
    camTarget.lerpVectors(new THREE.Vector3(0, 9, 0), camTarget, intro);
    camPos.set(
      camTarget.x + Math.sin(camYaw) * Math.cos(pitch) * d,
      camTarget.y + Math.sin(pitch) * d - 0.4,
      camTarget.z + Math.cos(camYaw) * Math.cos(pitch) * d,
    );
    clipCamera(camTarget, camPos);
    if (first || intro < 1) camera.position.copy(camPos);
    else camera.position.lerp(camPos, Math.min(1, dt * 5));
    camera.lookAt(camTarget);

    // animated bits
    const slow = reduced ? 0.25 : 1;
    for (const b of places) {
      if (b.spin)
        b.spin.rotation[b.place.id === "dev" ? "z" : "y"] +=
          dt * (b.place.id === "dev" ? 1.2 : 0.9) * slow;
      if (b.blink) b.blink.visible = Math.floor(t * 1.6) % 2 === 0;
    }
    tower.statue.rotation.y += dt * 0.5 * slow;
    tower.statue.position.y = tower.top + 2.9 + Math.sin(t * 1.5) * 0.2;
    cardSprites.forEach((s) => {
      const { index, count } = s.userData as { index: number; count: number };
      const a = t * 0.18 * slow + (index / count) * Math.PI * 2;
      const r = count === 1 ? 0 : 7.4;
      const y = count === 1 ? tower.top + 7.2 : 3.6 + (index / count) * 15;
      s.position.set(Math.sin(a) * r, y + Math.sin(t * 1.2 + index) * 0.15, Math.cos(a) * r);
    });
    const fp = flies.pts.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < flies.n; i++) {
      const [bx, by, bz, ph] = [
        flies.base[i * 4]!,
        flies.base[i * 4 + 1]!,
        flies.base[i * 4 + 2]!,
        flies.base[i * 4 + 3]!,
      ];
      fp.setXYZ(
        i,
        bx + Math.sin(t * 0.4 + ph) * 1.2,
        by + Math.sin(t * 0.9 + ph) * 0.5,
        bz + Math.cos(t * 0.35 + ph) * 1.2,
      );
    }
    fp.needsUpdate = true;

    // which door are we at?
    let near: (typeof places)[number] | null = null;
    let best = 3.4;
    for (const b of places) {
      const d = b.door.distanceTo(player.position.clone().setY(0));
      if (d < best) {
        best = d;
        near = b;
      }
    }
    if (near)
      show(near.place.id, near.place.kicker, near.place.name, near.place.body, near.place.href);
    else if (fromCenter < 7.6)
      show(
        "tower",
        "TOP HOLDERS",
        "$MOFU Tower",
        "The biggest $MOFU wallets, live from Robinhood Chain. Tap a card to open it in the explorer, or scan the token.",
        `/app/?scan=${MOFU_CA}`,
      );
    else hide();

    renderer.render(scene, camera);
    if (first) {
      first = false;
      loading.classList.add("done");
      window.setTimeout(() => loading.remove(), 600);
    }
  });
}

void main();
