// Stitch Lab tool: Reaction–Diffusion - Turing patterns in thread. Two
// virtual chemicals feed and eat each other on a grid (Gray–Scott model,
// Pearson's parameterization); depending on two numbers (f, k) the field
// settles into worms, mazes, or spots. The worm regime is the embroidery
// jackpot: stripes of near-constant width, extracted as centerlines (via the
// same thinning + tracing that powers the Redwork Router) and sewn as bean
// stitch, or as cell outlines via marching squares.
//
// Seeded and deterministic: same seed + steps = same organism = same DST.

import { useMemo, useState } from "react";
import { THREADS } from "../../data/threads";
import type { PathMm } from "../lib/generators";
import { pathsToStitches, resamplePath } from "../lib/generators";
import { mergePolylines, thin, traceSkeleton } from "../lib/lineart";
import { orderStrokes } from "./lettering";
import {
  buildDesign,
  useDebounced,
  ModeButtons,
  PreviewRail,
  RangeRow,
  SectionBox,
  ThreadRow,
  ToolLayout,
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

export type GrayScottOpts = {
  size?: number; // grid size, default 128
  f?: number; // feed, default 0.055 (worms)
  k?: number; // kill, default 0.062
  steps?: number; // default 4000
  seed?: number;
  seedPatches?: number; // initial B blobs, default 12
};

/** Run Gray–Scott; returns the B field (0..~0.5). */
export function grayScott(opts: GrayScottOpts = {}): { size: number; b: Float32Array } {
  const size = Math.max(48, Math.min(192, Math.round(opts.size ?? 128)));
  const f = opts.f ?? 0.055;
  const k = opts.k ?? 0.062;
  const steps = Math.max(200, Math.min(12000, Math.round(opts.steps ?? 4000)));
  const rand = mulberry32(opts.seed ?? 1);
  const patches = Math.max(1, opts.seedPatches ?? 12);
  const n = size * size;

  let A = new Float32Array(n).fill(1);
  let B = new Float32Array(n);
  for (let p = 0; p < patches; p++) {
    const cx = 4 + Math.floor(rand() * (size - 8));
    const cy = 4 + Math.floor(rand() * (size - 8));
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) B[(cy + dy) * size + (cx + dx)] = 1;
  }
  let A2 = new Float32Array(n);
  let B2 = new Float32Array(n);
  const dA = 1.0;
  const dB = 0.5;

  for (let s = 0; s < steps; s++) {
    for (let y = 0; y < size; y++) {
      const up = ((y + size - 1) % size) * size;
      const dn = ((y + 1) % size) * size;
      const row = y * size;
      for (let x = 0; x < size; x++) {
        const l = (x + size - 1) % size;
        const r = (x + 1) % size;
        const i = row + x;
        const lapA =
          0.2 * (A[up + x] + A[dn + x] + A[row + l] + A[row + r]) +
          0.05 * (A[up + l] + A[up + r] + A[dn + l] + A[dn + r]) -
          A[i];
        const lapB =
          0.2 * (B[up + x] + B[dn + x] + B[row + l] + B[row + r]) +
          0.05 * (B[up + l] + B[up + r] + B[dn + l] + B[dn + r]) -
          B[i];
        const abb = A[i] * B[i] * B[i];
        A2[i] = A[i] + (dA * lapA - abb + f * (1 - A[i]));
        B2[i] = B[i] + (dB * lapB + abb - (k + f) * B[i]);
      }
    }
    [A, A2] = [A2, A];
    [B, B2] = [B2, B];
  }
  return { size, b: B };
}

/** Marching-squares iso-contours of the B field at the given threshold. */
export function outlineContours(
  field: { size: number; b: Float32Array },
  threshold: number,
): PathMm[] {
  const { size, b } = field;
  const segs: { a: { x: number; y: number }; b: { x: number; y: number } }[] = [];
  const v = (x: number, y: number) => b[y * size + x];
  const lerp = (
    p: { x: number; y: number },
    q: { x: number; y: number },
    va: number,
    vb: number,
  ) => {
    const t = (threshold - va) / (vb - va || 1e-9);
    return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
  };
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const tl = v(x, y);
      const tr = v(x + 1, y);
      const br = v(x + 1, y + 1);
      const bl = v(x, y + 1);
      const code =
        (tl > threshold ? 8 : 0) | (tr > threshold ? 4 : 0) | (br > threshold ? 2 : 0) | (bl > threshold ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const P = { tl: { x, y }, tr: { x: x + 1, y }, br: { x: x + 1, y: y + 1 }, bl: { x, y: y + 1 } };
      const top = lerp(P.tl, P.tr, tl, tr);
      const right = lerp(P.tr, P.br, tr, br);
      const bottom = lerp(P.bl, P.br, bl, br);
      const left = lerp(P.tl, P.bl, tl, bl);
      const add = (a: { x: number; y: number }, c: { x: number; y: number }) => segs.push({ a, b: c });
      switch (code) {
        case 1: add(left, bottom); break;
        case 2: add(bottom, right); break;
        case 3: add(left, right); break;
        case 4: add(top, right); break;
        case 5: add(left, top); add(bottom, right); break;
        case 6: add(top, bottom); break;
        case 7: add(left, top); break;
        case 8: add(top, left); break;
        case 9: add(top, bottom); break;
        case 10: add(top, right); add(bottom, left); break;
        case 11: add(top, right); break;
        case 12: add(right, left); break;
        case 13: add(right, bottom); break;
        case 14: add(bottom, left); break;
      }
    }
  }
  return mergePolylines(segs.map((s) => [s.a, s.b]), 0.01);
}

