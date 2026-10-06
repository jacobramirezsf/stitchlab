// Stitch Lab tool: Thread Painting - the crewel "long-short" needle-painting
// technique, automated. Structure-tensor orientation (lib/orientation) tells
// every pixel which way the image's texture runs; strokes follow that flow in
// alternating long/short lengths (the blending trick embroiderers use so
// rows melt into each other), laid coarse-to-fine in 2–3 darkness layers,
// darkest thread first - Hertzmann's painterly-rendering control loop with a
// needle instead of a brush.

import { useMemo, useState } from "react";
import { THREADS } from "../../data/threads";
import type { PathMm } from "../lib/generators";
import { pathGroupsToStitches } from "../lib/generators";
import { orientationField } from "../lib/orientation";
import {
  buildDesign,
  ImagePick,
  ModeButtons,
  PreviewRail,
  RangeRow,
  SectionBox,
  ThreadRow,
  ToolLayout,
  useDebounced,
  Warning,
  type LumImg,
  SizeField,
} from "./shared";

// ─── Pure logic ──────────────────────────────────────────────────────────

export type ThreadPaintOpts = {
  tones?: 2 | 3;
  sizeMm?: number; // long side, default 100
  spacingMm?: number; // stroke row spacing, default 1.2
  strokeLenMm?: number; // long stroke length, default 6 (short = 60%)
  invert?: boolean;
};

export type ThreadPaintResult = {
  /** One stroke set per tone layer, darkest first. */
  layers: PathMm[][];
};

/**
 * Coverage-driven stroke placement: march a grid; wherever this tone layer
 * owns the pixel and no stroke covers it yet, grow a stroke along the local
 * orientation, alternating long/short. Deterministic (plain scan order).
 */
export function threadPaint(
  img: { w: number; h: number; lum: Float32Array },
  opts: ThreadPaintOpts = {},
): ThreadPaintResult {
  const tones = opts.tones ?? 3;
  const sizeMm = opts.sizeMm ?? 100;
  const spacing = opts.spacingMm ?? 1.2;
  const longLen = opts.strokeLenMm ?? 6;
  const { w, h } = img;
  const scale = sizeMm / Math.max(w, h); // mm per pixel
  const field = orientationField(img, 4);

  const darkness = (i: number) => (opts.invert ? img.lum[i] : 1 - img.lum[i]);
  // Tone bands, darkest first. 3 tones: >0.62, 0.38–0.62, 0.16–0.38.
  const bands: [number, number][] =
    tones === 3
      ? [
          [0.62, 2],
          [0.38, 0.62],
          [0.16, 0.38],
        ]
      : [
          [0.5, 2],
          [0.16, 0.5],
        ];

  // Coverage grid in mm space at `spacing` pitch.
  const gw = Math.ceil((w * scale) / spacing) + 2;
  const gh = Math.ceil((h * scale) / spacing) + 2;
  const covered = new Uint8Array(gw * gh);
  const cellOf = (xMm: number, yMm: number) =>
    Math.min(gh - 1, Math.max(0, Math.floor(yMm / spacing))) * gw +
    Math.min(gw - 1, Math.max(0, Math.floor(xMm / spacing)));

  const lumAt = (xMm: number, yMm: number): number => {
    const px = Math.min(w - 1, Math.max(0, Math.round(xMm / scale)));
    const py = Math.min(h - 1, Math.max(0, Math.round(yMm / scale)));
    return img.lum[py * w + px];
  };
  const thetaAt = (xMm: number, yMm: number): number => {
    const px = Math.min(w - 1, Math.max(0, Math.round(xMm / scale)));
    const py = Math.min(h - 1, Math.max(0, Math.round(yMm / scale)));
    return field.theta[py * w + px];
  };

  const layers: PathMm[][] = [];
  let strokeIndex = 0;
  for (const [lo, hi] of bands) {
    const strokes: PathMm[] = [];
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const xMm = (gx + 0.5) * spacing;
        const yMm = (gy + 0.5) * spacing;
        if (xMm > w * scale || yMm > h * scale) continue;
        const px = Math.min(w - 1, Math.round(xMm / scale));
        const py = Math.min(h - 1, Math.round(yMm / scale));
        const d = darkness(py * w + px);
        if (d < lo || d >= hi) continue;
        if (covered[cellOf(xMm, yMm)]) continue;
        // Grow a stroke along ±theta, alternating long/short (the blend).
        const targetLen = strokeIndex++ % 2 === 0 ? longLen : longLen * 0.6;
        const stroke: PathMm = [];
        for (const sgn of [-1, 1]) {
          let x = xMm;
          let y = yMm;
          const half: PathMm = [];
          let walked = 0;
          while (walked < targetLen / 2) {
            const th = thetaAt(x, y);
            const step = 0.7;
            const nx2 = x + Math.cos(th) * step * sgn;
            const ny2 = y + Math.sin(th) * step * sgn;
            if (nx2 < 0 || ny2 < 0 || nx2 > w * scale || ny2 > h * scale) break;
            // Stay inside this tone band (stroke ends where the tone changes).
            const dHere = opts.invert ? lumAt(nx2, ny2) : 1 - lumAt(nx2, ny2);
            if (dHere < lo * 0.85) break;
            x = nx2;
            y = ny2;
            half.push({ x, y });
            covered[cellOf(x, y)] = 1;
            walked += step;
          }
          if (sgn === -1) stroke.push(...half.reverse());
          else {
            stroke.push({ x: xMm, y: yMm });
            stroke.push(...half);
          }
        }
        covered[cellOf(xMm, yMm)] = 1;
        if (stroke.length >= 3) strokes.push(stroke);
      }
    }
    layers.push(strokes);
  }

  // Center on origin.
  const cx = (w * scale) / 2;
  const cy = (h * scale) / 2;
  return {
    layers: layers.map((ls) => ls.map((p) => p.map((q) => ({ x: q.x - cx, y: q.y - cy })))),
  };
}

