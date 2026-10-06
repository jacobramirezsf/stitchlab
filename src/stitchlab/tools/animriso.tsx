// Riso Print - the Risograph emulation as its own tool: soft ink
// separations, the classic ink chart, grain/dot screens, multiply
// overprint, loose registration, and pass-by-pass printing as the
// animation. Now with duotone presets and paper stocks.

import { makePhotoAnimTool, easeOut, type LoadedImg } from "./photoAnim";
import { ModeButtons, RangeRow, SectionBox } from "./shared";
import { kmeansPalette, nearestRisoInk, RISO_INKS, rng, softColorWeights } from "../lib/interpret";

type P = {
  cols: number; k: number; invert: boolean;
  inks: string[] | null; // per-layer overrides
  screen: "grain" | "dots";
  misreg: number;
  paper: "white" | "cream" | "kraft";
  seed: number;
};

const PAPERS = { white: "#ffffff", cream: "#f7f5f1", kraft: "#e3cba5" };
const DUOTONES: { name: string; inks: [string, string] }[] = [
  { name: "Pink + Teal", inks: ["#ff48b0", "#00838a"] },
  { name: "Blue + Orange", inks: ["#0078bf", "#ff6c2f"] },
  { name: "Black + Fluor Pink", inks: ["#000000", "#ff48b0"] },
  { name: "Green + Purple", inks: ["#00a95c", "#765ba7"] },
];

