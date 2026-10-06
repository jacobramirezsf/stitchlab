// Turing Skin - reaction-diffusion grown ON a photo. Gray-Scott chemistry
// runs with the feed rate mapped from the photo's tone (dark → worm/labyrinth
// regimes, light → decay), optionally combed along the image's edge-tangent
// flow, so the picture re-emerges as organic Turing patterning. The pattern
// field is skeletonized into paths, so the result sews as running-stitch worms.
// Validated in scripts/research-exp7.ts.

import { useMemo, useState } from "react";
import {
  ToolLayout,
  SectionBox,
  RangeRow,
  ImagePick,
  ThreadRow,
  PreviewRail,
  Warning,
  buildDesign,
  useDebouncedKey,
  useUnits,
  fmtLen,
  type LumImg,
} from "./shared";
import { THREADS } from "../../data/threads";
import { pathsToStitches, resamplePath, fitPaths, routeStrokes } from "../lib/generators";
import { normalizeContrast, edgeTangentFlow, thin, traceSkeleton, mergePolylines } from "../lib/lineart";

const NAME = "bayside-turing";
const DEFAULT_THREAD = THREADS.find((t) => t.code === "1000")?.hex ?? "#111111";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function growTuring(img: { w: number; h: number; lum: Float32Array }, steps: number, aniso: number, character: number): { B: Float32Array; w: number; h: number } {
  const { w, h, lum } = img;
  const n = w * h;
  const etf = edgeTangentFlow({ w, h, lum }, 4, 2);
  const A = new Float32Array(n).fill(1);
  const B = new Float32Array(n).fill(0);
  const rand = mulberry32(3);
  for (let i = 0; i < n; i++) if (1 - lum[i] > 0.35 && rand() < 0.02) B[i] = 1;
  // character 0..1 slides the dark-end regime from tight spots toward long worms
  const F = new Float32Array(n), K = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dark = 1 - lum[i];
    F[i] = 0.082 - (0.036 + 0.018 * character) * dark;
    K[i] = 0.061 + 0.002 * dark;
  }
  const A2 = new Float32Array(n), B2 = new Float32Array(n);
  const Db = 0.45;
  for (let step = 0; step < steps; step++) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const wl = 1 + aniso * Math.abs(etf.tx[i]);
        const wu = 1 + aniso * Math.abs(etf.ty[i]);
        const wsum = 2 * wl + 2 * wu + 0.8;
        const lapA = (wl * (A[i - 1] + A[i + 1]) + wu * (A[i - w] + A[i + w])
          + 0.2 * (A[i - w - 1] + A[i - w + 1] + A[i + w - 1] + A[i + w + 1])) / wsum - A[i];
        const lapB = (wl * (B[i - 1] + B[i + 1]) + wu * (B[i - w] + B[i + w])
          + 0.2 * (B[i - w - 1] + B[i - w + 1] + B[i + w - 1] + B[i + w + 1])) / wsum - B[i];
        const abb = A[i] * B[i] * B[i];
        A2[i] = A[i] + (lapA - abb + F[i] * (1 - A[i]));
        B2[i] = B[i] + (Db * lapB + abb - (K[i] + F[i]) * B[i]);
      }
    }
    A.set(A2); B.set(B2);
  }
  return { B, w, h };
}

export default function TuringTool() {
  const units = useUnits();
  const [img, setImg] = useState<LumImg | null>(null);
  const [fileName, setFileName] = useState("");
  const [character, setCharacter] = useState(0.7);
  const [aniso, setAniso] = useState(0.65);
  const [steps, setSteps] = useState(2200);
  const [sizeMm, setSizeMm] = useState(150);
  const [threadHex, setThreadHex] = useState(DEFAULT_THREAD);

  const genKey = useDebouncedKey([fileName, character, aniso, steps], 300);
  const paths = useMemo(() => {
    if (!img) return [];
    // the simulation is the slow part - keep the grid modest
    const norm = normalizeContrast({ w: img.w, h: img.h, lum: img.lum });
    const { B, w, h } = growTuring(norm, steps, aniso, character);
    const binary = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) binary[i] = B[i] > 0.18 ? 1 : 0;
    const skel = thin(binary, w, h);
    return mergePolylines(traceSkeleton(skel, w, h), 2.5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, genKey]);

  const built = useMemo(() => {
    if (!paths.length) return null;
    const fitted = routeStrokes(fitPaths(paths, sizeMm), { orOptMs: 120 })
      .map((p) => resamplePath(p, 2, 0.4));
    return buildDesign(pathsToStitches(fitted, 1), NAME);
  }, [paths, sizeMm]);

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="photo">
            <ImagePick onImage={(i, n) => { setImg(i); setFileName(n); }} fileName={fileName} longSide={280}
              hint="The chemistry only lives where the photo is dark - bold subjects work best." />
          </SectionBox>
          <SectionBox eyebrow="chemistry">
            <RangeRow label="Character" value={character} min={0} max={1} step={0.05} onChange={setCharacter}
              fmt={(v) => (v < 0.35 ? "spots" : v < 0.7 ? "mixed" : "worms")} />
            <RangeRow label="Comb along flow" value={aniso} min={0} max={1.2} step={0.05} onChange={setAniso} fmt={(v) => v.toFixed(2)} />
            <RangeRow label="Settle steps" value={steps} min={800} max={3600} step={200} onChange={setSteps} fmt={(v) => `${v}`} />
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              A reaction-diffusion pattern grows only where your photo is dark, so the
              image re-forms as living spots and worms. Combing bends the pattern along
              the photo's own grain; more steps let it settle into cleaner shapes.
            </p>
          </SectionBox>
          <SectionBox eyebrow="stitch">
            <RangeRow label="Size" value={sizeMm} min={60} max={300} step={5} onChange={setSizeMm} fmt={(v) => fmtLen(v, units)} />
            <ThreadRow hex={threadHex} onChange={setThreadHex} />
          </SectionBox>
          {built && built.stats.realStitches > 60000 && (
            <Warning>Over 60k stitches - shrink the size or lower the settle steps before stitching.</Warning>
          )}
        </>
      }
      preview={
        <PreviewRail built={built} colors={[threadHex]} name={NAME} emptyHint="Load a photo - it grows a Turing-pattern skin.">
          {built && (
            <p className="text-[0.6875rem] text-mid tabular-nums">
              {paths.length.toLocaleString()} worms · {built.stats.realStitches.toLocaleString()} stitches
            </p>
          )}
        </PreviewRail>
      }
    />
  );
}
