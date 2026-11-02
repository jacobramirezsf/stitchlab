// Stitch Lab tool: Cross-Stitch V4 - one engine for clean charts and
// photoreal cross-stitch, with the controls split out the way the math is.
// The engine (lib/crossstitch4.ts) documents the method and its sources;
// this file is the shell: presets, granular controls, an inspector (chart /
// source / error map) and the shared PreviewRail for the real stitch file.
//
// V1-V3 and Photoreal are untouched; this is a parallel tool.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ToolLayout, SectionBox, RangeRow, ModeButtons, ImagePick, ThreadSelect, PreviewRail,
  buildDesign, useDebouncedKey, LABEL, Warning, type LumImg,
} from "./shared";
import { adjustColor } from "./crossstitch3";
import { pathGroupsToStitches } from "../lib/generators";
import {
  buildChart, cellErrors, coneUsage, linToHex, planStitches, prepareImage,
  type Chart, type ChartOpts, type StitchOpts,
} from "../lib/crossstitch4";

const NAME = "bayside-crossstitch4";

// ─── Presets: bundles of the granular controls ───────────────────────────

type Look = {
  sharpness: number; smoothness: number; dither: number; ditherFlatOnly: boolean; minRegion: number;
  fractional: boolean; blends: boolean; halves: boolean; maxBlendDelta: number; detailWeight: number;
  route: "continuous" | "consistent";
};
type PresetId = "clean" | "balanced" | "photoreal";
const PRESETS: Record<PresetId, Look> = {
  // Flat color regions, crisp edges, every top leg the same way.
  clean: { sharpness: 0.8, smoothness: 0.5, dither: 0, ditherFlatOnly: true, minRegion: 3, fractional: true, blends: false, halves: false, maxBlendDelta: 0.15, detailWeight: 0.5, route: "consistent" },
  // Still regions, but blended crosses add in-between tones.
  balanced: { sharpness: 0.5, smoothness: 0.25, dither: 0, ditherFlatOnly: true, minRegion: 2, fractional: true, blends: true, halves: false, maxBlendDelta: 0.15, detailWeight: 1, route: "continuous" },
  // Texture for tone: dithering in flat areas, blends and half stitches.
  photoreal: { sharpness: 0.2, smoothness: 0.08, dither: 0.6, ditherFlatOnly: true, minRegion: 1, fractional: false, blends: true, halves: true, maxBlendDelta: 0.22, detailWeight: 1.5, route: "continuous" },
};
const PRESET_LIST: readonly (readonly [PresetId | "custom", string])[] = [
  ["clean", "Clean chart"], ["balanced", "Balanced"], ["photoreal", "Photoreal"],
];

const FABRICS: readonly (readonly [string, string])[] = [
  ["#ffffff", "White"], ["#efe6d2", "Natural"], ["#2b2b2e", "Black"], ["#1f2a44", "Navy"],
];

