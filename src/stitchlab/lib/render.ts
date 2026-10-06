// Canvas stitch rendering.
//
// The look combines two open-source recipes: EmbroideryReader's baseline
// (per-color polylines, round caps/joins, thread-thickness stroke, hide
// over-long travel stitches) and stitchjs's per-segment shading (each stitch
// shaded across its width - dark edges, bright crown - so thread reads as a
// cylinder, not a flat line). Plus a Xiaolin-Wu-binned density heatmap in the
// spirit of stitchjs's DensityGrid.

import { CMD, colorBlocks, patternBounds, type ParsedPattern } from "./pattern";
import { defaultHexForBlock } from "./threadMatch";

export type ViewTransform = {
  scale: number; // canvas px per 0.1 mm unit
  offsetX: number;
  offsetY: number;
};

export function fitTransform(
  pattern: ParsedPattern,
  widthPx: number,
  heightPx: number,
  padPx = 24,
): ViewTransform {
  const b = patternBounds(pattern.stitches);
  const w = Math.max(1, b.maxX - b.minX);
  const h = Math.max(1, b.maxY - b.minY);
  const scale = Math.min((widthPx - padPx * 2) / w, (heightPx - padPx * 2) / h);
  return {
    scale,
    offsetX: (widthPx - w * scale) / 2 - b.minX * scale,
    offsetY: (heightPx - h * scale) / 2 - b.minY * scale,
  };
}

export type RenderOptions = {
  colors?: (string | null)[]; // per-block override; falls back to file/defaults
  sheen?: boolean; // per-segment crown shading (slower, prettier)
  showTravel?: boolean; // draw jump/travel moves as faint dashes
  threadMm?: number; // visual thread thickness, default 0.42 mm (40wt-ish)
  /** Draw only the first N pattern records (for animation). */
  upTo?: number;
};

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const mix = (c: number) =>
    Math.max(0, Math.min(255, Math.round(amt > 0 ? c + (255 - c) * amt : c * (1 + amt))));
  return `rgb(${mix((n >> 16) & 0xff)},${mix((n >> 8) & 0xff)},${mix(n & 0xff)})`;
}

export function blockColor(
  pattern: ParsedPattern,
  blockIndex: number,
  overrides?: (string | null)[],
): string {
  return (
    overrides?.[blockIndex] ?? pattern.blockColors[blockIndex] ?? defaultHexForBlock(blockIndex)
  );
}

export function renderPattern(
  ctx: CanvasRenderingContext2D,
  pattern: ParsedPattern,
  view: ViewTransform,
  opts: RenderOptions = {},
): void {
  const { scale, offsetX, offsetY } = view;
  const threadPx = Math.max(1, (opts.threadMm ?? 0.42) * 10 * scale);
  const tx = (x: number) => x * scale + offsetX;
  const ty = (y: number) => y * scale + offsetY;
  const limit = opts.upTo ?? Infinity;

  const blocks = colorBlocks(pattern);
  let recordIndex = 0;
  // Travel threshold: hide needle-path segments longer than ~12.2mm as jumps
  // regardless of flags (EmbroideryReader's "ugly stitch" filter).
  const uglyLen = 122 * scale;

  for (const block of blocks) {
    const color = blockColor(pattern, block.index, opts.colors);
    let prev: { x: number; y: number } | null = null;

    for (const st of block.stitches) {
      recordIndex++;
      if (recordIndex > limit) return;
      const cx = tx(st.x);
      const cy = ty(st.y);
      if (st.cmd === CMD.STITCH && prev) {
        const px = tx(prev.x);
        const py = ty(prev.y);
        const len = Math.hypot(cx - px, cy - py);
        if (len <= uglyLen) {
          if (opts.sheen && len > 0.5) {
            // Shade across the stroke: dark rails, bright crown.
            const nx = -(cy - py) / len;
            const ny = (cx - px) / len;
            const mx = (px + cx) / 2;
            const my = (py + cy) / 2;
            const g = ctx.createLinearGradient(
              mx + nx * threadPx * 0.6,
              my + ny * threadPx * 0.6,
              mx - nx * threadPx * 0.6,
              my - ny * threadPx * 0.6,
            );
            g.addColorStop(0, shade(color, -0.55));
            g.addColorStop(0.5, shade(color, 0.28));
            g.addColorStop(1, shade(color, -0.55));
            ctx.strokeStyle = g;
          } else {
            ctx.strokeStyle = color;
          }
          ctx.lineWidth = threadPx;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(cx, cy);
          ctx.stroke();
        } else if (opts.showTravel) {
          drawTravel(ctx, px, py, cx, cy, threadPx);
        }
      } else if (
        opts.showTravel &&
        prev &&
        (st.cmd === CMD.JUMP || st.cmd === CMD.SEQUIN_EJECT)
      ) {
        drawTravel(ctx, tx(prev.x), ty(prev.y), cx, cy, threadPx);
      }
      if (st.cmd !== CMD.END) prev = { x: st.x, y: st.y };
    }
  }
}

function drawTravel(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  threadPx: number,
) {
  ctx.strokeStyle = "rgba(120,118,111,0.45)";
  ctx.lineWidth = Math.max(0.75, threadPx * 0.25);
  ctx.lineCap = "butt";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.setLineDash([]);
}

