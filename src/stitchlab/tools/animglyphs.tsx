// Glyph Weave - the photo re-typed in YOUR OWN words: a darkness ramp of
// glyphs (or the letters of a word you choose) sized and rotated along the
// photo's edges. The bull reference, personalized.

import { makePhotoAnimTool, PAPER, easeOut, type LoadedImg } from "./photoAnim";
import { ModeButtons, RangeRow, SectionBox } from "./shared";
import { colorGrid, flowField, hex, kmeansPalette, luminanceGrid, orderMarks, rng, styleMarks } from "../lib/interpret";

type P = {
  cols: number; k: number; invert: boolean; cutoff: number;
  text: string; // "" = classic density ramp
  font: "mono" | "serif" | "sans";
  followEdges: boolean;
  sizeRange: number;
  seed: number;
  order: "darkness" | "sweep" | "radial" | "shuffle";
  bg: "paper" | "white" | "black" | "transparent";
};

const RAMP = ["·", "-", "+", "x", "≡", "#"];
const FONTS = { mono: "monospace", serif: "Georgia, serif", sans: "Helvetica, Arial, sans-serif" };

export default makePhotoAnimTool<P>({
  defaults: {
    cols: 90, k: 2, invert: false, cutoff: 0.1, text: "",
    font: "mono", followEdges: true, sizeRange: 1, seed: 7, order: "sweep", bg: "paper",
  },
  emptyHint: "Drop a photo - it gets re-typed as marks, or as the letters of your own word.",
  build(img: LoadedImg, p) {
    const like = { data: img.data, width: img.width, height: img.height };
    const lum = luminanceGrid(like, p.cols);
    const paletteRgb = kmeansPalette(like, p.k, p.seed);
    const colors = paletteRgb.map(hex);
    const col = colorGrid(like, p.cols, paletteRgb);
    const glyphs = p.text.trim() ? [...p.text.trim()] : RAMP;
    const marks = orderMarks(
      styleMarks("marks", lum, col, flowField(lum), {
        cutoff: p.cutoff, invert: p.invert, minR: 0.16, maxR: 0.16 + 0.34 * p.sizeRange,
        jitter: 0.2, density: 1, glyphs, seed: p.seed,
      }),
      p.order, p.seed
    );
    // when a word is given, cycle its letters in order instead of by darkness
    if (p.text.trim()) {
      const rand = rng(p.seed);
      marks.forEach((m, i) => { m.glyph = glyphs[(i + ((rand() * glyphs.length) | 0)) % glyphs.length]; });
    }
    const aspect = img.height / img.width;
    return {
      aspect,
      info: `${marks.length.toLocaleString()} glyphs`,
      draw(ctx, W, t) {
        const H = Math.round(W * aspect);
        ctx.clearRect(0, 0, W, H);
        if (p.bg !== "transparent") {
          ctx.fillStyle = p.bg === "paper" ? PAPER : p.bg === "white" ? "#ffffff" : "#0b0b10";
          ctx.fillRect(0, 0, W, H);
        }
        const at = Math.min(1, t);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (const m of marks) {
          if (m.order > at) continue;
          const born = at >= 1 ? 1 : Math.min(1, (at - m.order) * 14 + 0.15);
          const R = m.r * W * easeOut(born);
          if (R < 0.5) continue;
          ctx.fillStyle = colors[Math.min(colors.length - 1, m.colorIdx)];
          ctx.save();
          ctx.translate(m.x * W, m.y * H);
          if (p.followEdges && m.angle !== undefined) ctx.rotate(m.angle);
          ctx.font = `${Math.max(4, R * 3.1)}px ${FONTS[p.font]}`;
          ctx.fillText(m.glyph ?? "x", 0, 0);
          ctx.restore();
        }
      },
    };
  },
  Controls({ p, set }) {
    return (
      <>
        <SectionBox eyebrow="Glyphs">
          <input
            value={p.text}
            onChange={(e) => set({ text: e.target.value.slice(0, 24) })}
            placeholder="Type a word to draw with (optional)"
            aria-label="Word whose letters draw the photo"
            className="w-full bg-bg border border-hairline px-2.5 py-1.5 text-[0.8125rem] outline-none focus:border-fg"
          />
          <ModeButtons
            options={[["mono", "Mono"], ["serif", "Serif"], ["sans", "Sans"]] as const}
            value={p.font} onChange={(v) => set({ font: v })} small
          />
          <RangeRow label="Detail" value={p.cols} min={40} max={220} step={5} onChange={(v) => set({ cols: v })} />
          <RangeRow label="Colors" value={p.k} min={1} max={5} step={1} onChange={(v) => set({ k: v })} />
          <RangeRow label="Size range" value={p.sizeRange} min={0.3} max={1.6} step={0.05} onChange={(v) => set({ sizeRange: v })} fmt={(v) => v.toFixed(2)} />
          <RangeRow label="Cutoff" value={p.cutoff} min={0} max={0.5} step={0.02} onChange={(v) => set({ cutoff: v })} fmt={(v) => v.toFixed(2)} />
          <RangeRow label="Seed" value={p.seed} min={1} max={99} step={1} onChange={(v) => set({ seed: v })} />
          <label className="flex items-center gap-2 text-[0.75rem] text-mid cursor-pointer">
            <input type="checkbox" checked={p.followEdges} onChange={(e) => set({ followEdges: e.target.checked })} className="accent-fg" />
            Letters follow the photo's edges
          </label>
          <label className="flex items-center gap-2 text-[0.75rem] text-mid cursor-pointer">
            <input type="checkbox" checked={p.invert} onChange={(e) => set({ invert: e.target.checked })} className="accent-fg" />
            Light subject on dark photo
          </label>
        </SectionBox>
        <SectionBox eyebrow="Assembly">
          <ModeButtons
            options={[["sweep", "Sweep"], ["darkness", "Darkest first"], ["radial", "Radial"], ["shuffle", "Shuffle"]] as const}
            value={p.order} onChange={(v) => set({ order: v })} small
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
