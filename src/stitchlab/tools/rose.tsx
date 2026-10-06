// Stitch Lab tool: Rose - the rhodonea curve r = cos(nθ) and its wilder
// cousin the Maurer rose, where you walk the rose in big angular strides (d°
// per step) and connect the landing points. Two integers, n and d, unfold
// into stunning geometric webs - and the walk closes back on itself, so it
// sews as one continuous line with zero trims.

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

export type RoseOpts = {
  n?: number; // petal frequency, default 6
  d?: number; // Maurer walk degrees per step (0 = smooth rhodonea), default 71
  petalsPlusStem?: boolean; // add the smooth rose underneath the Maurer web
  steps?: number; // walk length, default 361
};

/** Maurer rose (d>0) or smooth rhodonea (d=0). One continuous path. */
export function rosePath(opts: RoseOpts = {}): PathMm {
  const n = Math.max(1, Math.round(opts.n ?? 6));
  const d = opts.d ?? 71;
  if (d === 0) {
    // Smooth rhodonea, finely sampled.
    const pts: PathMm = [];
    const steps = 2000;
    // A rose with odd n closes in 180°, even n in 360°.
    const span = n % 2 === 1 ? 180 : 360;
    for (let i = 0; i <= steps; i++) {
      const theta = ((span * i) / steps) * (Math.PI / 180);
      const r = Math.cos(n * theta);
      pts.push({ x: r * Math.cos(theta), y: r * Math.sin(theta) });
    }
    return pts;
  }
  const steps = Math.max(60, Math.round(opts.steps ?? 361));
  const pts: PathMm = [];
  for (let k = 0; k <= steps; k++) {
    const theta = k * d * (Math.PI / 180);
    const r = Math.cos(n * theta);
    pts.push({ x: r * Math.cos(theta), y: r * Math.sin(theta) });
  }
  return pts;
}

// ─── Component ───────────────────────────────────────────────────────────

const NAME = "bayside-rose";

export default function RoseTool() {
  const [n, setN] = useState(6);
  const [d, setD] = useState(71);
  const [smooth, setSmooth] = useState(false);
  const [layerRose, setLayerRose] = useState(true);
  const [sizeMm, setSizeMm] = useState(120);
  const [stitchLen, setStitchLen] = useState(2.2);
  const [bean, setBean] = useState<1 | 3>(1);
  const [threadHex, setThreadHex] = useState(
    THREADS.find((t) => t.family === "Red" && t.hex && !t.isMetallic)?.hex ??
      THREADS.find((t) => t.hex)?.hex ??
      "#8a2020",
  );

  const dN = useDebounced(n);
  const dD = useDebounced(d);

  const built = useMemo(() => {
    const paths: PathMm[] = [];
    const web = rosePath({ n: dN, d: smooth ? 0 : dD });
    paths.push(web);
    if (!smooth && layerRose) paths.push(rosePath({ n: dN, d: 0 })); // smooth rose under the web
    const [webFit, roseFit] = fitPaths(paths, sizeMm);
    const out = [webFit, roseFit].filter(Boolean).map((p) => resamplePath(p, stitchLen, 0.3));
    return buildDesign(pathsToStitches(out, bean), NAME);
  }, [dN, dD, smooth, layerRose, sizeMm, stitchLen, bean]);

  const stitchCount = built?.stats.realStitches ?? 0;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Rose">
            <RangeRow label="n (petals)" value={n} min={2} max={17} onChange={setN} />
            <RangeRow label="d (walk°)" value={d} min={0} max={180} onChange={setD} fmt={(v) => `${v}°`} />
            <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
              <input type="checkbox" checked={smooth} onChange={(ev) => setSmooth(ev.target.checked)} className="accent-accent" />
              Smooth rose only (no web)
            </label>
            {!smooth && (
              <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
                <input type="checkbox" checked={layerRose} onChange={(ev) => setLayerRose(ev.target.checked)} className="accent-accent" />
                Trace the petal outline too
              </label>
            )}
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              n sets the petal count; d is how far around the rose each straight stride
              jumps. Classic Maurer roses live near d = 29, 71, 79, 97 - but every
              integer is its own flower.
            </p>
          </SectionBox>

          <SectionBox eyebrow="Stitches">
            <SizeField valueMm={sizeMm} min={40} max={330} onChange={setSizeMm} />
            <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={4} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
            <ModeButtons
              small
              options={[
                [1, "Run"],
                [3, "Bean ×3"],
              ]}
              value={bean}
              onChange={setBean}
            />
            <ThreadRow hex={threadHex} onChange={(hex) => setThreadHex(hex)} />
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail built={built} colors={[threadHex]} name={NAME} emptyHint="Grow a rose.">
          {built && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              {smooth ? `smooth ${n % 2 ? n : n * 2}-petal rose` : `Maurer rose n=${n} d=${d}°`} · one
              continuous line
            </p>
          )}
          {stitchCount > 60000 && <Warning>Over 60k stitches - smaller size or bean off.</Warning>}
        </PreviewRail>
      }
    />
  );
}
