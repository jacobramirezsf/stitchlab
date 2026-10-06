// Stitch Lab tool: Cross-Stitch V3 - the fullest-control chart maker, and a
// notably higher-quality stitch file than V1/V2.
//
// Rendering upgrades (better DST):
//   • Travel-ordered crosses. V2 emitted every diagonal as its own segment, so
//     the machine jumped before each one. V3 orders every color's crosses by a
//     nearest-neighbour walk, so consecutive stitches are adjacent - far fewer,
//     far shorter jumps, cleaner backs, fewer thread breaks.
//   • Backstitch outlines. An optional running-stitch outline traced around the
//     color regions (chained into long continuous strokes) - the crisp
//     definition that separates a real cross-stitch from a blocky one.
// More control:
//   • Image pre-adjust: brightness, contrast, saturation before quantizing.
//   • Palette editing: swap any color's cone, or merge a color into its nearest
//     neighbour to shrink the palette exactly how you want.
//   • Export as DST or Brother PES (via PreviewRail).
//
// The color engine (quantizeV2) and cross geometry (crossesV2) are reused from
// V2; V1/V2 are untouched. The V3-specific pieces (adjustColor, remapQuant) are
// pure and Node-tested.

import { useEffect, useMemo, useState } from "react";
import {
  ToolLayout,
  SectionBox,
  RangeRow,
  ThreadSelect,
  DropZone,
  PreviewRail,
  buildDesign,
  useDebounced,
  LABEL,
} from "./shared";
import { quantizeV2, crossesV2, type QuantV2, type PaletteEntry } from "./crossstitch2";
import { backstitchOutlines } from "./crossstitch";
import { orderStrokesByTravel } from "../lib/routing";
import { pathGroupsToStitches, resamplePath, type PathMm } from "../lib/generators";
import { THREADS } from "../../data/threads";

// ─── Pure: image pre-adjust ──────────────────────────────────────────────

/** Brightness / contrast / saturation on an RGBA buffer, before quantizing.
 *  brightness ∈ [-0.3,0.3] (signed lift), contrast around 128, saturation
 *  1 = unchanged. Pure; alpha is preserved. */
export function adjustColor(
  rgb: Uint8ClampedArray,
  o: { brightness?: number; contrast?: number; saturation?: number },
): Uint8ClampedArray {
  const br = (o.brightness ?? 0) * 255;
  const c = o.contrast ?? 1;
  const sat = o.saturation ?? 1;
  if (br === 0 && c === 1 && sat === 1) return rgb;
  const out = new Uint8ClampedArray(rgb.length);
  for (let i = 0; i < rgb.length; i += 4) {
    let r = (rgb[i] - 128) * c + 128 + br;
    let g = (rgb[i + 1] - 128) * c + 128 + br;
    let b = (rgb[i + 2] - 128) * c + 128 + br;
    if (sat !== 1) {
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      r = L + (r - L) * sat;
      g = L + (g - L) * sat;
      b = L + (b - L) * sat;
    }
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = rgb[i + 3];
  }
  return out;
}

// ─── Pure: apply palette swaps + merges → remapped quant ─────────────────

/** Apply per-index cone overrides and merges (source index → target index) to a
 *  quantized result, compacting the surviving palette and remapping grid + sub.
 *  Pure. */
export function remapQuant(
  q: QuantV2,
  merges: Record<number, number>,
  overrides: Record<number, PaletteEntry>,
): QuantV2 {
  const n = q.palette.length;
  const palette0 = q.palette.map((p, i) => overrides[i] ?? p);
  // union-find over merges
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const [srcS, tgt] of Object.entries(merges)) {
    const src = Number(srcS);
    if (src >= 0 && src < n && tgt >= 0 && tgt < n) parent[find(src)] = find(tgt);
  }
  const compact: number[] = new Array(n).fill(-1);
  const survivors: number[] = [];
  for (let i = 0; i < n; i++) if (find(i) === i) { compact[i] = survivors.length; survivors.push(i); }
  const eff = (v: number) => (v < 0 ? -1 : compact[find(v)]);
  const grid = Int16Array.from(q.grid, eff);
  const sub = Int16Array.from(q.sub, eff);
  const palette = survivors.map((i) => palette0[i]);
  return { cols: q.cols, rows: q.rows, grid, sub, palette };
}

// ─── Component ───────────────────────────────────────────────────────────

const NAME = "bayside-crossstitch3";
const BACKSTITCH_DEFAULT = THREADS.find((t) => t.code === "1000")?.hex ?? "#1a1a1a";