// ─── Density heatmap ─────────────────────────────────────────────────────

/**
 * Bin needle-down passes on a grid (default 0.8 mm cells) and overlay a
 * translucent amber→red ramp. Returns the hottest bin's pass count.
 */
export function renderDensity(
  ctx: CanvasRenderingContext2D,
  pattern: ParsedPattern,
  view: ViewTransform,
  gridMm = 0.8,
): number {
  const b = patternBounds(pattern.stitches);
  const cell = gridMm * 10; // 0.1mm units
  const cols = Math.max(1, Math.ceil((b.maxX - b.minX) / cell));
  const rows = Math.max(1, Math.ceil((b.maxY - b.minY) / cell));
  const bins = new Float32Array(cols * rows);

  let prev: { x: number; y: number } | null = null;
  for (const st of pattern.stitches) {
    if (st.cmd === CMD.STITCH && prev) {
      // Supercover walk: accumulate every cell the segment passes through.
      const steps = Math.max(1, Math.ceil(Math.hypot(st.x - prev.x, st.y - prev.y) / (cell / 2)));
      for (let i = 0; i <= steps; i++) {
        const x = prev.x + ((st.x - prev.x) * i) / steps;
        const y = prev.y + ((st.y - prev.y) * i) / steps;
        const cx = Math.min(cols - 1, Math.max(0, Math.floor((x - b.minX) / cell)));
        const cy = Math.min(rows - 1, Math.max(0, Math.floor((y - b.minY) / cell)));
        bins[cy * cols + cx] += 1 / steps;
      }
    }
    if (st.cmd !== CMD.END) prev = { x: st.x, y: st.y };
  }

  let max = 0;
  for (const v of bins) if (v > max) max = v;
  if (max === 0) return 0;

  const { scale, offsetX, offsetY } = view;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = bins[r * cols + c];
      if (v <= 0) continue;
      const t = Math.min(1, v / max);
      const red = Math.round(200 + 55 * t);
      const green = Math.round(150 * (1 - t));
      ctx.fillStyle = `rgba(${red},${green},20,${(0.12 + 0.55 * t).toFixed(3)})`;
      ctx.fillRect(
        (b.minX + c * cell) * scale + offsetX,
        (b.minY + r * cell) * scale + offsetY,
        cell * scale + 0.5,
        cell * scale + 0.5,
      );
    }
  }
  return max;
}

// ─── Progressive animation ───────────────────────────────────────────────

/**
 * Incremental stitch-out playback. Keeps its own record cursor and draws only
 * new segments each frame, so playback cost stays constant regardless of
 * pattern size; seeking backwards clears and redraws up to the target.
 */
export class StitchAnimator {
  private drawn = 0;
  private ctx: CanvasRenderingContext2D;
  private pattern: ParsedPattern;
  private view: ViewTransform;
  private opts: RenderOptions;
  private clear: () => void;

  constructor(
    ctx: CanvasRenderingContext2D,
    pattern: ParsedPattern,
    view: ViewTransform,
    opts: RenderOptions,
    clear: () => void,
  ) {
    this.ctx = ctx;
    this.pattern = pattern;
    this.view = view;
    this.opts = opts;
    this.clear = clear;
  }

  get position(): number {
    return this.drawn;
  }

  get total(): number {
    return this.pattern.stitches.length;
  }

  seek(target: number): void {
    const clamped = Math.max(0, Math.min(this.total, Math.floor(target)));
    if (clamped < this.drawn) {
      this.clear();
      this.drawn = 0;
    }
    if (clamped > this.drawn) {
      // Draw only the missing span. renderPattern walks from the start but
      // clips by record index; for the incremental path we re-render the two
      // bounding slices via upTo windows.
      this.renderSpan(this.drawn, clamped);
      this.drawn = clamped;
    }
  }

  private renderSpan(from: number, to: number): void {
    // Simple correct approach: temporarily render with upTo=to onto the
    // existing canvas but skip segments before `from` by walking blocks
    // manually. renderPattern is cheap for spans, so reuse it with a windowed
    // pattern slice: keep positions absolute by slicing stitches with one
    // record of lead-in per block boundary.
    const slice = this.pattern.stitches.slice(Math.max(0, from - 1), to);
    const sub: ParsedPattern = { ...this.pattern, stitches: slice };
    // Preserve block color mapping: count color changes before `from` and
    // rotate the color arrays so the slice starts on the right block.
    let blockOffset = 0;
    for (let i = 0; i < Math.max(0, from - 1) && i < this.pattern.stitches.length; i++) {
      const cmd = this.pattern.stitches[i].cmd;
      if (cmd === CMD.COLOR_CHANGE || cmd === CMD.STOP) blockOffset++;
    }
    const rotate = <T,>(arr: T[] | undefined): T[] | undefined =>
      arr ? arr.slice(blockOffset) : undefined;
    sub.blockColors = rotate(this.pattern.blockColors) ?? [];
    renderPattern(this.ctx, sub, this.view, {
      ...this.opts,
      colors: rotate(this.opts.colors as string[] | undefined),
    });
  }
}
