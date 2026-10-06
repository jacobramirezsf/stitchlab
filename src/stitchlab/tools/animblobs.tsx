// Blobs - metaball interpretation: dots grow and MELT into each other
// (blur + threshold), per spot-color layer. The melt itself is the star
// dial; the working resolution is capped and buffers reused so it stays
// smooth (full resolution only for the 300ppi still).

import { makePhotoAnimTool, PAPER, easeOut, type LoadedImg } from "./photoAnim";
import { ModeButtons, RangeRow, SectionBox } from "./shared";
import { colorGrid, hex, kmeansPalette, luminanceGrid, orderMarks, styleMarks, flowField } from "../lib/interpret";

type P = {
  cols: number; k: number; invert: boolean; cutoff: number;
  minR: number; maxR: number; melt: number; seed: number;
  order: "darkness" | "sweep" | "radial" | "shuffle";
  bg: "paper" | "white" | "transparent";
};

export default makePhotoAnimTool<P>({
  defaults: {
    cols: 64, k: 2, invert: false, cutoff: 0.12,
    minR: 0.14, maxR: 0.52, melt: 0.5, seed: 7, order: "radial", bg: "paper",
  },
  emptyHint: "Drop a photo - it melts together out of blobs, per color.",
  build(img: LoadedImg, p) {
    const like = { data: img.data, width: img.width, height: img.height };
    const lum = luminanceGrid(like, p.cols);
    const paletteRgb = kmeansPalette(like, p.k, p.seed);
    const colors = paletteRgb.map(hex);
    const col = colorGrid(like, p.cols, paletteRgb);
    const marks = orderMarks(
      styleMarks("blobs", lum, col, flowField(lum), {
        cutoff: p.cutoff, invert: p.invert, minR: p.minR, maxR: p.maxR,
        jitter: 0.35, density: 1, glyphs: [], seed: p.seed,
      }),
      p.order, p.seed
    );
    const aspect = img.height / img.width;
    let scratch: { c: HTMLCanvasElement; w: number; h: number } | null = null;
    return {
      aspect,
      info: `${marks.length.toLocaleString()} blobs · ${colors.length} colors`,
      draw(ctx, W, t, fullRes = false) {
        const H = Math.round(W * aspect);
        ctx.clearRect(0, 0, W, H);
        if (p.bg !== "transparent") {
          ctx.fillStyle = p.bg === "paper" ? PAPER : "#ffffff";
          ctx.fillRect(0, 0, W, H);
        }
        const at = Math.min(1, t);
        const bw = fullRes ? W : Math.min(360, W);
        const bh = Math.round(bw * aspect);
        if (!scratch || scratch.w !== bw || scratch.h !== bh) {
          const c = document.createElement("canvas");
          c.width = bw; c.height = bh;
          scratch = { c, w: bw, h: bh };
        }
        const octx = scratch.c.getContext("2d", { willReadFrequently: true })!;
        for (let ci = 0; ci < colors.length; ci++) {
          const layer = marks.filter((m) => m.colorIdx === ci);
          if (!layer.length) continue;
          octx.save();
          octx.setTransform(1, 0, 0, 1, 0, 0);
          octx.filter = "none";
          octx.clearRect(0, 0, bw, bh);
          octx.filter = `blur(${Math.max(1, (p.melt * bw) / 90)}px)`;
          octx.fillStyle = "#000";
          for (const m of layer) {
            if (m.order > at) continue;
            const born = at >= 1 ? 1 : Math.min(1, (at - m.order) * 12 + 0.1);
            const r = Math.max(0.4, m.r * bw * easeOut(born));
            octx.beginPath();
            octx.arc(m.x * bw, m.y * bh, r, 0, Math.PI * 2);
            octx.fill();
          }
          octx.restore();
          const id = octx.getImageData(0, 0, bw, bh);
          const px = id.data;
          const n = parseInt(colors[ci].slice(1), 16);
          const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
          for (let i = 0; i < px.length; i += 4) {
            const on = px[i + 3] > 110;
            px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = on ? 255 : 0;
          }
          octx.putImageData(id, 0, 0);
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(scratch.c, 0, 0, bw, bh, 0, 0, W, H);
        }
      },
    };
  },
  Controls({ p, set }) {
    return (
      <>
        <SectionBox eyebrow="Blobs">
          <RangeRow label="Detail" value={p.cols} min={24} max={140} step={4} onChange={(v) => set({ cols: v })} />
          <RangeRow label="Colors" value={p.k} min={1} max={6} step={1} onChange={(v) => set({ k: v })} />
          <RangeRow label="Melt" value={p.melt} min={0.1} max={1} step={0.05} onChange={(v) => set({ melt: v })} fmt={(v) => v.toFixed(2)} />
          <RangeRow label="Min size" value={p.minR} min={0.05} max={0.35} step={0.01} onChange={(v) => set({ minR: v })} fmt={(v) => v.toFixed(2)} />
          <RangeRow label="Max size" value={p.maxR} min={0.25} max={0.8} step={0.01} onChange={(v) => set({ maxR: v })} fmt={(v) => v.toFixed(2)} />
          <RangeRow label="Cutoff" value={p.cutoff} min={0} max={0.5} step={0.02} onChange={(v) => set({ cutoff: v })} fmt={(v) => v.toFixed(2)} />
          <RangeRow label="Seed" value={p.seed} min={1} max={99} step={1} onChange={(v) => set({ seed: v })} />
          <label className="flex items-center gap-2 text-[0.75rem] text-mid cursor-pointer">
            <input type="checkbox" checked={p.invert} onChange={(e) => set({ invert: e.target.checked })} className="accent-fg" />
            Light subject on dark photo
          </label>
        </SectionBox>
        <SectionBox eyebrow="Assembly">
          <ModeButtons
            options={[["radial", "Radial"], ["darkness", "Darkest first"], ["sweep", "Sweep"], ["shuffle", "Shuffle"]] as const}
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
