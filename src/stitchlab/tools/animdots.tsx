// Halftone Dots - proper AM screening: each color layer gets its own screen
// ANGLE (15° separations, per print theory - avoids moiré between layers),
// a dot SHAPE (round / square / diamond / line), and dot GAIN (gamma on
// density). Dots carry assembly order, so the screen builds itself.

import { makePhotoAnimTool, PAPER, easeOut, type LoadedImg } from "./photoAnim";
import { ModeButtons, RangeRow, SectionBox } from "./shared";
import { hex, kmeansPalette, softColorWeights } from "../lib/interpret";

type P = {
  cols: number;
  k: number;
  invert: boolean;
  shape: "round" | "square" | "diamond" | "line";
  gain: number; // gamma on density
  maxR: number;
  angleOffset: number;
  order: "darkness" | "sweep" | "radial";
  bg: "paper" | "white" | "transparent";
};

// classic separations: 30°+ apart keeps layers from moiréing
const SCREEN_ANGLES = [15, 75, 0, 45, 105, 30];

type Dot = { x: number; y: number; d: number; a: number; order: number };

export default makePhotoAnimTool<P>({
  defaults: {
    cols: 80, k: 2, invert: false, shape: "round", gain: 1,
    maxR: 0.62, angleOffset: 0, order: "darkness", bg: "paper",
  },
  emptyHint: "Drop a photo - it becomes an angled halftone screen per color, like real print separations.",
  build(img: LoadedImg, p) {
    const like = { data: img.data, width: img.width, height: img.height };
    const paletteRgb = kmeansPalette(like, p.k, 7);
    const colors = paletteRgb.map(hex);
    const sep = softColorWeights(like, p.cols, paletteRgb, p.invert);
    const aspect = img.height / img.width;
    const cell = 1 / p.cols;

    // bilinear sample of a layer's weight field
    const sample = (w: Float32Array, x: number, y: number): number => {
      const gx = Math.min(sep.cols - 1.001, Math.max(0, x * sep.cols - 0.5));
      const gy = Math.min(sep.rows - 1.001, Math.max(0, (y / aspect) * sep.rows - 0.5));
      const x0 = gx | 0, y0 = gy | 0, fx = gx - x0, fy = gy - y0;
      const at = (xx: number, yy: number) => w[Math.min(sep.rows - 1, yy) * sep.cols + Math.min(sep.cols - 1, xx)];
      return (
        at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) +
        at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy
      );
    };

    // rotated lattice per layer
    const layers: Dot[][] = sep.w.map((w, li) => {
      const ang = ((SCREEN_ANGLES[li % SCREEN_ANGLES.length] + p.angleOffset) * Math.PI) / 180;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const dots: Dot[] = [];
      const R = Math.hypot(1, aspect);
      for (let v = -R; v <= R; v += cell) {
        for (let u = -R; u <= R; u += cell) {
          const x = 0.5 + u * ca - v * sa;
          const y = aspect / 2 + u * sa + v * ca;
          if (x < 0 || y < 0 || x > 1 || y > aspect) continue;
          const d = Math.pow(sample(w, x, y), p.gain);
          if (d < 0.03) continue;
          dots.push({ x, y, d, a: ang, order: 0 });
        }
      }
      // assembly order
      const keyed = dots.map((dt) => ({
        dt,
        key: p.order === "darkness" ? -dt.d : p.order === "sweep" ? dt.x + dt.y * 0.2 : Math.hypot(dt.x - 0.5, dt.y - aspect / 2),
      }));
      keyed.sort((a, b) => a.key - b.key);
      const nn = Math.max(1, keyed.length - 1);
      return keyed.map(({ dt }, i) => ({ ...dt, order: i / nn }));
    });
    const total = layers.reduce((s, l) => s + l.length, 0);

    return {
      aspect,
      info: `${total.toLocaleString()} dots · ${colors.length} screens`,
      draw(ctx, W, t) {
        const H = Math.round(W * aspect);
        ctx.clearRect(0, 0, W, H);
        if (p.bg !== "transparent") {
          ctx.fillStyle = p.bg === "paper" ? PAPER : "#ffffff";
          ctx.fillRect(0, 0, W, H);
        }
        const at = Math.min(1, t);
        layers.forEach((dots, li) => {
          ctx.fillStyle = colors[li];
          const cw = cell * W;
          for (const dt of dots) {
            if (dt.order > at) continue;
            const born = at >= 1 ? 1 : Math.min(1, (at - dt.order) * 14 + 0.15);
            const r = Math.sqrt(dt.d) * cw * p.maxR * easeOut(born);
            if (r < 0.25) continue;
            const X = dt.x * W, Y = (dt.y / aspect) * H;
            ctx.save();
            ctx.translate(X, Y);
            ctx.rotate(dt.a);
            ctx.beginPath();
            if (p.shape === "round") ctx.arc(0, 0, r, 0, Math.PI * 2);
            else if (p.shape === "square") ctx.rect(-r, -r, r * 2, r * 2);
            else if (p.shape === "diamond") { ctx.moveTo(0, -r * 1.3); ctx.lineTo(r * 1.3, 0); ctx.lineTo(0, r * 1.3); ctx.lineTo(-r * 1.3, 0); }
            else ctx.rect(-cw * 0.55, -r * 0.6, cw * 1.1, r * 1.2); // line screen
            ctx.fill();
            ctx.restore();
          }
        });
      },
    };
  },
  Controls({ p, set }) {
    return (
      <>
        <SectionBox eyebrow="Screen">
          <RangeRow label="Detail" value={p.cols} min={30} max={280} step={5} onChange={(v) => set({ cols: v })} />
          <RangeRow label="Colors" value={p.k} min={1} max={5} step={1} onChange={(v) => set({ k: v })} />
          <ModeButtons
            options={[["round", "Round"], ["square", "Square"], ["diamond", "Diamond"], ["line", "Line"]] as const}
            value={p.shape} onChange={(v) => set({ shape: v })} small
          />
          <RangeRow label="Dot gain" value={p.gain} min={0.5} max={2.2} step={0.05} onChange={(v) => set({ gain: v })} fmt={(v) => v.toFixed(2)} />
          <RangeRow label="Dot size" value={p.maxR} min={0.3} max={1} step={0.02} onChange={(v) => set({ maxR: v })} fmt={(v) => v.toFixed(2)} />
          <RangeRow label="Angle" value={p.angleOffset} min={0} max={90} step={5} onChange={(v) => set({ angleOffset: v })} fmt={(v) => `${v}°`} />
          <label className="flex items-center gap-2 text-[0.75rem] text-mid cursor-pointer">
            <input type="checkbox" checked={p.invert} onChange={(e) => set({ invert: e.target.checked })} className="accent-fg" />
            Light subject on dark photo
          </label>
        </SectionBox>
        <SectionBox eyebrow="Assembly">
          <ModeButtons
            options={[["darkness", "Darkest first"], ["sweep", "Sweep"], ["radial", "Radial"]] as const}
            value={p.order} onChange={(v) => set({ order: v })} small
          />
          <ModeButtons
            options={[["paper", "Paper"], ["white", "White"], ["transparent", "Clear"]] as const}
            value={p.bg} onChange={(v) => set({ bg: v })} small
          />
        </SectionBox>
      </>
    );
  },
});
