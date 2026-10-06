// Stitch Lab tool: Directional - a photo as streamlines that follow its own
// grain, packed denser where it's darker. This is our take on
// "Directionality-Aware Design of Embroidery Patterns" (Liu et al.,
// Eurographics 2023): thread is anisotropic, so stitch DIRECTION carries
// appearance as much as density does. The engine marries our two fields -
// structure-tensor orientation (which way) and luminance (how dense) - inside
// a Jobard–Lefér evenly-spaced-streamline builder whose separation varies
// point by point with the image's tone.

import { useMemo, useState } from "react";
import { THREADS } from "../../data/threads";
import type { PathMm } from "../lib/generators";
import { pathsToStitches, resamplePath } from "../lib/generators";
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

export type DirectionalOpts = {
  sizeMm?: number; // long side, default 110
  minSepMm?: number; // spacing in the darkest areas, default 1.2
  maxSepMm?: number; // spacing in the lightest sewn areas, default 5
  lightCutoff?: number; // luminance above this stays bare fabric, default 0.88
  invert?: boolean;
};

export function directionalStreamlines(
  img: { w: number; h: number; lum: Float32Array },
  opts: DirectionalOpts = {},
): PathMm[] {
  const sizeMm = opts.sizeMm ?? 110;
  const minSep = opts.minSepMm ?? 1.2;
  const maxSep = opts.maxSepMm ?? 5;
  const cutoff = opts.lightCutoff ?? 0.88;
  const { w, h } = img;
  const scale = sizeMm / Math.max(w, h);
  const W = w * scale;
  const H = h * scale;
  const field = orientationField(img, 4);

  const lumAt = (x: number, y: number): number => {
    const px = Math.min(w - 1, Math.max(0, Math.round(x / scale)));
    const py = Math.min(h - 1, Math.max(0, Math.round(y / scale)));
    const v = img.lum[py * w + px];
    return opts.invert ? 1 - v : v;
  };
  const thetaAt = (x: number, y: number): number => {
    const px = Math.min(w - 1, Math.max(0, Math.round(x / scale)));
    const py = Math.min(h - 1, Math.max(0, Math.round(y / scale)));
    return field.theta[py * w + px];
  };
  const sepAt = (x: number, y: number): number => {
    const l = lumAt(x, y);
    return minSep + (maxSep - minSep) * Math.min(1, l / cutoff);
  };

  // Occupancy grid at minSep/2 for separation tests.
  const cell = minSep / 2;
  const gw = Math.ceil(W / cell) + 1;
  const gh = Math.ceil(H / cell) + 1;
  const buckets = new Map<number, { x: number; y: number; line: number }[]>();
  const bkey = (x: number, y: number) =>
    Math.min(gh - 1, Math.floor(y / cell)) * gw + Math.min(gw - 1, Math.floor(x / cell));
  const record = (x: number, y: number, line: number) => {
    const k = bkey(x, y);
    const b = buckets.get(k);
    if (b) b.push({ x, y, line });
    else buckets.set(k, [{ x, y, line }]);
  };
  const tooClose = (x: number, y: number, line: number, sep: number): boolean => {
    const r = Math.ceil(sep / cell);
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let gy = cy - r; gy <= cy + r; gy++) {
      for (let gx = cx - r; gx <= cx + r; gx++) {
        if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
        const b = buckets.get(gy * gw + gx);
        if (!b) continue;
        for (const p of b) {
          if (p.line === line) continue;
          // 0.8 (not 0.9): with tone-varying separation a line spawned at the
          // dark side's spacing must survive testing against the light side's
          // larger demand, or the seed queue starves on any gradient.
          if (Math.hypot(p.x - x, p.y - y) < sep * 0.8) return true;
        }
      }
    }
    return false;
  };

  const paths: PathMm[] = [];
  const queue: { x: number; y: number }[] = [];
  // Seed at the darkest pixel.
  {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < img.lum.length; i += 7) {
      const v = opts.invert ? 1 - img.lum[i] : img.lum[i];
      if (v < bd) {
        bd = v;
        best = i;
      }
    }
    queue.push({ x: ((best % w) + 0.5) * scale, y: (Math.floor(best / w) + 0.5) * scale });
  }

  const step = minSep * 0.45;
  while (queue.length && paths.length < 900) {
    const seed = queue.shift()!;
    if (seed.x < 0 || seed.y < 0 || seed.x > W || seed.y > H) continue;
    if (lumAt(seed.x, seed.y) >= cutoff) continue;
    if (tooClose(seed.x, seed.y, -1, sepAt(seed.x, seed.y))) continue;

    const lineId = paths.length;
    const halves: PathMm[] = [];
    for (const sgn of [1, -1]) {
      const half: PathMm = [];
      let x = seed.x;
      let y = seed.y;
      let prevTh = thetaAt(x, y);
      for (let s = 0; s < 1200; s++) {
        // RK2 midpoint along the orientation field, sign-corrected so the
        // 180°-ambiguous field doesn't fold the line back on itself.
        let th1 = thetaAt(x, y);
        if (Math.cos(th1 - prevTh) < 0) th1 += Math.PI;
        const mx = x + (Math.cos(th1) * step * sgn) / 2;
        const my = y + (Math.sin(th1) * step * sgn) / 2;
        let th2 = thetaAt(mx, my);
        if (Math.cos(th2 - th1) < 0) th2 += Math.PI;
        const nx = x + Math.cos(th2) * step * sgn;
        const ny = y + Math.sin(th2) * step * sgn;
        if (nx < 0 || ny < 0 || nx > W || ny > H) break;
        if (lumAt(nx, ny) >= cutoff) break;
        if (tooClose(nx, ny, lineId, sepAt(nx, ny))) break;
        x = nx;
        y = ny;
        prevTh = th2;
        half.push({ x, y });
        record(x, y, lineId);
      }
      halves.push(half);
    }
    const line = [...halves[1].reverse(), seed, ...halves[0]];
    if (line.length < 4) continue;
    record(seed.x, seed.y, lineId);
    paths.push(line);
    // Candidate seeds perpendicular to every few points. Offset is refined
    // once against the DESTINATION's separation so a seed leaving a dark
    // stripe for a lighter one is placed at the spacing the light side wants.
    for (let i = 0; i < line.length; i += 3) {
      const p = line[i];
      const th = thetaAt(p.x, p.y);
      for (const dir of [1, -1]) {
        let sep = sepAt(p.x, p.y);
        let sx = p.x - Math.sin(th) * sep * dir;
        let sy = p.y + Math.cos(th) * sep * dir;
        const sep2 = sepAt(sx, sy);
        if (Math.abs(sep2 - sep) > 0.05) {
          sx = p.x - Math.sin(th) * sep2 * dir;
          sy = p.y + Math.cos(th) * sep2 * dir;
        }
        queue.push({ x: sx, y: sy });
      }
    }
  }

  // Center on origin.
  return paths.map((p) => p.map((q) => ({ x: q.x - W / 2, y: q.y - H / 2 })));
}

