import { useEffect, useRef } from "react";
import {
  buildMascotGrid,
  drawGrid,
  MASCOT_H as H,
  MASCOT_W as W,
  type MascotState,
} from "../../shared/sprite.js";

export type { MascotState };

interface MascotProps {
  state?: MascotState;
  /** Size of one sprite pixel in CSS pixels. */
  px?: number;
  className?: string;
}

/** Mofu, drawn from the shared sprite (see src/shared/sprite.ts). */
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
    drawGrid(ctx, buildMascotGrid(state), { px });
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
