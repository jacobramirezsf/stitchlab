// Stitch Lab tool: Satin Ribbon - true zigzag satin columns along a path.
//
// This is the deepest craft tool in the lab. A satin column is not a thick
// line: it's alternating needle penetrations across two rails, laid over an
// underlay stack that stabilizes the fabric, with the column widened slightly
// beyond its drawn width because thread pulls fabric inward as it sews.
// Digitizers call these density, underlay, and pull compensation - the three
// things that separate machine embroidery from vector art. None of the open
// libraries we studied implement all three; this is our clean-room take.
//
// Pure exports (satinAlongPath) are DOM-free and node-testable.

import { useEffect, useMemo, useRef, useState } from "react";
import { THREADS } from "../../data/threads";
import type { PathMm } from "../lib/generators";
import { fitPaths, pathsToStitches, resamplePath } from "../lib/generators";
import type { HersheyFaceId } from "./data/hershey";
import { HERSHEY_FACES, HERSHEY_PICKER_IDS } from "./data/hershey";
import { layoutText } from "./lettering";
import {
  buildDesign,
  FabricSelect,
  FABRIC_PRESETS,
  type FabricId,
  ModeButtons,
  PreviewRail,
  RangeRow,
  SectionBox,
  ThreadRow,
  ToolLayout,
  Warning,
  SizeField,
  fmtLen, useUnits,
} from "./shared";

// ─── Pure satin engine ───────────────────────────────────────────────────

export type SatinOpts = {
  widthMm?: number; // visual column width, default 4
  densityMm?: number; // spacing between penetrations along the path, default 0.45
  pullCompMm?: number; // extra half-width added each side, default 0.2
  underlayCenter?: boolean; // center running stitch, default true
  underlayEdge?: boolean; // edge-walk runs inset from both rails, default true
  underlayZigzag?: boolean; // sparse zigzag pass, default false
};

export type SatinResult = {
  /** Underlay passes, chained so consecutive paths share endpoints. */
  underlay: PathMm[];
  /** The zigzag satin pass itself. */
  satin: PathMm;
  stations: number;
  /** Stations where tight inside curves triggered short-stitching. */
  shortened: number;
};

type Station = { p: { x: number; y: number }; n: { x: number; y: number }; turn: number };

