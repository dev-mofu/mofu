import { describe, expect, it } from "vitest";
import { phaseAt, SCENARIO_MS, SCENARIOS, TIMING } from "../src/landing/demo.js";
import { CURSOR, ILLUSTRATIONS, mix, seeded } from "../src/landing/art.js";
import {
  buildMascotGrid,
  buildPeekGrid,
  MASCOT_H,
  MASCOT_W,
  PAW_ROWS,
} from "../src/shared/sprite.js";

describe("hero demo timing", () => {
  it("goes typing → working → result and wraps", () => {
    expect(phaseAt(0)).toEqual({ phase: "typing", progress: 0 });
    expect(phaseAt(TIMING.typing / 2).phase).toBe("typing");
    expect(phaseAt(TIMING.typing).phase).toBe("working");
    expect(phaseAt(TIMING.typing + TIMING.working).phase).toBe("result");
    expect(phaseAt(SCENARIO_MS - 1).phase).toBe("result");
    expect(phaseAt(SCENARIO_MS)).toEqual(phaseAt(0));
    expect(phaseAt(-1).phase).toBe("result");
  });

  it("has the three scenarios with their badges", () => {
    expect(SCENARIOS.map((s) => [s.id, s.badge])).toEqual([
      ["data", "ANALYZING"],
      ["dev", "SCANNING"],
      ["study", "STUDYING"],
    ]);
  });
});

describe("pixel art data", () => {
  it("builds the mascot in every state at the sprite's size", () => {
    for (const state of ["ready", "focus", "found"] as const) {
      const g = buildMascotGrid(state);
      expect(g).toHaveLength(MASCOT_H);
      expect(g.every((row) => row.length === MASCOT_W)).toBe(true);
    }
    expect(buildMascotGrid("focus")).not.toEqual(buildMascotGrid("ready"));
  });

  it("adds big paws under the peeking crop", () => {
    const peek = buildPeekGrid("ready", 16);
    expect(peek).toHaveLength(16 + PAW_ROWS);
    // Paw rows: top outline, fur, toes, bottom outline.
    expect(peek.at(-3)!.join("")).toContain("OWWWWO");
    expect(peek.at(-2)!.join("")).toContain("OWLWLO");
  });

  it("makes the same random scenery every time and mixes colors toward the ink", () => {
    const a = seeded(1);
    const b = seeded(1);
    expect([a(), a()]).toEqual([b(), b()]);
    const p = { ink: "255,255,255", accent: "255,79,154", bg: "0,0,0" };
    expect(mix(p, 0)).toBe("rgb(0,0,0)");
    expect(mix(p, 1)).toBe("rgb(255,255,255)");
    expect(mix(p, 0.5)).toBe("rgb(128,128,128)");
  });

  it("keeps illustration rows rectangular", () => {
    for (const [name, rows] of Object.entries({ ...ILLUSTRATIONS, cursor: CURSOR })) {
      const widths = new Set(rows.map((r) => r.length));
      expect(widths.size, name).toBe(1);
    }
  });
});
