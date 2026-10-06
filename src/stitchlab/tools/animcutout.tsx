// Cutout - the zine-collage language: the photo posterized into crisp
// spot-color paper layers with optional halftone shading and grain, each
// layer dropping into the stack like cut paper.

import { makePhotoAnimTool, PAPER, easeOut, type LoadedImg } from "./photoAnim";
import { ModeButtons, RangeRow, SectionBox } from "./shared";
import { hex, kmeansPalette, luminanceGrid, rng, softColorWeights } from "../lib/interpret";

type P = {
  cols: number;
  k: number;
  invert: boolean;
  shading: boolean; // halftone dots inside each layer's darker areas
  grain: number;
  drop: number; // how far layers travel as they land
  seed: number;
  paper: "cream" | "white" | "kraft";
};

const PAPERS = { cream: PAPER, white: "#ffffff", kraft: "#e3cba5" };

export default makePhotoAnimTool<P>({
  defaults: { cols: 130, k: 3, invert: false, shading: true, grain: 0.18, drop: 0.5, seed: 7, paper: "cream" },
  emptyHint: "Drop a photo - it becomes cut-paper spot-color layers landing in a stack, zine style.",
  build(img: LoadedImg, p) {
    const like = { data: img.data, width: img.width, height: img.height };
    const paletteRgb = kmeansPalette(like, p.k, p.seed);
    const colors = paletteRgb.map(hex);
    const sep = softColorWeights(like, p.cols, paletteRgb, p.invert);
    const lum = luminanceGrid(like, p.cols);
    const aspect = img.height / img.width;
    const layerCache = new Map<number, HTMLCanvasElement[]>();
    const noise = (() => {
      const c = document.createElement("canvas");
      c.width = 128; c.height = 128;
      const ctx = c.getContext("2d")!;
      const id = ctx.createImageData(128, 128);
      const rand = rng(p.seed * 31 + 5);
      for (let i = 0; i < id.data.length; i += 4) {
        const v = (rand() * 255) | 0;
        id.data[i] = v; id.data[i + 1] = v; id.data[i + 2] = v; id.data[i + 3] = 255;
      }
      ctx.putImageData(id, 0, 0);
      return c;
    })();
    const buildLayers = (W: number): HTMLCanvasElement[] => {
      const hit = layerCache.get(W);
      if (hit) return hit;
      const H = Math.round(W * aspect);
      const cw = W / sep.cols, ch = H / sep.rows;
      const layers = sep.w.map((weights, li) => {
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = colors[li];
        // crisp cut shapes: fill cells where this layer dominates
        for (let gy = 0; gy < sep.rows; gy++) {
          for (let gx = 0; gx < sep.cols; gx++) {
            const i = gy * sep.cols + gx;
            const mine = weights[i];
            if (mine < 0.16) continue;
            let winner = true;
            for (let lj = 0; lj < sep.w.length; lj++) {
              if (lj !== li && sep.w[lj][i] > mine) { winner = false; break; }
            }
            if (!winner) continue;
            ctx.fillRect(gx * cw - 0.4, gy * ch - 0.4, cw + 0.8, ch + 0.8);
          }
        }
        if (p.shading) {
          // darker areas get a coarse halftone of deeper tone inside the layer
          ctx.globalCompositeOperation = "source-atop";
          ctx.fillStyle = "rgba(20,16,14,0.5)";
          for (let gy = 0; gy < sep.rows; gy += 2) {
            for (let gx = 0; gx < sep.cols; gx += 2) {
              const i = gy * sep.cols + gx;
              const d = p.invert ? lum.v[i] : 1 - lum.v[i];
              const extra = (d - 0.55) * 2;
              if (extra <= 0) continue;
              ctx.beginPath();
              ctx.arc((gx + 1) * cw, (gy + 1) * ch, Math.min(cw, Math.sqrt(extra) * cw * 1.1), 0, Math.PI * 2);
              ctx.fill();
            }
          }
          // paper grain inside the shapes
          if (p.grain > 0) {
            ctx.globalAlpha = p.grain;
            ctx.globalCompositeOperation = "soft-light";
            for (let ty = 0; ty < H; ty += 128)
              for (let tx = 0; tx < W; tx += 128) ctx.drawImage(noise, tx, ty);
          }
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = "source-over";
        }
        return c;
      });
      layerCache.set(W, layers);
      return layers;
    };
    const rand = rng(p.seed * 3 + 11);
    const drops = colors.map(() => ({ dx: (rand() - 0.5) * 0.3, dy: -0.35 - rand() * 0.4, rot: (rand() - 0.5) * 0.24 }));
    return {
      aspect,
      info: `${colors.length} paper layers`,
      draw(ctx, W, t) {
        const H = Math.round(W * aspect);
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = PAPERS[p.paper];
        ctx.fillRect(0, 0, W, H);
        const layers = buildLayers(W);
        const n = Math.max(1, layers.length);
        const at = Math.min(1, t);
        layers.forEach((layer, li) => {
          const t0 = li / n, t1 = (li + 1) / n;
          let a = at >= t1 ? 1 : at <= t0 ? 0 : (at - t0) / (t1 - t0);
          a = easeOut(a);
          if (a <= 0) return;
          const fly = (1 - a) * p.drop;
          ctx.save();
          ctx.globalAlpha = Math.min(1, a * 1.4);
          // a soft drop shadow sells the cut-paper stack
          ctx.shadowColor = "rgba(20,16,10,0.35)";
          ctx.shadowBlur = W / 160;
          ctx.shadowOffsetY = W / 300 + fly * W * 0.05;
          ctx.translate(W / 2 + drops[li].dx * fly * W, H / 2 + drops[li].dy * fly * H);
          ctx.rotate(drops[li].rot * fly);
          ctx.drawImage(layer, -W / 2, -H / 2);
          ctx.restore();
        });
      },
    };
  },
  Controls({ p, set }) {
    return (
      <>
        <SectionBox eyebrow="Cutout">
          <RangeRow label="Detail" value={p.cols} min={60} max={240} step={10} onChange={(v) => set({ cols: v })} />
          <RangeRow label="Layers" value={p.k} min={2} max={6} step={1} onChange={(v) => set({ k: v })} />
          <RangeRow label="Grain" value={p.grain} min={0} max={0.5} step={0.02} onChange={(v) => set({ grain: v })} fmt={(v) => v.toFixed(2)} />
          <RangeRow label="Drop" value={p.drop} min={0.1} max={1.2} step={0.05} onChange={(v) => set({ drop: v })} fmt={(v) => v.toFixed(2)} />
          <RangeRow label="Seed" value={p.seed} min={1} max={99} step={1} onChange={(v) => set({ seed: v })} />
          <label className="flex items-center gap-2 text-[0.75rem] text-mid cursor-pointer">
            <input type="checkbox" checked={p.shading} onChange={(e) => set({ shading: e.target.checked })} className="accent-fg" />
            Halftone shading inside layers
          </label>
          <label className="flex items-center gap-2 text-[0.75rem] text-mid cursor-pointer">
            <input type="checkbox" checked={p.invert} onChange={(e) => set({ invert: e.target.checked })} className="accent-fg" />
            Light subject on dark photo
          </label>
          <ModeButtons
            options={[["cream", "Cream"], ["white", "White"], ["kraft", "Kraft"]] as const}
            value={p.paper} onChange={(v) => set({ paper: v })} small
          />
        </SectionBox>
      </>
    );
  },
});