/** Evenly spaced stations with smoothed normals + signed turn per station. */
function buildStations(center: PathMm, densityMm: number): Station[] {
  const fine = resamplePath(center, 0.3, 0.05);
  if (fine.length < 2) return [];
  // Tangents by central difference, then normals, then a light smooth.
  const tangents = fine.map((_, i) => {
    const a = fine[Math.max(0, i - 1)];
    const b = fine[Math.min(fine.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  });
  const smooth = tangents.map((_, i) => {
    let sx = 0;
    let sy = 0;
    for (let k = -2; k <= 2; k++) {
      const t = tangents[Math.min(tangents.length - 1, Math.max(0, i + k))];
      sx += t.x;
      sy += t.y;
    }
    const len = Math.hypot(sx, sy) || 1;
    return { x: sx / len, y: sy / len };
  });
  // Arc length table, then stations every densityMm.
  const cum: number[] = [0];
  for (let i = 1; i < fine.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(fine[i].x - fine[i - 1].x, fine[i].y - fine[i - 1].y));
  }
  const total = cum[cum.length - 1];
  const count = Math.max(2, Math.floor(total / densityMm) + 1);
  const stations: Station[] = [];
  let idx = 0;
  let prevT: { x: number; y: number } | null = null;
  for (let k = 0; k < count; k++) {
    const target = Math.min(total, k * densityMm);
    while (idx < cum.length - 2 && cum[idx + 1] < target) idx++;
    const span = cum[idx + 1] - cum[idx] || 1;
    const t = (target - cum[idx]) / span;
    const p = {
      x: fine[idx].x + (fine[idx + 1].x - fine[idx].x) * t,
      y: fine[idx].y + (fine[idx + 1].y - fine[idx].y) * t,
    };
    const ta = smooth[idx];
    const tb = smooth[Math.min(smooth.length - 1, idx + 1)];
    let tx = ta.x + (tb.x - ta.x) * t;
    let ty = ta.y + (tb.y - ta.y) * t;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const turn = prevT ? prevT.x * ty - prevT.y * tx : 0;
    prevT = { x: tx, y: ty };
    stations.push({ p, n: { x: -ty, y: tx }, turn });
  }
  return stations;
}

export function satinAlongPath(center: PathMm, opts: SatinOpts = {}): SatinResult {
  const widthMm = opts.widthMm ?? 4;
  const densityMm = opts.densityMm ?? 0.45;
  const pullCompMm = opts.pullCompMm ?? 0.2;
  const stations = buildStations(center, densityMm);
  if (stations.length < 2) return { underlay: [], satin: [], stations: 0, shortened: 0 };

  const half = widthMm / 2 + pullCompMm;
  // Tight inside curves: the turn angle per station gives the local radius
  // (ρ ≈ density/|turn|), and the inner rail's penetration spacing shrinks to
  // density·(1 − half/ρ). When that spacing drops under ~0.28mm the inner
  // edge perforates the fabric - real digitizers shorten every other inner
  // stitch instead of thinning the whole column.
  const innerSpacingAt = (turn: number) => {
    const rho = densityMm / Math.max(1e-6, Math.abs(turn));
    return densityMm * (1 - half / rho);
  };
  let shortened = 0;

  const rail = (s: Station, side: 1 | -1, scale = 1) => ({
    x: s.p.x + s.n.x * half * side * scale,
    y: s.p.y + s.n.y * half * side * scale,
  });

  const satin: PathMm = [];
  stations.forEach((s, k) => {
    const side: 1 | -1 = k % 2 === 0 ? 1 : -1;
    let scale = 1;
    if (innerSpacingAt(s.turn) < 0.28) {
      // Inner side is where the curvature center sits: turn>0 → +normal side.
      const inner: 1 | -1 = s.turn > 0 ? 1 : -1;
      if (side === inner && k % 4 < 2) {
        scale = 0.62;
        shortened++;
      }
    }
    satin.push(rail(s, side, scale));
  });

  // Underlay stack, chained end-to-end so the machine never jumps:
  //   center run S→E · edge walk E→S (left inset) then S→E (right inset) ·
  //   optional zigzag E→S. The satin pass then starts wherever we ended.
  const underlay: PathMm[] = [];
  const centerPts = stations.map((s) => s.p);
  let atEnd = false;
  if (opts.underlayCenter ?? true) {
    underlay.push(resamplePath(centerPts, 1.8, 0.3));
    atEnd = true;
  }
  if (opts.underlayEdge ?? widthMm >= 3.5) {
    const leftInset = stations.map((s) => rail(s, 1, 0.65));
    const rightInset = stations.map((s) => rail(s, -1, 0.65));
    if (atEnd) leftInset.reverse();
    underlay.push(resamplePath(leftInset, 2, 0.3));
    const right = atEnd ? rightInset : rightInset.slice().reverse();
    underlay.push(resamplePath(right, 2, 0.3));
    // The two edge passes cancel out - we end on the same end we entered at.
  }
  if (opts.underlayZigzag) {
    const zig: PathMm = [];
    const step = Math.max(1, Math.round(2 / densityMm));
    const idxs: number[] = [];
    for (let k = 0; k < stations.length; k += step) idxs.push(k);
    if (atEnd) idxs.reverse();
    idxs.forEach((k, i) => zig.push(rail(stations[k], i % 2 === 0 ? 1 : -1, 0.8)));
    underlay.push(zig);
    atEnd = !atEnd;
  }
  // Run the satin from whichever end the underlay left us at.
  if (atEnd) satin.reverse();

  return { underlay, satin, stations: stations.length, shortened };
}

// ─── Preset centerlines (unit space; fit to size later) ──────────────────

export function presetCenterline(kind: "wave" | "arc" | "loop" | "spiral"): PathMm {
  const pts: PathMm = [];
  if (kind === "wave") {
    for (let i = 0; i <= 240; i++) {
      const t = i / 240;
      pts.push({ x: t * 100, y: 18 * Math.sin(t * Math.PI * 3) });
    }
  } else if (kind === "arc") {
    for (let i = 0; i <= 160; i++) {
      const a = (-210 + 240 * (i / 160)) * (Math.PI / 180);
      pts.push({ x: 50 * Math.cos(a), y: 50 * Math.sin(a) });
    }
  } else if (kind === "loop") {
    for (let i = 0; i <= 220; i++) {
      const a = (i / 220) * Math.PI * 2;
      pts.push({ x: 50 * Math.cos(a), y: 50 * Math.sin(a) });
    }
  } else {
    // spiral - inner radius stays generous so the column never self-overlaps
    for (let i = 0; i <= 500; i++) {
      const t = i / 500;
      const a = t * Math.PI * 2 * 2.25;
      const r = 16 + 34 * t;
      pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
    }
  }
  return pts;
}

// ─── Component ───────────────────────────────────────────────────────────

type Mode = "wave" | "arc" | "loop" | "spiral" | "draw" | "monogram";

export default function SatinTool() {
  const units = useUnits();
  const [mode, setMode] = useState<Mode>("wave");
  const [widthMm, setWidthMm] = useState(4);
  const [density, setDensity] = useState(0.4);
  const [fabric, setFabricId] = useState<FabricId>("canvas");
  const applyFabric = (id: FabricId) => {
    setFabricId(id);
    const p = FABRIC_PRESETS[id];
    setDensity(p.satinSpacingMm);
    setPullComp(p.pullCompMm);
  };
  const [pullComp, setPullComp] = useState(0.2);
  const [ulCenter, setUlCenter] = useState(true);
  const [ulEdge, setUlEdge] = useState(true);
  const [ulZigzag, setUlZigzag] = useState(false);
  const [sizeMm, setSizeMm] = useState(90);
  const [threadHex, setThreadHex] = useState(
    THREADS.find((t) => t.hex && !t.isMetallic)?.hex ?? "#082870",
  );
  // Monogram
  const [text, setText] = useState("B");
  const [faceId, setFaceId] = useState<HersheyFaceId>("script");
  const [capMm, setCapMm] = useState(34);
  // Draw pad
  const [strokes, setStrokes] = useState<PathMm[]>([]);
  const padRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef<PathMm | null>(null);

  const satinOpts = useMemo<SatinOpts>(
    () => ({
      widthMm,
      densityMm: density,
      pullCompMm: pullComp,
      underlayCenter: ulCenter,
      underlayEdge: ulEdge,
      underlayZigzag: ulZigzag,
    }),
    [widthMm, density, pullComp, ulCenter, ulEdge, ulZigzag],
  );

  const built = useMemo(() => {
    try {
      let centerlines: PathMm[] = [];
      if (mode === "monogram") {
        if (!text.trim()) return { built: null, info: null, error: null };
        centerlines = layoutText({
          text: text.slice(0, 10),
          faceId,
          heightMm: capMm,
          stitchLenMm: 0.8,
        });
      } else if (mode === "draw") {
        if (strokes.length === 0) return { built: null, info: null, error: null };
        const pad = padRef.current;
        const scale = sizeMm / (pad?.clientWidth || 320);
        centerlines = strokes.map((s) =>
          s.map((p, i, arr) => {
            const a = arr[Math.max(0, i - 1)];
            const c = arr[Math.min(arr.length - 1, i + 1)];
            return { x: ((a.x + p.x + c.x) / 3) * scale, y: ((a.y + p.y + c.y) / 3) * scale };
          }),
        );
      } else {
        const margin = Math.max(10, widthMm + 4);
        centerlines = fitPaths([presetCenterline(mode)], Math.max(20, sizeMm - margin));
      }

      const paths: PathMm[] = [];
      let stations = 0;
      let shortenedTotal = 0;
      for (const line of centerlines) {
        const result = satinAlongPath(line, satinOpts);
        if (result.satin.length < 2) continue;
        paths.push(...result.underlay, result.satin);
        stations += result.stations;
        shortenedTotal += result.shortened;
      }
      const stitches = pathsToStitches(paths, 1);
      return {
        built: buildDesign(stitches, "bayside-satin"),
        info: { columns: centerlines.length, stations, shortened: shortenedTotal },
        error: null,
      };
    } catch (err) {
      return {
        built: null,
        info: null,
        error: err instanceof Error ? err.message : "Could not generate satin.",
      };
    }
  }, [mode, text, faceId, capMm, strokes, sizeMm, widthMm, satinOpts]);

  const padPointer = (ev: React.PointerEvent<HTMLCanvasElement>, phase: "down" | "move" | "up") => {
    const pad = padRef.current;
    if (!pad) return;
    const rect = pad.getBoundingClientRect();
    const p = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    if (phase === "down") {
      drawingRef.current = [p];
      pad.setPointerCapture(ev.pointerId);
    } else if (phase === "move" && drawingRef.current) {
      const last = drawingRef.current[drawingRef.current.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) > 3) {
        drawingRef.current.push(p);
        setStrokes((s) => s.slice());
      }
    } else if (phase === "up" && drawingRef.current) {
      const done = drawingRef.current;
      drawingRef.current = null;
      if (done.length > 3) setStrokes((s) => [...s, done]);
      else setStrokes((s) => s.slice());
    }
  };

  // Live pad repaint
  useEffect(() => {
    const pad = padRef.current;
    if (!pad || mode !== "draw") return;
    const dpr = window.devicePixelRatio || 1;
    pad.width = Math.round(pad.clientWidth * dpr);
    pad.height = Math.round(pad.clientHeight * dpr);
    const ctx = pad.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, pad.clientWidth, pad.clientHeight);
    ctx.strokeStyle = "#1c1c1a";
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = 0.25;
    for (const s of strokes.concat(drawingRef.current ? [drawingRef.current] : [])) {
      ctx.beginPath();
      s.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }, [strokes, mode]);

  const stitchCount = built.built?.stats.realStitches ?? 0;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Path">
            <ModeButtons
              options={[
                ["wave", "Wave"],
                ["arc", "Arc"],
                ["loop", "Loop"],
                ["spiral", "Spiral"],
                ["draw", "Draw"],
                ["monogram", "Monogram"],
              ]}
              value={mode}
              onChange={setMode}
            />
            {mode === "monogram" && (
              <>
                <input
                  value={text}
                  onChange={(ev) => setText(ev.target.value)}
                  maxLength={10}
                  placeholder="Initials…"
                  className="w-full border border-hairline bg-bg px-2 py-1.5 text-[1rem] text-fg font-serif"
                />
                <ModeButtons
                  small
                  options={HERSHEY_PICKER_IDS.map(
                    (id) => [id, HERSHEY_FACES[id].name] as const,
                  )}
                  value={faceId}
                  onChange={setFaceId}
                />
                <RangeRow label="Cap height" value={capMm} min={15} max={60} onChange={setCapMm} fmt={(v) => fmtLen(v, units)} />
              </>
            )}
            {mode === "draw" && (
              <>
                <canvas
                  ref={padRef}
                  className="w-full aspect-square bg-white border border-hairline touch-none cursor-crosshair"
                  onPointerDown={(ev) => padPointer(ev, "down")}
                  onPointerMove={(ev) => padPointer(ev, "move")}
                  onPointerUp={(ev) => padPointer(ev, "up")}
                />
                <div className="flex gap-2">
                  <button onClick={() => setStrokes((s) => s.slice(0, -1))} className="border border-hairline bg-bg px-3 py-1 text-[0.75rem] text-fg hover:bg-card">
                    Undo
                  </button>
                  <button onClick={() => setStrokes([])} className="border border-hairline bg-bg px-3 py-1 text-[0.75rem] text-fg hover:bg-card">
                    Clear
                  </button>
                </div>
                <p className="text-[0.6875rem] text-mid">
                  Each stroke becomes one satin column along its centerline.
                </p>
              </>
            )}
            {mode !== "monogram" && (
              <SizeField label="Shape size" valueMm={sizeMm} min={40} max={330} onChange={setSizeMm} />
            )}
          </SectionBox>

          <SectionBox eyebrow="Column">
            <FabricSelect value={fabric} onChange={applyFabric} />
            <RangeRow label="Width" value={widthMm} min={2} max={8} step={0.25} onChange={setWidthMm} fmt={(v) => `${v.toFixed(2)} mm`} />
            <RangeRow label="Density" value={density} min={0.3} max={0.8} step={0.05} onChange={setDensity} fmt={(v) => `${v.toFixed(2)} mm`} />
            <RangeRow label="Pull compensation" value={pullComp} min={0} max={0.6} step={0.05} onChange={setPullComp} fmt={(v) => `${v.toFixed(2)} mm / side`} />
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Thread pulls fabric inward as satin sews - compensation widens each
              penetration so the finished column measures true. 0.2 mm suits mid-weight
              knits; go higher on hoodies, lower on stable canvas.
            </p>
          </SectionBox>

          <SectionBox eyebrow="Underlay">
            {(
              [
                ["Center run", ulCenter, setUlCenter],
                ["Edge walk", ulEdge, setUlEdge],
                ["Zigzag", ulZigzag, setUlZigzag],
              ] as const
            ).map(([label, val, set]) => (
              <label key={label} className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
                <input type="checkbox" checked={val} onChange={(ev) => set(ev.target.checked)} className="accent-accent" />
                {label}
              </label>
            ))}
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Underlay stitches sew first and disappear under the column: the center run
              anchors the path, edge walks stabilize the rails, zigzag adds loft on wide
              columns. The passes chain end-to-end - no trims inside a column.
            </p>
          </SectionBox>

          <SectionBox eyebrow="Thread">
            <ThreadRow hex={threadHex} onChange={(hex) => setThreadHex(hex)} />
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail
          built={built.built}
          colors={[threadHex]}
          name="bayside-satin"
          emptyHint={
            mode === "draw"
              ? "Draw a stroke to lay a satin column along it."
              : mode === "monogram"
                ? "Type an initial or two."
                : "Adjust the column."
          }
        >
          {built.error && <Warning>{built.error}</Warning>}
          {built.info && built.built && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              {built.info.columns} column{built.info.columns === 1 ? "" : "s"} ·{" "}
              {built.info.stations.toLocaleString()} penetrations ·{" "}
              {(1 / density).toFixed(1)} per mm
              {built.info.shortened > 0 &&
                ` · short-stitched ${built.info.shortened} tight-curve points`}
            </p>
          )}
          {density < 0.35 && (
            <Warning>
              Very dense - under 0.35 mm can perforate light fabric. Test on a scrap.
            </Warning>
          )}
          {widthMm > 6 && !ulZigzag && (
            <Warning>Columns over 6 mm want zigzag underlay for loft - try enabling it.</Warning>
          )}
          {stitchCount > 60000 && (
            <Warning>Over 60k stitches - consider a smaller size or lower density.</Warning>
          )}
        </PreviewRail>
      }
    />
  );
}