export default function CrossStitchV3Tool() {
  const [img, setImg] = useState<{ w: number; h: number; rgb: Uint8ClampedArray } | null>(null);
  const [fileName, setFileName] = useState("");
  // color engine
  const [cols, setCols] = useState(70);
  const [k, setK] = useState(8);
  const [cellMm, setCellMm] = useState(2.5);
  const [skipLight, setSkipLight] = useState(true);
  const [lightThreshold, setLightThreshold] = useState(0.92);
  const [cleanup, setCleanup] = useState(true);
  const [fractional, setFractional] = useState(true);
  // pre-adjust
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(1);
  const [saturation, setSaturation] = useState(1);
  // palette edits
  const [overrides, setOverrides] = useState<Record<number, PaletteEntry>>({});
  const [merges, setMerges] = useState<Record<number, number>>({});
  // backstitch
  const [backstitch, setBackstitch] = useState(true);
  const [backHex, setBackHex] = useState(BACKSTITCH_DEFAULT);

  const dCols = useDebounced(cols, 200);
  const dK = useDebounced(k, 200);
  const dBright = useDebounced(brightness, 200);
  const dContrast = useDebounced(contrast, 200);
  const dSat = useDebounced(saturation, 200);

  const loadImage = async (file: File) => {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise<void>((res, rej) => { image.onload = () => res(); image.onerror = () => rej(); image.src = url; });
      const long = 260;
      const scale = long / Math.max(image.width, image.height);
      const w = Math.max(32, Math.round(image.width * scale));
      const h = Math.max(32, Math.round(image.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#ffffff"; // transparency → bare fabric
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(image, 0, 0, w, h);
      setImg({ w, h, rgb: ctx.getImageData(0, 0, w, h).data });
      setFileName(file.name);
    } finally { URL.revokeObjectURL(url); }
  };

  // Reset palette edits whenever the underlying quantization changes.
  useEffect(() => { setOverrides({}); setMerges({}); }, [img, dCols, dK, dBright, dContrast, dSat, skipLight, lightThreshold, cleanup]);

  const baseQuant = useMemo<QuantV2 | null>(() => {
    if (!img) return null;
    const adjusted = { w: img.w, h: img.h, rgb: adjustColor(img.rgb, { brightness: dBright, contrast: dContrast, saturation: dSat }) };
    return quantizeV2(adjusted, { cols: dCols, k: dK, skipLight, lightThreshold, cleanup });
  }, [img, dCols, dK, dBright, dContrast, dSat, skipLight, lightThreshold, cleanup]);

  const quant = useMemo(() => (baseQuant ? remapQuant(baseQuant, merges, overrides) : null), [baseQuant, merges, overrides]);

  const built = useMemo(() => {
    if (!quant || quant.palette.length === 0) return null;
    // Travel-order every color's crosses → minimal jumps (the DST-quality win).
    const crossGroups = crossesV2(quant, cellMm, quant.palette.length, fractional).map((g) => orderStrokesByTravel(g));
    const groups: PathMm[][] = [...crossGroups];
    if (backstitch) {
      const outline = orderStrokesByTravel(backstitchOutlines(quant, cellMm)).map((p) => resamplePath(p, Math.min(2, cellMm), 0.3));
      if (outline.length) groups.push(outline);
    }
    return buildDesign(pathGroupsToStitches(groups, 1), NAME);
  }, [quant, cellMm, fractional, backstitch]);

  const colors = useMemo(() => {
    const list = quant ? quant.palette.map((p) => p.hex) : [];
    return backstitch && built ? [...list, backHex] : list;
  }, [quant, backstitch, backHex, built]);

  const designW = quant ? quant.cols * cellMm : 0;
  const designH = quant ? quant.rows * cellMm : 0;

  // merge a palette entry into its nearest surviving neighbour (base indices)
  const mergeNearest = (effIndex: number) => {
    if (!baseQuant || !quant) return;
    // map effective index back to a base index (first base whose remap == effIndex)
    const target = quant.palette[effIndex];
    let baseIdx = -1;
    for (let i = 0; i < baseQuant.palette.length; i++) if ((overrides[i] ?? baseQuant.palette[i]).code === target.code) { baseIdx = i; break; }
    if (baseIdx < 0) return;
    // nearest other effective color by simple RGB distance
    const hexRgb = (h: string) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    const [r0, g0, b0] = hexRgb(target.hex);
    let best = -1, bd = Infinity;
    quant.palette.forEach((p, j) => { if (j === effIndex) return; const [r, g, b] = hexRgb(p.hex); const d = (r - r0) ** 2 + (g - g0) ** 2 + (b - b0) ** 2; if (d < bd) { bd = d; best = j; } });
    if (best < 0) return;
    // find a base index for the nearest target
    const nearCode = quant.palette[best].code;
    let nearBase = -1;
    for (let i = 0; i < baseQuant.palette.length; i++) if ((overrides[i] ?? baseQuant.palette[i]).code === nearCode) { nearBase = i; break; }
    if (nearBase < 0) return;
    setMerges((m) => ({ ...m, [baseIdx]: nearBase }));
  };
  const swapCone = (effIndex: number, hex: string, code: string) => {
    if (!baseQuant || !quant) return;
    const target = quant.palette[effIndex];
    let baseIdx = -1;
    for (let i = 0; i < baseQuant.palette.length; i++) if ((overrides[i] ?? baseQuant.palette[i]).code === target.code) { baseIdx = i; break; }
    if (baseIdx < 0) return;
    const t = THREADS.find((x) => x.code === code);
    setOverrides((o) => ({ ...o, [baseIdx]: { hex, code, name: t?.name ?? "" } }));
  };

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="photo">
            <DropZone onFile={(f) => void loadImage(f)} className="border border-dashed border-mid/50 px-3 py-3">
              <label className={LABEL}>Photo - or drop it here
                <input type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadImage(f); }} className="mt-1.5 block w-full text-[0.75rem] text-mid file:mr-3 file:rounded-none file:border file:border-hairline file:bg-bg file:px-3 file:py-1 file:text-[0.75rem] file:text-fg" />
              </label>
            </DropZone>
            {img && <p className="text-[0.75rem] text-mid">{fileName} - transparent and light areas become bare fabric. Nothing uploads.</p>}
          </SectionBox>

          <SectionBox eyebrow="adjust">
            <RangeRow label="Brightness" value={brightness} min={-0.3} max={0.3} step={0.01} onChange={setBrightness} fmt={(v) => (v === 0 ? "0" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(0)}`)} />
            <RangeRow label="Contrast" value={contrast} min={0.6} max={2} step={0.05} onChange={setContrast} fmt={(v) => `×${v.toFixed(2)}`} />
            <RangeRow label="Saturation" value={saturation} min={0} max={2} step={0.05} onChange={setSaturation} fmt={(v) => `×${v.toFixed(2)}`} />
          </SectionBox>

          <SectionBox eyebrow="chart">
            <RangeRow label="Stitches across" value={cols} min={24} max={140} step={2} onChange={setCols} />
            <RangeRow label="Thread colors" value={k} min={2} max={16} step={1} onChange={setK} fmt={(v) => `${v} cones`} />
            <RangeRow label="Cell size" value={cellMm} min={1.2} max={4} step={0.1} onChange={setCellMm} fmt={(v) => `${v.toFixed(1)} mm`} />
            <p className="text-[0.6875rem] text-mid tabular-nums">{designW.toFixed(0)} × {designH.toFixed(0)} mm chart</p>
            <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer"><input type="checkbox" checked={fractional} onChange={(e) => setFractional(e.target.checked)} className="accent-accent" />Fractional edges (smooth diagonals)</label>
            <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer"><input type="checkbox" checked={cleanup} onChange={(e) => setCleanup(e.target.checked)} className="accent-accent" />Confetti cleanup</label>
            <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer"><input type="checkbox" checked={skipLight} onChange={(e) => setSkipLight(e.target.checked)} className="accent-accent" />Skip light areas (bare fabric)</label>
            {skipLight && <RangeRow label="Light threshold" value={lightThreshold} min={0.5} max={1} step={0.01} onChange={setLightThreshold} fmt={(v) => `${Math.round(v * 100)}%`} />}
          </SectionBox>

          <SectionBox eyebrow="backstitch outline">
            <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer"><input type="checkbox" checked={backstitch} onChange={(e) => setBackstitch(e.target.checked)} className="accent-accent" />Outline the color regions</label>
            {backstitch && (
              <div className="flex items-center gap-2">
                <span className="text-[0.75rem] text-mid">Outline thread</span>
                <ThreadSelect value={backHex} onChange={(hex) => setBackHex(hex)} />
              </div>
            )}
            <p className="text-[0.625rem] text-mid leading-relaxed">A running-stitch line traced around every color block - crisp definition, sewn last on top.</p>
          </SectionBox>

          {quant && quant.palette.length > 0 && (
            <SectionBox eyebrow={`palette (${quant.palette.length})`}>
              <div className="space-y-1">
                {quant.palette.map((p, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-4 h-4 border border-hairline shrink-0" style={{ background: p.hex }} />
                    <span className="flex-1 text-[0.6875rem] text-mid truncate">{p.name || p.code}</span>
                    <ThreadSelect value={p.hex} onChange={(hex, code) => swapCone(i, hex, code)} />
                    {quant.palette.length > 2 && <button onClick={() => mergeNearest(i)} title="Merge into the nearest color" className="text-[0.7rem] text-mid hover:text-fg border border-hairline px-1.5 py-0.5">merge</button>}
                  </div>
                ))}
                <p className="text-[0.625rem] text-mid leading-relaxed pt-0.5">Swap any color's cone, or merge it into its nearest neighbour to shrink the palette. Changing the chart settings above resets these edits.</p>
              </div>
            </SectionBox>
          )}
        </>
      }
      preview={
        <PreviewRail built={built} colors={colors} name={NAME} emptyHint="Load a photo to build a cross-stitch chart.">
          {built && quant && (
            <p className="text-[0.6875rem] text-mid tabular-nums">
              {quant.cols}×{quant.rows} chart · {quant.palette.length} colors{backstitch ? " + outline" : ""} · {built.stats.realStitches.toLocaleString()} stitches · travel-ordered
            </p>
          )}
        </PreviewRail>
      }
    />
  );
}