// ─── Component ───────────────────────────────────────────────────────────

const NAME = "bayside-directional";

export default function DirectionalTool() {
  const [img, setImg] = useState<LumImg | null>(null);
  const [fileName, setFileName] = useState("");
  const [sizeMm, setSizeMm] = useState(110);
  const [minSep, setMinSep] = useState(1.2);
  const [maxSep, setMaxSep] = useState(5);
  const [cutoff, setCutoff] = useState(0.88);
  const [invert, setInvert] = useState(false);
  const [stitchLen, setStitchLen] = useState(2.4);
  const [bean, setBean] = useState<1 | 3>(1);
  const [threadHex, setThreadHex] = useState(
    THREADS.find((t) => t.family === "Grey" && t.hex)?.hex ??
      THREADS.find((t) => t.hex)?.hex ??
      "#1c1c1a",
  );

  const dMin = useDebounced(minSep);
  const dMax = useDebounced(maxSep);
  const dCut = useDebounced(cutoff);
  const dSize = useDebounced(sizeMm);

  const paths = useMemo(
    () =>
      img
        ? directionalStreamlines(img, {
            sizeMm: dSize,
            minSepMm: dMin,
            maxSepMm: Math.max(dMax, dMin + 0.5),
            lightCutoff: dCut,
            invert,
          })
        : null,
    [img, dSize, dMin, dMax, dCut, invert],
  );

  const built = useMemo(() => {
    if (!paths || paths.length === 0) return null;
    return buildDesign(
      pathsToStitches(paths.map((p) => resamplePath(p, stitchLen, 0.4)), bean),
      NAME,
    );
  }, [paths, stitchLen, bean]);

  const stitchCount = built?.stats.realStitches ?? 0;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Photo">
            <ImagePick
              fileName={fileName}
              longSide={200}
              onImage={(i, n) => {
                setImg(i);
                setFileName(n);
              }}
              hint="The engine reads two things from your photo: which way its texture flows, and where it's dark. Lines follow the flow; darkness packs them tighter."
            />
            <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
              <input
                type="checkbox"
                checked={invert}
                onChange={(ev) => setInvert(ev.target.checked)}
                className="accent-accent"
              />
              Stitch the light (dark garments)
            </label>
          </SectionBox>

          <SectionBox eyebrow="Density">
            <RangeRow label="Darkest spacing" value={minSep} min={0.8} max={2.5} step={0.1} onChange={setMinSep} fmt={(v) => `${v.toFixed(1)} mm`} />
            <RangeRow label="Lightest spacing" value={maxSep} min={3} max={8} step={0.5} onChange={setMaxSep} fmt={(v) => `${v.toFixed(1)} mm`} />
            <RangeRow label="Leave fabric above" value={cutoff} min={0.7} max={0.98} step={0.01} onChange={setCutoff} fmt={(v) => `${Math.round(v * 100)}% light`} />
            <SizeField valueMm={sizeMm} min={60} max={330} onChange={setSizeMm} />
          </SectionBox>

          <SectionBox eyebrow="Stitches">
            <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={5} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
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
        <PreviewRail
          built={built}
          colors={[threadHex]}
          name={NAME}
          emptyHint="Drop a photo - its grain becomes the stitch direction."
        >
          {paths && built && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              {paths.length} streamlines following the image's grain · density = tone
            </p>
          )}
          {stitchCount > 60000 && (
            <Warning>Over 60k stitches - open the spacing or raise the bare cutoff.</Warning>
          )}
        </PreviewRail>
      }
    />
  );
}
