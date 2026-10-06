// Stitch Lab tool: Attractor - iterate a chaotic map (Peter de Jong or
// Clifford Pickover) and connect its points in the order they're born. The
// map wanders its whole basin, so one unbroken thread scribbles out a dense,
// symmetrical web - the strange-attractor cousin of the harmonograph rose,
// and like it, a single continuous line with zero trims. Four numbers reshape
// the whole organism; "surprise me" rolls new ones.

import { useMemo, useState } from "react";
import { THREADS } from "../../data/threads";
import type { PathMm } from "../lib/generators";
import { fitPaths, pathsToStitches, resamplePath } from "../lib/generators";
import {
  buildDesign,
  ModeButtons,
  PreviewRail,
  RangeRow,
  SectionBox,
  ThreadRow,
  ToolLayout,
  useDebounced,
  Warning,
  SizeField,
} from "./shared";

// ─── Pure logic ──────────────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type AttractorMap = "dejong" | "clifford";

export type AttractorOpts = {
  map?: AttractorMap;
  a?: number;
  b?: number;
  c?: number;
  d?: number;
  points?: number; // default 3000
};

/** Iterate the map; return points in birth order (one continuous path). */
export function attractorPath(opts: AttractorOpts = {}): PathMm {
  const map = opts.map ?? "dejong";
  const a = opts.a ?? 1.4;
  const b = opts.b ?? -2.3;
  const c = opts.c ?? 2.4;
  const d = opts.d ?? -2.1;
  const n = Math.max(200, Math.min(12000, Math.round(opts.points ?? 3000)));
  let x = 0.1;
  let y = 0.1;
  const pts: PathMm = [];
  // Skip transient, then collect.
  for (let i = 0; i < n + 100; i++) {
    let nx: number;
    let ny: number;
    if (map === "dejong") {
      nx = Math.sin(a * y) - Math.cos(b * x);
      ny = Math.sin(c * x) - Math.cos(d * y);
    } else {
      nx = Math.sin(a * y) + c * Math.cos(a * x);
      ny = Math.sin(b * x) + d * Math.cos(b * y);
    }
    x = nx;
    y = ny;
    if (i >= 100) pts.push({ x, y });
  }
  return pts;
}

/** Seeded "surprise" parameters that reliably make a rich attractor. */
export function surpriseParams(rand: () => number, map: AttractorMap): [number, number, number, number] {
  const r = () => (rand() * 2 - 1) * (map === "dejong" ? 3 : 2);
  return [r(), r(), map === "dejong" ? r() : rand() * 2, map === "dejong" ? r() : rand() * 2];
}

// ─── Component ───────────────────────────────────────────────────────────

const NAME = "bayside-attractor";

const PRESETS: Record<AttractorMap, [number, number, number, number][]> = {
  dejong: [
    [1.4, -2.3, 2.4, -2.1],
    [-2.0, -2.0, -1.2, 2.0],
    [1.641, 1.902, 0.316, 1.525],
  ],
  clifford: [
    [-1.4, 1.6, 1.0, 0.7],
    [-1.7, 1.3, -0.1, -1.2],
    [1.5, -1.8, 1.6, 0.9],
  ],
};

export default function AttractorTool() {
  const [map, setMap] = useState<AttractorMap>("dejong");
  const [params, setParams] = useState<[number, number, number, number]>(PRESETS.dejong[0]);
  const [points, setPoints] = useState(1400);
  const [sizeMm, setSizeMm] = useState(120);
  const [stitchLen, setStitchLen] = useState(2.2);
  const [threadHex, setThreadHex] = useState(
    THREADS.find((t) => t.family === "Purple" && t.hex)?.hex ??
      THREADS.find((t) => t.hex)?.hex ??
      "#082870",
  );

  const dParams = useDebounced(params, 300);
  const dPoints = useDebounced(points, 300);

  const built = useMemo(() => {
    const raw = attractorPath({ map, a: dParams[0], b: dParams[1], c: dParams[2], d: dParams[3], points: dPoints });
    if (raw.length < 10) return null;
    const [fitted] = fitPaths([raw], sizeMm);
    return buildDesign(pathsToStitches([resamplePath(fitted, stitchLen, 0.3)], 1), NAME);
  }, [map, dParams, dPoints, sizeMm, stitchLen]);

  const stitchCount = built?.stats.realStitches ?? 0;
  const setP = (i: number, v: number) =>
    setParams((p) => p.map((x, j) => (j === i ? v : x)) as [number, number, number, number]);

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Map">
            <ModeButtons
              options={[
                ["dejong", "De Jong"],
                ["clifford", "Clifford"],
              ]}
              value={map}
              onChange={(m) => {
                setMap(m);
                setParams(PRESETS[m][0]);
              }}
            />
            <div className="flex gap-2 flex-wrap">
              {PRESETS[map].map((p, i) => (
                <button
                  key={i}
                  onClick={() => setParams(p)}
                  className="border border-hairline bg-bg px-3 py-1 text-[0.75rem] text-fg hover:bg-card"
                >
                  Preset {i + 1}
                </button>
              ))}
              <button
                onClick={() => setParams(surpriseParams(mulberry32((Math.random() * 1e9) | 0), map))}
                className="border border-fg bg-fg text-bg px-3 py-1 text-[0.75rem] hover:opacity-85"
              >
                Surprise me
              </button>
            </div>
            {(["a", "b", "c", "d"] as const).map((label, i) => (
              <RangeRow
                key={label}
                label={label}
                value={params[i]}
                min={-3}
                max={3}
                step={0.001}
                onChange={(v) => setP(i, v)}
                fmt={(v) => v.toFixed(3)}
              />
            ))}
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Four numbers, one chaotic map, endless organisms. Tiny nudges reshape the
              whole web - the sweet spots hide between the presets.
            </p>
          </SectionBox>

          <SectionBox eyebrow="Stitches">
            <RangeRow label="Density" value={points} min={500} max={4000} step={100} onChange={setPoints} fmt={(v) => `${v} points`} />
            <SizeField valueMm={sizeMm} min={50} max={330} onChange={setSizeMm} />
            <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={4} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
            <ThreadRow hex={threadHex} onChange={(hex) => setThreadHex(hex)} />
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail built={built} colors={[threadHex]} name={NAME} emptyHint="Adjust the numbers and a symmetrical web appears.">
          {built && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              one continuous line through {points.toLocaleString()} attractor points · zero trims
            </p>
          )}
          {stitchCount > 60000 && (
            <Warning>Over 60k stitches - fewer points or a smaller size.</Warning>
          )}
        </PreviewRail>
      }
    />
  );
}