export default makePhotoAnimTool<P>({
  defaults: { cols: 110, k: 2, invert: false, inks: null, screen: "grain", misreg: 0.35, paper: "cream", seed: 7 },
  emptyHint: "Drop a photo - it prints itself, one riso ink pass at a time, slightly out of register like the real machine.",
  build(img: LoadedImg, p) {
    const like = { data: img.data, width: img.width, height: img.height };
    const paletteRgb = kmeansPalette(like, p.k, p.seed);
    const sep = softColorWeights(like, p.cols, paletteRgb, p.invert);
    const inks = paletteRgb.map((c, i) => p.inks?.[i] ?? nearestRisoInk(c));
    const aspect = img.height / img.width;
    const layerCache = new Map<number, HTMLCanvasElement[]>();
    const buildLayers = (W: number): HTMLCanvasElement[] => {
      const hit = layerCache.get(W);
      if (hit) return hit;
      const H = Math.round(W * aspect);
      const cellW = W / sep.cols, cellH = H / sep.rows;
      const layers = sep.w.map((weights, li) => {
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = inks[li];
        const rand = rng(p.seed * 131 + li * 977);
        for (let gy = 0; gy < sep.rows; gy++) {
          for (let gx = 0; gx < sep.cols; gx++) {
            const d = weights[gy * sep.cols + gx];
            if (d <= 0.02) continue;
            if (p.screen === "dots") {
              ctx.beginPath();
              ctx.arc((gx + 0.5) * cellW, (gy + 0.5) * cellH, Math.sqrt(d) * cellW * 0.62, 0, Math.PI * 2);
              ctx.fill();
            } else {
              for (let sy = 0; sy < 3; sy++)
                for (let sx = 0; sx < 3; sx++)
                  if (rand() < d)
                    ctx.fillRect((gx + sx / 3 + rand() * 0.12) * cellW, (gy + sy / 3 + rand() * 0.12) * cellH, cellW / 2.6, cellH / 2.6);
            }
          }
        }
        return c;
      });
      layerCache.set(W, layers);
      return layers;
    };
    return {
      aspect,
      info: `${inks.length} ink pass${inks.length === 1 ? "" : "es"}`,
      draw(ctx, W, t) {
        const H = Math.round(W * aspect);
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = PAPERS[p.paper];
        ctx.fillRect(0, 0, W, H);
        const layers = buildLayers(W);
        const n = Math.max(1, layers.length);
        const randOff = rng(p.seed * 17 + 3);
        const at = Math.min(1, t);
        layers.forEach((layer, li) => {
          const ox = (randOff() - 0.5) * p.misreg * (W / 46);
          const oy = (randOff() - 0.5) * p.misreg * (W / 46);
          const t0 = li / n, t1 = (li + 1) / n;
          let a = at >= t1 ? 1 : at <= t0 ? 0 : (at - t0) / (t1 - t0);
          a = easeOut(a);
          if (a <= 0) return;
          const slide = (1 - a) * (W / 30);
          ctx.save();
          ctx.globalAlpha = 0.88 * a;
          ctx.globalCompositeOperation = "multiply";
          ctx.drawImage(layer, ox + slide, oy + slide * 0.6);
          ctx.restore();
        });
      },
    };
  },
  Controls({ p, set }) {
    return (
      <>
        <SectionBox eyebrow="Print">
          <RangeRow label="Detail" value={p.cols} min={50} max={220} step={5} onChange={(v) => set({ cols: v })} />
          <RangeRow label="Inks" value={p.k} min={1} max={4} step={1} onChange={(v) => set({ k: v, inks: null })} />
          <ModeButtons
            options={[["grain", "Grain screen"], ["dots", "Dot screen"]] as const}
            value={p.screen} onChange={(v) => set({ screen: v })} small
          />
          <RangeRow label="Misreg" value={p.misreg} min={0} max={1} step={0.05} onChange={(v) => set({ misreg: v })} fmt={(v) => v.toFixed(2)} />
          <ModeButtons
            options={[["white", "White"], ["cream", "Cream"], ["kraft", "Kraft"]] as const}
            value={p.paper} onChange={(v) => set({ paper: v })} small
          />
          <RangeRow label="Seed" value={p.seed} min={1} max={99} step={1} onChange={(v) => set({ seed: v })} />
          <label className="flex items-center gap-2 text-[0.75rem] text-mid cursor-pointer">
            <input type="checkbox" checked={p.invert} onChange={(e) => set({ invert: e.target.checked })} className="accent-fg" />
            Light subject on dark photo
          </label>
        </SectionBox>
        <SectionBox eyebrow="Inks">
          <div className="flex flex-wrap gap-1.5">
            {DUOTONES.map((d) => (
              <button
                key={d.name}
                onClick={() => set({ k: 2, inks: [...d.inks] })}
                className="border border-hairline px-2 py-1 text-[0.6875rem] text-mid hover:border-fg flex items-center gap-1.5"
              >
                <span className="w-3 h-3 rounded-full" style={{ backgroundColor: d.inks[0] }} />
                <span className="w-3 h-3 rounded-full" style={{ backgroundColor: d.inks[1] }} />
                {d.name}
              </button>
            ))}
          </div>
          {Array.from({ length: p.k }, (_, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-[0.6875rem] text-mid w-10">Ink {i + 1}</span>
              <select
                value={p.inks?.[i] ?? "auto"}
                onChange={(e) => {
                  const next = Array.from({ length: p.k }, (_, j) => p.inks?.[j] ?? "auto");
                  next[i] = e.target.value;
                  set({ inks: next.every((x) => x === "auto") ? null : next.map((x) => (x === "auto" ? RISO_INKS[0].hex : x)) });
                }}
                aria-label={`Ink ${i + 1}`}
                className="flex-1 bg-bg border border-hairline px-2 py-1 text-[0.75rem]"
              >
                <option value="auto">Auto (nearest riso ink)</option>
                {RISO_INKS.map((ink) => (
                  <option key={ink.hex} value={ink.hex}>{ink.name}</option>
                ))}
              </select>
            </div>
          ))}
          {p.inks && (
            <button onClick={() => set({ inks: null })} className="text-[0.6875rem] text-mid underline underline-offset-2 hover:text-fg">
              reset inks to auto
            </button>
          )}
        </SectionBox>
      </>
    );
  },
});