export default function CrossStitchV4Tool() {
  const [img, setImg] = useState<LumImg | null>(null);
  const [imgName, setImgName] = useState("");
  // pre-adjust
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(1);
  const [saturation, setSaturation] = useState(1);
  // size + palette
  const [cols, setCols] = useState(80);
  const [cellMm, setCellMm] = useState(2.2);
  const [k, setK] = useState(8);
  const [metric, setMetric] = useState<"oklab" | "de2000">("oklab");
  const [toneWeight, setToneWeight] = useState(1);
  const [locked, setLocked] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<string[]>([]);
  // fabric
  const [fabricHex, setFabricHex] = useState("#ffffff");
  const [useFabric, setUseFabric] = useState(true);
  const [coverage, setCoverage] = useState(0.85);
  // look
  const [preset, setPreset] = useState<PresetId | "custom">("balanced");
  const [look, setLook] = useState<Look>(PRESETS.balanced);
  const tweak = <K extends keyof Look>(key: K, v: Look[K]) => { setLook((l) => ({ ...l, [key]: v })); setPreset("custom"); };
  const choosePreset = (p: PresetId | "custom") => { if (p !== "custom") { setPreset(p); setLook(PRESETS[p]); } };
  // stitching
  const [passes, setPasses] = useState<1 | 2>(1);
  const [locks, setLocks] = useState(true);
  const [order, setOrder] = useState<NonNullable<StitchOpts["order"]>>("light-first");
  const [minLegMm, setMinLegMm] = useState(1);
  const [sideTravel, setSideTravel] = useState(true);
  const [maxTravelCells, setMaxTravelCells] = useState(4);
  // inspector
  const [view, setView] = useState<"chart" | "source" | "error">("chart");

  const adjustKey = useDebouncedKey([brightness, contrast, saturation], 200);
  const prepared = useMemo(() => {
    if (!img) return null;
    return prepareImage({ w: img.w, h: img.h, rgb: adjustColor(img.rgb, { brightness, contrast, saturation }) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, adjustKey]);

  const chartOpts: ChartOpts = {
    cols, k, metric, toneWeight, locked, excluded, fabricHex, useFabric, coverage,
    sharpness: look.sharpness, smoothness: look.smoothness, dither: look.dither, ditherFlatOnly: look.ditherFlatOnly,
    minRegion: look.minRegion, fractional: look.fractional, blends: look.blends, halves: look.halves,
    maxBlendDelta: look.maxBlendDelta, detailWeight: look.detailWeight, edgeAware: true,
  };
  const chartKey = useDebouncedKey([JSON.stringify(chartOpts)], 220);
  const chart = useMemo<Chart | null>(() => {
    if (!prepared) return null;
    try { return buildChart(prepared, chartOpts); } catch { return null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepared, chartKey]);

  const plan = useMemo(() => {
    if (!chart || !chart.palette.length) return null;
    return planStitches(chart, { cellMm, route: look.route, passes, locks, order, minLegMm, sideTravel, maxTravelCells });
  }, [chart, cellMm, look.route, passes, locks, order, minLegMm, sideTravel, maxTravelCells]);

  const built = useMemo(() => (plan ? buildDesign(pathGroupsToStitches(plan.groups, 1), NAME) : null), [plan]);
  const usage = useMemo(() => (chart ? coneUsage(chart) : []), [chart]);

  const designW = chart ? chart.cols * cellMm : 0;
  const designH = chart ? chart.rows * cellMm : 0;
  const count = 25.4 / cellMm;
  const totalCells = chart ? chart.cols * chart.rows : 1;

  const toggleLock = (code: string) => setLocked((l) => (l.includes(code) ? l.filter((c) => c !== code) : [...l, code]));
  const exclude = (code: string) => { setExcluded((e) => [...e, code]); setLocked((l) => l.filter((c) => c !== code)); };
  // Swapping = exclude the old cone, lock the new one; the optimizer re-fits the rest.
  const swap = (oldCode: string, newCode: string) => {
    if (oldCode === newCode) return;
    setExcluded((e) => [...e.filter((c) => c !== newCode), oldCode]);
    setLocked((l) => [...l.filter((c) => c !== oldCode), newCode]);
  };

  const controls = (
    <>
      <SectionBox eyebrow="photo">
        <ImagePick onImage={(im, n) => { setImg(im); setImgName(n); setLocked([]); setExcluded([]); }} fileName={imgName} longSide={900}
          hint="Nothing uploads. Transparent areas count as bare fabric." />
        <RangeRow label="Brightness" value={brightness} min={-0.3} max={0.3} step={0.01} onChange={setBrightness} fmt={(v) => (v === 0 ? "0" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(0)}`)} />
        <RangeRow label="Contrast" value={contrast} min={0.6} max={2} step={0.05} onChange={setContrast} fmt={(v) => `×${v.toFixed(2)}`} />
        <RangeRow label="Saturation" value={saturation} min={0} max={2} step={0.05} onChange={setSaturation} fmt={(v) => `×${v.toFixed(2)}`} />
      </SectionBox>

      <SectionBox eyebrow="look">
        <ModeButtons small options={PRESET_LIST} value={preset} onChange={choosePreset} />
        <p className="text-[0.6875rem] text-mid leading-relaxed">
          {preset === "clean" && "Flat color regions with crisp edges. Every top leg points the same way."}
          {preset === "balanced" && "Clean regions, plus two-cone crosses for in-between tones."}
          {preset === "photoreal" && "Texture stands in for tone: dithering in flat areas, blended crosses, half stitches."}
          {preset === "custom" && "Custom - pick a look to reset the controls below."}
        </p>
        <RangeRow label="Smooth ↔ detailed" value={1 - look.smoothness} min={0} max={1} step={0.01} onChange={(v) => tweak("smoothness", 1 - v)} fmt={(v) => `${Math.round(v * 100)}%`} />
        <RangeRow label="Texture (dither)" value={look.dither} min={0} max={1} step={0.05} onChange={(v) => tweak("dither", v)} fmt={(v) => (v === 0 ? "off" : `${Math.round(v * 100)}%`)} />
      </SectionBox>

      <SectionBox eyebrow="size & colors">
        <RangeRow label="Stitches across" value={cols} min={24} max={200} step={2} onChange={setCols} />
        <RangeRow label="Stitch size" value={cellMm} min={1.4} max={4} step={0.1} onChange={setCellMm} fmt={(v) => `${v.toFixed(1)} mm`} />
        <p className="text-[0.6875rem] text-mid tabular-nums">
          {designW.toFixed(0)} × {designH.toFixed(0)} mm · like {count.toFixed(1)}-count fabric
        </p>
        <RangeRow label="Thread colors" value={k} min={1} max={16} step={1} onChange={setK} fmt={(v) => `${v} ${v === 1 ? "cone" : "cones"}`} />
        <RangeRow label="Favor tone ↔ hue" value={toneWeight} min={0.4} max={3} step={0.1} onChange={setToneWeight} fmt={(v) => (v > 1.05 ? `tone ×${v.toFixed(1)}` : v < 0.95 ? `hue ×${(1 / v).toFixed(1)}` : "even")} />
        <RangeRow label="Protect small details" value={look.detailWeight} min={0} max={3} step={0.1} onChange={(v) => tweak("detailWeight", v)} fmt={(v) => (v === 0 ? "off" : `×${v.toFixed(1)}`)} />
        <div>
          <div className={`${LABEL} mb-1`}>Color match</div>
          <ModeButtons small options={[["oklab", "OKLab (fast)"], ["de2000", "ΔE 2000"]] as const} value={metric} onChange={setMetric} />
        </div>
      </SectionBox>

      <SectionBox eyebrow="fabric">
        <div className="flex gap-1.5 flex-wrap">
          {FABRICS.map(([hex, label]) => (
            <button key={hex} onClick={() => setFabricHex(hex)} title={label}
              className={`flex items-center gap-1.5 border px-2 py-1 text-[0.75rem] ${fabricHex === hex ? "border-fg" : "border-hairline"}`}>
              <span className="w-3.5 h-3.5 border border-hairline" style={{ background: hex }} />{label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
          <input type="checkbox" checked={useFabric} onChange={(e) => setUseFabric(e.target.checked)} className="accent-accent" />
          Leave fabric bare where it matches
        </label>
        <RangeRow label="Thread coverage" value={coverage} min={0.6} max={1} step={0.01} onChange={setCoverage} fmt={(v) => `${Math.round(v * 100)}%`} />
        <p className="text-[0.6875rem] text-mid leading-relaxed">
          An X never covers its whole square. Colors are matched with the fabric showing between the legs, so on dark fabric the thread choices shift to compensate.
        </p>
      </SectionBox>

      <SectionBox eyebrow="detail" defaultOpen={false}>
        <RangeRow label="Edge sharpness" value={look.sharpness} min={0} max={1} step={0.05} onChange={(v) => tweak("sharpness", v)} fmt={(v) => `${Math.round(v * 100)}%`} />
        <RangeRow label="Smallest region" value={look.minRegion} min={1} max={12} step={1} onChange={(v) => tweak("minRegion", v)} fmt={(v) => (v === 1 ? "off" : `${v} stitches`)} />
        <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
          <input type="checkbox" checked={look.ditherFlatOnly} onChange={(e) => tweak("ditherFlatOnly", e.target.checked)} className="accent-accent" />
          Dither flat areas only (keep edges crisp)
        </label>
        <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
          <input type="checkbox" checked={look.fractional} onChange={(e) => tweak("fractional", e.target.checked)} className="accent-accent" />
          Fractional stitches on diagonals
        </label>
        {look.fractional && (
          <RangeRow label="Shortest leg" value={minLegMm} min={0.6} max={2} step={0.1} onChange={setMinLegMm} fmt={(v) => `${v.toFixed(1)} mm`} />
        )}
      </SectionBox>

      <SectionBox eyebrow="thread mixing" defaultOpen={false}>
        <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
          <input type="checkbox" checked={look.blends} onChange={(e) => tweak("blends", e.target.checked)} className="accent-accent" />
          Blended crosses (one leg per cone)
        </label>
        {look.blends && (
          <RangeRow label="Blend only close cones" value={look.maxBlendDelta} min={0.05} max={0.4} step={0.01} onChange={(v) => tweak("maxBlendDelta", v)} fmt={(v) => `ΔE ${(v * 100).toFixed(0)}`} />
        )}
        <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
          <input type="checkbox" checked={look.halves} onChange={(e) => tweak("halves", e.target.checked)} className="accent-accent" />
          Half stitches (one leg over fabric)
        </label>
        <p className="text-[0.6875rem] text-mid leading-relaxed">
          Each X has two legs, so one square can carry two cones or a single leg over fabric. That gives more tones from the same cones and adds no color changes.
        </p>
      </SectionBox>

      <SectionBox eyebrow="stitching" defaultOpen={false}>
        <div>
          <div className={`${LABEL} mb-1`}>Route</div>
          <ModeButtons small options={[["continuous", "Fewest jumps"], ["consistent", "Even sheen"]] as const} value={look.route} onChange={(v) => tweak("route", v)} />
          <p className="mt-1 text-[0.6875rem] text-mid leading-relaxed">
            {look.route === "continuous"
              ? "Each region sews as one path, traveling along legs it already covered. Top legs vary."
              : "All \"/\" legs, then all \"\\\" - every top leg the same way, like hand stitching. More travel and a jump per region."}
          </p>
        </div>
        <div>
          <div className={`${LABEL} mb-1`}>Passes per leg</div>
          <ModeButtons small options={[[1, "Single"], [2, "Double (bolder)"]] as const} value={passes} onChange={setPasses} />
        </div>
        <div>
          <div className={`${LABEL} mb-1`}>Sew order</div>
          <ModeButtons small options={[["light-first", "Light → dark"], ["dark-first", "Dark → light"], ["palette", "Palette"]] as const} value={order} onChange={setOrder} />
        </div>
        <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
          <input type="checkbox" checked={locks} onChange={(e) => setLocks(e.target.checked)} className="accent-accent" />
          Lock stitches at every start and stop
        </label>
        {look.route === "consistent" && (
          <>
            <RangeRow label="Longest hidden travel" value={maxTravelCells} min={1} max={24} step={1} onChange={setMaxTravelCells} fmt={(v) => `${v} ${v === 1 ? "stitch" : "stitches"}`} />
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Travel re-sews legs already laid. A long run of doubled legs shows as a line; past this length the machine jumps and trims instead.
            </p>
            <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
              <input type="checkbox" checked={sideTravel} onChange={(e) => setSideTravel(e.target.checked)} className="accent-accent" />
              Short visible travel instead of a jump
            </label>
          </>
        )}
      </SectionBox>

      {chart && chart.palette.length > 0 && (
        <SectionBox eyebrow={`cones (${chart.palette.length})`}>
          <div className="space-y-1">
            {chart.palette.map((p, i) => (
              <div key={p.code} className="flex items-center gap-1.5">
                <span className="w-4 h-4 border border-hairline shrink-0" style={{ background: p.hex }} />
                <span className="flex-1 min-w-0 text-[0.6875rem] text-mid truncate" title={`${p.code} ${p.name}`}>
                  {p.code} {p.name} · {usage[i] / totalCells < 0.005 ? "<1" : Math.round((usage[i] / totalCells) * 100)}%
                </span>
                <button onClick={() => toggleLock(p.code)} title={locked.includes(p.code) ? "Unlock" : "Keep this cone"}
                  className={`text-[0.6875rem] border px-1.5 py-0.5 ${locked.includes(p.code) ? "border-fg text-fg" : "border-hairline text-mid hover:text-fg"}`}>
                  {locked.includes(p.code) ? "kept" : "keep"}
                </button>
                <button onClick={() => exclude(p.code)} title="Never use this cone" className="text-[0.6875rem] border border-hairline px-1.5 py-0.5 text-mid hover:text-fg">×</button>
              </div>
            ))}
            <div className="pt-1">
              <div className={`${LABEL} mb-1`}>Swap a cone</div>
              <SwapRow palette={chart.palette} onSwap={swap} />
            </div>
            {excluded.length > 0 && (
              <p className="text-[0.6875rem] text-mid">
                {excluded.length} excluded ·{" "}
                <button onClick={() => setExcluded([])} className="text-accent underline">clear</button>
              </p>
            )}
            <p className="text-[0.625rem] text-mid leading-relaxed">
              Keep pins a cone; × bans it. The rest of the palette re-fits around your choices.
            </p>
          </div>
        </SectionBox>
      )}

      {chart && (
        <SectionBox eyebrow="inspect">
          <ModeButtons small options={[["chart", "Chart"], ["source", "Photo"], ["error", "Error map"]] as const} value={view} onChange={setView} />
          <ChartCanvas chart={chart} view={view} fabricHex={fabricHex} />
          <p className="text-[0.6875rem] text-mid leading-relaxed">
            {view === "error"
              ? "Brighter = further from the photo. Fix hot spots with more cones, a kept cone, or less smoothing."
              : view === "source" ? "The photo as the grid sees it, after sampling." : "Each square as stitched. Split squares are blends; corner triangles are fractional stitches."}
          </p>
        </SectionBox>
      )}
    </>
  );

  return (
    <ToolLayout
      controls={controls}
      preview={
        <PreviewRail built={built} colors={plan?.colors ?? []} name={NAME} threadMm={0.45} emptyHint="Load a photo to build a cross-stitch.">
          {chart && plan && built && (
            <>
              <p className="text-[0.6875rem] text-mid tabular-nums">
                {chart.cols}×{chart.rows} · {chart.palette.length} cones · avg error {chart.meanError.toFixed(1)} ·{" "}
                {chart.islands} single-stitch islands · {plan.strokes} strokes · {plan.extraHalfLegs.toLocaleString()} half-legs re-sewn
              </p>
              {chart.islands > totalCells * 0.05 && (
                <Warning>Lots of single-stitch islands - each one adds a jump. Raise smoothness or the smallest region if this is for the machine.</Warning>
              )}
            </>
          )}
        </PreviewRail>
      }
    />
  );
}

function SwapRow({ palette, onSwap }: { palette: Chart["palette"]; onSwap: (oldCode: string, newCode: string) => void }) {
  const [picked, setFrom] = useState(palette[0]?.code ?? "");
  // a swapped-out cone leaves the palette; fall back to the first one
  const from = palette.some((p) => p.code === picked) ? picked : palette[0]?.code ?? "";
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <select value={from} onChange={(e) => setFrom(e.target.value)}
        className="border border-hairline bg-bg text-fg rounded-none px-2 py-1.5 text-[0.75rem] max-w-[8rem]">
        {palette.map((p) => <option key={p.code} value={p.code}>{p.code} {p.name}</option>)}
      </select>
      <span className="text-[0.75rem] text-mid">→</span>
      <ThreadSelect value="" onChange={(_hex, code) => from && onSwap(from, code)} />
    </div>
  );
}

/** Inspector: the chart as cells, the sampled photo, or the per-cell error. */
function ChartCanvas({ chart, view, fabricHex }: { chart: Chart; view: "chart" | "source" | "error"; fabricHex: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const { cols, rows } = chart;
    const px = Math.max(2, Math.floor(600 / Math.max(cols, rows)));
    c.width = cols * px;
    c.height = rows * px;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = fabricHex;
    ctx.fillRect(0, 0, c.width, c.height);
    const t = chart.targets;
    const errs = view === "error" ? cellErrors(chart) : null;
    let emax = 1;
    if (errs) for (const e of errs) emax = Math.max(emax, e);
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const i = gy * cols + gx;
        const x = gx * px, y = gy * px;
        if (view === "source") {
          ctx.fillStyle = linToHex([t.lin[i * 3], t.lin[i * 3 + 1], t.lin[i * 3 + 2]]);
          ctx.fillRect(x, y, px, px);
          continue;
        }
        if (errs) {
          const v = Math.round(255 * Math.min(1, errs[i] / emax));
          ctx.fillStyle = `rgb(${v},${Math.round(v * 0.55)},${Math.round(40 + (255 - v) * 0.15)})`;
          ctx.fillRect(x, y, px, px);
          continue;
        }
        const l = chart.labels[chart.cell[i]];
        if (l.kind === "bare") continue;
        if (l.kind === "blend") {
          // split along "/": lower-left triangle = "/" cone, upper-right = "\" cone
          const a = chart.palette[l.fwd].hex, b = chart.palette[l.back].hex;
          tri(ctx, [[x, y], [x, y + px], [x + px, y + px]], a);
          tri(ctx, [[x, y], [x + px, y], [x + px, y + px]], b);
          continue;
        }
        if (l.kind === "half") {
          ctx.strokeStyle = chart.palette[l.fwd].hex;
          ctx.lineWidth = Math.max(1, px * 0.3);
          ctx.beginPath(); ctx.moveTo(x, y + px); ctx.lineTo(x + px, y); ctx.stroke();
          continue;
        }
        ctx.fillStyle = chart.palette[l.fwd].hex;
        ctx.fillRect(x, y, px, px);
        const k = chart.corner[i];
        if (k >= 0) {
          const m = chart.labels[chart.minority[i]];
          const col = m?.kind === "solid" ? chart.palette[m.fwd].hex : fabricHex;
          // the corner quadrant: corner, edge midpoints, center
          const h = px / 2;
          const corners: [number, number][] = [[x, y], [x + px, y], [x + px, y + px], [x, y + px]];
          const [qx, qy] = corners[k];
          const sx = k === 0 || k === 3 ? 1 : -1, sy = k < 2 ? 1 : -1;
          tri(ctx, [[qx, qy], [qx + sx * h, qy], [qx + sx * h, qy + sy * h], [qx, qy + sy * h]], col);
        }
      }
    }
  }, [chart, view, fabricHex]);
  return <canvas ref={ref} className="w-full h-auto border border-hairline" style={{ imageRendering: "pixelated" }} />;
}

function tri(ctx: CanvasRenderingContext2D, pts: [number, number][], fill: string) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();
}
