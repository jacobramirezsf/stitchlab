// Flow Trails - the DELPHI detector language: particles advect along the
// photo's edge field (with adjustable swirl, the classic flow-field move)
// and leave glowing trails that grow over time until the subject emerges.

import { makePhotoAnimTool, PAPER, type LoadedImg } from "./photoAnim";
import { ModeButtons, RangeRow, SectionBox } from "./shared";
import { advectTrails, colorGrid, flowField, hex, kmeansPalette, luminanceGrid } from "../lib/interpret";

type P = {
  count: number; steps: number; swirl: number; width: number;
  invert: boolean; seed: number;
  look: "neon" | "ink";
  dotted: boolean;
  k: number;
};

const NEON = ["#ffd23f", "#ff5d73", "#3ec1ff", "#7cffb2", "#ff9b3f"];

export default makePhotoAnimTool<P>({
  defaults: { count: 900, steps: 90, swirl: 0.22, width: 1.4, invert: false, seed: 7, look: "neon", dotted: true, k: 3 },
  emptyHint: "Drop a photo - particle trails trace its edges like a detector event display.",
  build(img: LoadedImg, p, onProgress) {
    onProgress("Advecting particles…");
    const like = { data: img.data, width: img.width, height: img.height };
    const lum = luminanceGrid(like, 140);
    const paletteRgb = kmeansPalette(like, p.k, p.seed);
    const col = colorGrid(like, 140, paletteRgb);
    const trails = advectTrails(lum, flowField(lum), col, {
      count: p.count, steps: p.steps, stepLen: 0.8, swirl: p.swirl, seed: p.seed, invert: p.invert,
    });
    const inkColors = paletteRgb.map(hex);
    const aspect = img.height / img.width;
    // stagger: trails start at different moments so growth feels alive
    const starts = trails.map((_, i) => (i % 23) / 23 * 0.5);
    return {
      aspect,
      info: `${trails.length.toLocaleString()} trails`,
      draw(ctx, W, t) {
        const H = Math.round(W * aspect);
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = p.look === "neon" ? "#07070d" : PAPER;
        ctx.fillRect(0, 0, W, H);
        const at = Math.min(1, t);
        const sx = W / lum.cols, sy = H / lum.rows;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        if (p.look === "neon") {
          ctx.globalCompositeOperation = "lighter";
          ctx.shadowBlur = Math.max(2, W / 300);
        }
        trails.forEach((tr, ti) => {
          const local = Math.max(0, Math.min(1, (at - starts[ti]) / Math.max(0.05, 1 - starts[ti])));
          if (local <= 0) return;
          const n = tr.pts.length / 2;
          const upTo = Math.max(2, Math.round(n * local));
          const color = p.look === "neon" ? NEON[(ti + tr.colorIdx) % NEON.length] : inkColors[Math.min(inkColors.length - 1, tr.colorIdx)];
          ctx.strokeStyle = color;
          if (p.look === "neon") ctx.shadowColor = color;
          ctx.lineWidth = Math.max(0.5, (p.width * W) / 900);
          if (p.dotted && p.look === "neon") ctx.setLineDash([ctx.lineWidth * 2.2, ctx.lineWidth * 2.6]);
          else ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(tr.pts[0] * sx, tr.pts[1] * sy);
          for (let i = 1; i < upTo; i++) ctx.lineTo(tr.pts[i * 2] * sx, tr.pts[i * 2 + 1] * sy);
          ctx.stroke();
          // the particle at the trail head
          if (local < 1) {
            const hx = tr.pts[(upTo - 1) * 2] * sx, hy = tr.pts[(upTo - 1) * 2 + 1] * sy;
            ctx.save();
            ctx.setLineDash([]);
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(hx, hy, ctx.lineWidth * 1.6, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        });
        ctx.globalCompositeOperation = "source-over";
        ctx.shadowBlur = 0;
        ctx.setLineDash([]);
      },
    };
  },
  Controls({ p, set }) {
    return (
      <>
        <SectionBox eyebrow="Trails">
          <RangeRow label="Particles" value={p.count} min={100} max={2400} step={50} onChange={(v) => set({ count: v })} />
          <RangeRow label="Length" value={p.steps} min={20} max={220} step={10} onChange={(v) => set({ steps: v })} />
          <RangeRow label="Swirl" value={p.swirl} min={0} max={0.8} step={0.02} onChange={(v) => set({ swirl: v })} fmt={(v) => v.toFixed(2)} />
          <RangeRow label="Width" value={p.width} min={0.5} max={4} step={0.1} onChange={(v) => set({ width: v })} fmt={(v) => v.toFixed(1)} />
          <RangeRow label="Seed" value={p.seed} min={1} max={99} step={1} onChange={(v) => set({ seed: v })} />
          <label className="flex items-center gap-2 text-[0.75rem] text-mid cursor-pointer">
            <input type="checkbox" checked={p.invert} onChange={(e) => set({ invert: e.target.checked })} className="accent-fg" />
            Light subject on dark photo
          </label>
        </SectionBox>
        <SectionBox eyebrow="Look">
          <ModeButtons
            options={[["neon", "Neon on dark"], ["ink", "Ink on paper"]] as const}
            value={p.look} onChange={(v) => set({ look: v })} small
          />
          {p.look === "neon" && (
            <label className="flex items-center gap-2 text-[0.75rem] text-mid cursor-pointer">
              <input type="checkbox" checked={p.dotted} onChange={(e) => set({ dotted: e.target.checked })} className="accent-fg" />
              Dotted trails (detector style)
            </label>
          )}
          {p.look === "ink" && (
            <RangeRow label="Colors" value={p.k} min={1} max={5} step={1} onChange={(v) => set({ k: v })} />
          )}
        </SectionBox>
      </>
    );
  },
});