/** Default cones per tone: darkest, mid, light - by hex luminance. */
export function defaultToneHexes(tones: 2 | 3): string[] {
  const withHex = THREADS.filter((t) => t.hex && !t.isMetallic);
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  };
  const sorted = withHex.slice().sort((a, b) => lum(a.hex!) - lum(b.hex!));
  const pick = (f: number) => sorted[Math.floor(f * (sorted.length - 1))].hex!;
  return tones === 3 ? [pick(0.02), pick(0.45), pick(0.8)] : [pick(0.02), pick(0.6)];
}

// ─── Component ───────────────────────────────────────────────────────────

const NAME = "bayside-threadpaint";

export default function ThreadPaintTool() {
  const [img, setImg] = useState<LumImg | null>(null);
  const [fileName, setFileName] = useState("");
  const [tones, setTones] = useState<2 | 3>(3);
  const [sizeMm, setSizeMm] = useState(100);
  const [spacing, setSpacing] = useState(1.2);
  const [strokeLen, setStrokeLen] = useState(6);
  const [invert, setInvert] = useState(false);
  const [hexes, setHexes] = useState<string[]>(() => defaultToneHexes(3));

  const dSpacing = useDebounced(spacing);
  const dStroke = useDebounced(strokeLen);
  const dSize = useDebounced(sizeMm);

  const result = useMemo(
    () =>
      img
        ? threadPaint(img, {
            tones,
            sizeMm: dSize,
            spacingMm: dSpacing,
            strokeLenMm: dStroke,
            invert,
          })
        : null,
    [img, tones, dSize, dSpacing, dStroke, invert],
  );

  const built = useMemo(() => {
    if (!result) return null;
    const groups = result.layers.filter((l) => l.length > 0);
    if (groups.length === 0) return null;
    return buildDesign(pathGroupsToStitches(groups, 1), NAME);
  }, [result]);

  const stitchCount = built?.stats.realStitches ?? 0;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Photo">
            <ImagePick
              fileName={fileName}
              longSide={180}
              onImage={(i, n) => {
                setImg(i);
                setFileName(n);
              }}
              hint="Portraits and fur or feather subjects work best - strokes follow the image's grain like crewel needle-painting."
            />
            <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
              <input
                type="checkbox"
                checked={invert}
                onChange={(ev) => setInvert(ev.target.checked)}
                className="accent-accent"
              />
              Paint the light (dark garments)
            </label>
          </SectionBox>

          <SectionBox eyebrow="Strokes">
            <ModeButtons
              small
              options={[
                [2, "2 tones"],
                [3, "3 tones"],
              ]}
              value={tones}
              onChange={(t) => {
                setTones(t);
                setHexes(defaultToneHexes(t));
              }}
            />
            <RangeRow label="Row spacing" value={spacing} min={0.8} max={2.5} step={0.1} onChange={setSpacing} fmt={(v) => `${v.toFixed(1)} mm`} />
            <RangeRow label="Long stroke" value={strokeLen} min={3} max={10} step={0.5} onChange={setStrokeLen} fmt={(v) => `${v.toFixed(1)} mm (short = 60%)`} />
            <SizeField valueMm={sizeMm} min={50} max={330} onChange={setSizeMm} />
          </SectionBox>

          <SectionBox eyebrow="Cones (darkest first)">
            {hexes.map((hex, i) => (
              <ThreadRow
                key={i}
                label={["Dark", "Mid", "Light"][i]}
                hex={hex}
                onChange={(h2) => setHexes((hs) => hs.map((v, j) => (j === i ? h2 : v)))}
              />
            ))}
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail
          built={built}
          colors={hexes}
          name={NAME}
          emptyHint="Drop a photo to paint it in thread."
        >
          {result && built && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              {result.layers.map((l) => l.length).join(" + ")} strokes across{" "}
              {result.layers.length} tone layers · sewn darkest-first
            </p>
          )}
          {stitchCount > 60000 && (
            <Warning>Over 60k stitches - widen the row spacing or shrink the size.</Warning>
          )}
        </PreviewRail>
      }
    />
  );
}
