// Stipple - Secord's weighted Voronoi stippling (2002): dots rejection-
// sampled from darkness, then Lloyd-relaxed toward darkness-weighted
// centroids. The signature animation is the SETTLE: dots drift from their
// random birth positions into the perfectly-even stipple.

import { makePhotoAnimTool, PAPER, easeOut, type LoadedImg } from "./photoAnim";
import { ModeButtons, RangeRow, SectionBox } from "./shared";
import { luminanceGrid, stippleLloyd } from "../lib/interpret";

type P = {
  points: number;
  iterations: number;
  radius: number; // px at 900 wide
  sized: boolean; // radius scales with local darkness
  ink: string;
  invert: boolean;
  mode: "settle" | "fade" | "radial";
  bg: "paper" | "white" | "transparent";
  seed: number;
};

export default makePhotoAnimTool<P>({
  defaults: {
    points: 3000, iterations: 5, radius: 2.4, sized: true,
    ink: "#26324d", invert: false, mode: "settle", bg: "paper", seed: 7,
  },
  emptyHint: "Drop a photo - thousands of dots settle into a hand-stippled portrait (weighted Voronoi, the real algorithm).",
  build(img: LoadedImg, p, onProgress) {
    onProgress("Relaxing the stipple…");
    const like = { data: img.data, width: img.width, height: img.height };
    const gridCols = Math.min(220, Math.max(120, Math.round(Math.sqrt(p.points) * 3)));
    const lum = luminanceGrid(like, gridCols);
    const st = stippleLloyd(lum, p.points, p.iterations, p.seed, p.invert);
    const aspect = img.height / img.width;
    // per-dot darkness (for sized dots) from the final frame
    const final = st.frames[st.frames.length - 1];
    const dark = new Float32Array(st.count);
    for (let i = 0; i < st.count; i++) {
      const gi = Math.min(lum.rows - 1, final[i * 2 + 1] | 0) * lum.cols + Math.min(lum.cols - 1, final[i * 2] | 0);
      const d = p.invert ? lum.v[gi] : 1 - lum.v[gi];
      dark[i] = Math.max(0.25, d);
    }
    // radial order for the radial mode
    const order = new Float32Array(st.count);
    {
      const keyed = Array.from({ length: st.count }, (_, i) => ({
        i, key: Math.hypot(final[i * 2] / lum.cols - 0.5, final[i * 2 + 1] / lum.rows - 0.5),
      })).sort((a, b) => a.key - b.key);
      keyed.forEach(({ i }, rank) => { order[i] = rank / Math.max(1, st.count - 1); });
    }
    return {
      aspect,
      info: `${st.count.toLocaleString()} dots · ${p.iterations} relaxations`,
      draw(ctx, W, t) {
        const H = Math.round(W * aspect);
        ctx.clearRect(0, 0, W, H);
        if (p.bg !== "transparent") {
          ctx.fillStyle = p.bg === "paper" ? PAPER : "#ffffff";
          ctx.fillRect(0, 0, W, H);
        }
        ctx.fillStyle = p.ink;
        const at = Math.min(1, t);
        const rBase = (p.radius * W) / 900;
        // settle: interpolate through the Lloyd frames over the timeline
        const fpos = at * (st.frames.length - 1);
        const f0 = Math.min(st.frames.length - 1, fpos | 0);
        const f1 = Math.min(st.frames.length - 1, f0 + 1);
        const ft = fpos - f0;
        const A = st.frames[f0], B = st.frames[f1];
        for (let i = 0; i < st.count; i++) {
          let x: number, y: number, alpha = 1, scale = 1;
          if (p.mode === "settle") {
            x = A[i * 2] + (B[i * 2] - A[i * 2]) * ft;
            y = A[i * 2 + 1] + (B[i * 2 + 1] - A[i * 2 + 1]) * ft;
          } else {
            x = final[i * 2]; y = final[i * 2 + 1];
            if (p.mode === "fade") alpha = Math.min(1, at * 1.6 - (i / st.count) * 0.6 + 0.05);
            else {
              if (order[i] > at) continue;
              scale = easeOut(at >= 1 ? 1 : Math.min(1, (at - order[i]) * 14 + 0.15));
            }
          }
          if (alpha <= 0) continue;
          ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
          const r = rBase * (p.sized ? 0.5 + dark[i] : 1) * scale;
          ctx.beginPath();
          ctx.arc((x / lum.cols) * W, (y / lum.rows) * H, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      },
    };
  },
  Controls({ p, set }) {
    return (
      <>
        <SectionBox eyebrow="Stipple">
          <RangeRow label="Dots" value={p.points} min={500} max={8000} step={100} onChange={(v) => set({ points: v })} />
          <RangeRow label="Relax" value={p.iterations} min={0} max={9} step={1} onChange={(v) => set({ iterations: v })} />
          <RangeRow label="Dot size" value={p.radius} min={0.8} max={6} step={0.1} onChange={(v) => set({ radius: v })} fmt={(v) => v.toFixed(1)} />
          <RangeRow label="Seed" value={p.seed} min={1} max={99} step={1} onChange={(v) => set({ seed: v })} />
          <label className="flex items-center gap-2 text-[0.75rem] text-mid cursor-pointer">
            <input type="checkbox" checked={p.sized} onChange={(e) => set({ sized: e.target.checked })} className="accent-fg" />
            Size dots by darkness
          </label>
          <label className="flex items-center gap-2 text-[0.75rem] text-mid cursor-pointer">
            <input type="checkbox" checked={p.invert} onChange={(e) => set({ invert: e.target.checked })} className="accent-fg" />
            Light subject on dark photo
          </label>
        </SectionBox>
        <SectionBox eyebrow="Ink & motion">
          <div className="flex items-center gap-2 text-[0.75rem] text-mid">
            Ink
            <input type="color" value={p.ink} onChange={(e) => set({ ink: e.target.value })} aria-label="Ink color" className="w-8 h-8 border border-hairline cursor-pointer" />
          </div>
          <ModeButtons
            options={[["settle", "Settle"], ["fade", "Fade in"], ["radial", "Radial"]] as const}
            value={p.mode} onChange={(v) => set({ mode: v })} small
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
