// Contours - the photo as a topographic map: luminance sliced into bands,
// each band traced into smooth closed lines (marching squares + Chaikin)
// that draw themselves like a pen plotter.

import { makePhotoAnimTool, PAPER, type LoadedImg } from "./photoAnim";
import { ModeButtons, RangeRow, SectionBox } from "./shared";
import { chaikin, hex, kmeansPalette, luminanceGrid } from "../lib/interpret";
import { traceContours, simplifyContour } from "../../customizer/trace";

type P = {
  bands: number;
  detail: number;
  smooth: number;
  width: number;
  invert: boolean;
  look: "ink" | "bands" | "neon";
  bg: "paper" | "white" | "black" | "transparent";
};

const NEON = ["#ffd23f", "#ff5d73", "#3ec1ff", "#7cffb2", "#c792ff", "#ff9b3f"];

export default makePhotoAnimTool<P>({
  defaults: { bands: 6, detail: 130, smooth: 2, width: 1.4, invert: false, look: "ink", bg: "paper" },
  emptyHint: "Drop a photo - its light and shadow become elevation lines that plot themselves.",
  build(img: LoadedImg, p, onProgress) {
    onProgress("Tracing contours…");
    const like = { data: img.data, width: img.width, height: img.height };
    const lum = luminanceGrid(like, p.detail);
    const paletteRgb = kmeansPalette(like, Math.min(6, p.bands), 7);
    const bandColors = paletteRgb.map(hex);
    const aspect = img.height / img.width;
    // one mask + trace per band, darkest band = highest "elevation"
    type Line = { pts: { x: number; y: number }[]; band: number; len: number };
    const lines: Line[] = [];
    for (let b = 0; b < p.bands; b++) {
      const level = 0.12 + (b / p.bands) * 0.78;
      const mask = new Uint8Array(lum.cols * lum.rows);
      for (let i = 0; i < mask.length; i++) {
        if (lum.alpha[i] < 0.25) continue;
        const d = p.invert ? lum.v[i] : 1 - lum.v[i];
        mask[i] = d >= level ? 1 : 0;
      }
      const contours = traceContours(mask, lum.cols, lum.rows);
      for (const c of contours) {
        if (c.length < 6) continue;
        const simplified = simplifyContour(c, 0.6);
        const smoothed = p.smooth > 0 ? chaikin(simplified, p.smooth) : simplified;
        let len = 0;
        for (let i = 1; i < smoothed.length; i++) len += Math.hypot(smoothed[i].x - smoothed[i - 1].x, smoothed[i].y - smoothed[i - 1].y);
        if (len < 3) continue;
        lines.push({ pts: smoothed, band: b, len });
      }
    }
    // draw order: outer (light) bands first, then inward - and long lines first
    lines.sort((a, b) => a.band - b.band || b.len - a.len);
    const totalLen = lines.reduce((s, l) => s + l.len, 0) || 1;
    let acc = 0;
    const timed = lines.map((l) => {
      const start = acc / totalLen;
      acc += l.len;
      return { ...l, start, end: acc / totalLen };
    });
    return {
      aspect,
      info: `${lines.length} contour lines · ${p.bands} bands`,
      draw(ctx, W, t) {
        const H = Math.round(W * aspect);
        ctx.clearRect(0, 0, W, H);
        if (p.bg !== "transparent") {
          ctx.fillStyle = p.bg === "paper" ? PAPER : p.bg === "white" ? "#ffffff" : "#07070d";
          ctx.fillRect(0, 0, W, H);
        }
        const at = Math.min(1, t);
        const sx = W / lum.cols, sy = H / lum.rows;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.lineWidth = Math.max(0.5, (p.width * W) / 900);
        if (p.look === "neon") { ctx.shadowBlur = Math.max(2, W / 320); }
        for (const l of timed) {
          if (at <= l.start) break;
          const local = Math.min(1, (at - l.start) / Math.max(1e-6, l.end - l.start));
          const upTo = Math.max(2, Math.round(l.pts.length * local));
          const color =
            p.look === "ink" ? "#26324d"
            : p.look === "neon" ? NEON[l.band % NEON.length]
            : bandColors[Math.min(bandColors.length - 1, l.band)];
          ctx.strokeStyle = color;
          if (p.look === "neon") ctx.shadowColor = color;
          ctx.beginPath();
          ctx.moveTo(l.pts[0].x * sx, l.pts[0].y * sy);
          for (let i = 1; i < upTo; i++) ctx.lineTo(l.pts[i].x * sx, l.pts[i].y * sy);
          if (local >= 1) ctx.closePath();
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
      },
    };
  },
  Controls({ p, set }) {
    return (
      <>
        <SectionBox eyebrow="Contours">
          <RangeRow label="Bands" value={p.bands} min={2} max={14} step={1} onChange={(v) => set({ bands: v })} />
          <RangeRow label="Detail" value={p.detail} min={60} max={220} step={10} onChange={(v) => set({ detail: v })} />
          <RangeRow label="Smooth" value={p.smooth} min={0} max={4} step={1} onChange={(v) => set({ smooth: v })} />
          <RangeRow label="Line" value={p.width} min={0.5} max={4} step={0.1} onChange={(v) => set({ width: v })} fmt={(v) => v.toFixed(1)} />
          <label className="flex items-center gap-2 text-[0.75rem] text-mid cursor-pointer">
            <input type="checkbox" checked={p.invert} onChange={(e) => set({ invert: e.target.checked })} className="accent-fg" />
            Light subject on dark photo
          </label>
        </SectionBox>
        <SectionBox eyebrow="Look">
          <ModeButtons
            options={[["ink", "One ink"], ["bands", "Photo colors"], ["neon", "Neon"]] as const}
            value={p.look} onChange={(v) => set({ look: v })} small
          />
          <ModeButtons
            options={[["paper", "Paper"], ["white", "White"], ["black", "Black"], ["transparent", "Clear"]] as const}
            value={p.bg} onChange={(v) => set({ bg: v })} small
          />
        </SectionBox>
      </>
    );
  },
});