/** Worm centerlines: threshold → thin → trace → merge. */
export function spineLines(field: { size: number; b: Float32Array }, threshold: number): PathMm[] {
  const { size, b } = field;
  const bin = new Uint8Array(size * size);
  for (let i = 0; i < bin.length; i++) bin[i] = b[i] > threshold ? 1 : 0;
  const skel = thin(bin, size, size);
  return mergePolylines(traceSkeleton(skel, size, size), 1.6);
}

// ─── Component ───────────────────────────────────────────────────────────

const NAME = "bayside-reaction";

const PRESETS = [
  { id: "worms", name: "Worms", f: 0.055, k: 0.062 },
  { id: "maze", name: "Maze", f: 0.029, k: 0.057 },
  { id: "spots", name: "Spots", f: 0.035, k: 0.065 },
] as const;

export default function ReactionTool() {
  const [preset, setPreset] = useState<"worms" | "maze" | "spots">("worms");
  const [steps, setSteps] = useState(4000);
  const [seed, setSeed] = useState(1952); // Turing's paper
  const [threshold, setThreshold] = useState(0.18);
  const [mode, setMode] = useState<"spine" | "outline">("spine");
  const [sizeMm, setSizeMm] = useState(100);
  const [stitchLen, setStitchLen] = useState(2.2);
  const [bean, setBean] = useState<1 | 3>(3);
  const [threadHex, setThreadHex] = useState(
    THREADS.find((t) => t.family === "Orange" && t.hex)?.hex ??
      THREADS.find((t) => t.hex)?.hex ??
      "#082870",
  );

  const dSteps = useDebounced(steps, 350);
  const field = useMemo(() => {
    const p = PRESETS.find((x) => x.id === preset)!;
    return grayScott({ f: p.f, k: p.k, steps: dSteps, seed });
  }, [preset, dSteps, seed]);

  const built = useMemo(() => {
    const raw = mode === "spine" ? spineLines(field, threshold) : outlineContours(field, threshold);
    if (raw.length === 0) return null;
    const scale = sizeMm / field.size;
    const half = (field.size * scale) / 2;
    const inMm = raw.map((p) => p.map((q) => ({ x: q.x * scale - half, y: q.y * scale - half })));
    const len = (p: PathMm) => {
      let L = 0;
      for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
      return L;
    };
    const kept = inMm.filter((p) => len(p) >= 6);
    const sampled = kept.map((p) => resamplePath(p, stitchLen, 0.4)).filter((p) => p.length >= 2);
    if (sampled.length === 0) return null;
    return buildDesign(pathsToStitches(orderStrokes(sampled), bean), NAME);
  }, [field, threshold, mode, sizeMm, stitchLen, bean]);

  const stitchCount = built?.stats.realStitches ?? 0;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Chemistry">
            <ModeButtons
              options={PRESETS.map((p) => [p.id, p.name] as const)}
              value={preset}
              onChange={setPreset}
            />
            <RangeRow label="Settle steps" value={steps} min={1000} max={9000} step={250} onChange={setSteps} fmt={(v) => `${v} steps`} />
            <button
              onClick={() => setSeed(Math.floor(Math.random() * 100000))}
              className="border border-hairline bg-bg px-3 py-1 text-[0.75rem] text-fg hover:bg-card"
            >
              New culture (seed {seed})
            </button>
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Two chemicals feed and eat each other until a pattern freezes out - the
              same math behind zebrafish stripes and fingertip ridges. Worms are the
              embroidery jackpot: stripes at nearly constant width.
            </p>
          </SectionBox>

          <SectionBox eyebrow="Extraction">
            <ModeButtons
              small
              options={[
                ["spine", "Spines (worm centerlines)"],
                ["outline", "Outlines (cell walls)"],
              ]}
              value={mode}
              onChange={setMode}
            />
            <RangeRow label="Threshold" value={threshold} min={0.08} max={0.32} step={0.01} onChange={setThreshold} fmt={(v) => v.toFixed(2)} />
          </SectionBox>

          <SectionBox eyebrow="Stitches">
            <SizeField valueMm={sizeMm} min={50} max={330} onChange={setSizeMm} />
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
          emptyHint="Run the reaction - the pattern appears as soon as it's sewable."
        >
          {built && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              travel-ordered organic {mode === "spine" ? "spines" : "cells"} ·{" "}
              {built.stats.stitchPathM.toFixed(1)} m of pattern
            </p>
          )}
          {stitchCount > 60000 && (
            <Warning>Over 60k stitches - raise the threshold or shrink the size.</Warning>
          )}
        </PreviewRail>
      }
    />
  );
}
