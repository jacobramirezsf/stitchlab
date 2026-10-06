// Stitch Lab tool: Fractal Turtle - L-system curves as continuous stitch paths.
//
// Why fractals belong on an embroidery machine: the classic space-filling
// curves (Hilbert, dragon, Gosper flowsnake, Sierpinski arrowhead, Koch) are
// one unbroken line. No islands, no pen lifts - the whole design sews as a
// single continuous running stitch with ZERO trims. The turtle speaks the
// standard L-system alphabet: F/G draw forward (other letters are silent
// variables), f moves pen-up, + and −
// turn, [ ] push/pop for branching systems like the fractal plant.
//
// Pure logic (expandLSystem, expandLSystemStochastic, turtlePaths,
// clipPathsToRings, FRACTAL_PRESETS) has no DOM and is exported for node-side
// testing; everything browser-shaped stays in the component below.
//
// Also here: stochastic rules (alternatives split on '|', seeded so a lucky
// plant can be grown again), and meander fill - a Hilbert curve clipped to a
// shape, the stipple texture that straight tatami rows can't make.

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
  Warning,
  SizeField,
} from "./shared";
import { shapeRings } from "./tatami";

// ─── Pure logic ──────────────────────────────────────────────────────────

export type LSystemSpec = { axiom: string; rules: Record<string, string>; angleDeg: number };

/**
 * Rewrite the axiom `iterations` times. Length is checked while each pass is
 * being built, so a runaway rule set throws before it eats the tab's memory
 * instead of after.
 */
export function expandLSystem(spec: LSystemSpec, iterations: number, maxLen = 600000): string {
  const explode = () => new Error("This combination explodes - lower the iterations.");
  let program = spec.axiom;
  if (program.length > maxLen) throw explode();
  for (let pass = 0; pass < iterations; pass++) {
    const parts: string[] = [];
    let len = 0;
    for (const ch of program) {
      const sub = spec.rules[ch] ?? ch;
      len += sub.length;
      if (len > maxLen) throw explode();
      parts.push(sub);
    }
    program = parts.join("");
  }
  return program;
}

/** Deterministic 32-bit PRNG (mulberry32). Same seed, same plant. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stochastic rewrite: a rule value may hold alternatives separated by '|'
 * (like F=F[+F]F|F[-F]F), and each substitution picks one uniformly with a
 * seeded mulberry32 PRNG. Every seed grows a different plant; the same seed
 * grows the same plant every time. Same explosion guard as expandLSystem.
 */
export function expandLSystemStochastic(
  spec: LSystemSpec,
  iterations: number,
  seed: number,
  maxLen = 600000,
): string {
  const explode = () => new Error("This combination explodes - lower the iterations.");
  const rand = mulberry32(seed);
  let program = spec.axiom;
  if (program.length > maxLen) throw explode();
  for (let pass = 0; pass < iterations; pass++) {
    const parts: string[] = [];
    let len = 0;
    for (const ch of program) {
      const rule = spec.rules[ch];
      let sub: string;
      if (rule === undefined) {
        sub = ch;
      } else if (rule.includes("|")) {
        const alts = rule.split("|");
        sub = alts[Math.floor(rand() * alts.length)];
      } else {
        sub = rule;
      }
      len += sub.length;
      if (len > maxLen) throw explode();
      parts.push(sub);
    }
    program = parts.join("");
  }
  return program;
}

/**
 * Standard L-system turtle in unit steps, y-down screen space.
 * F G draw forward (A B X Y are silent variables) · f moves pen-up · + turns left
 * angleDeg · − turns right · [ pushes (pos, heading) · ] pops (breaks the
 * path). Every other symbol is a no-op, so bookkeeping letters like X and Y
 * pass through silently. Returns one PathMm per continuous pen-down run -
 * for the space-filling classics that's exactly one path.
 */
export function turtlePaths(program: string, angleDeg: number): PathMm[] {
  const turn = (angleDeg * Math.PI) / 180;
  const paths: PathMm[] = [];
  const stack: { x: number; y: number; heading: number }[] = [];
  let cur: PathMm = [];
  let x = 0;
  let y = 0;
  let heading = 0;
  const flush = () => {
    if (cur.length >= 2) paths.push(cur);
    cur = [];
  };
  for (const ch of program) {
    if (ch === "F" || ch === "G") {
      const nx = x + Math.cos(heading);
      const ny = y + Math.sin(heading);
      if (cur.length === 0) cur.push({ x, y });
      cur.push({ x: nx, y: ny });
      x = nx;
      y = ny;
    } else if (ch === "f") {
      flush();
      x += Math.cos(heading);
      y += Math.sin(heading);
    } else if (ch === "+") {
      heading -= turn; // y-down: decreasing heading rotates counterclockwise on screen = left
    } else if (ch === "-") {
      heading += turn;
    } else if (ch === "[") {
      stack.push({ x, y, heading });
    } else if (ch === "]") {
      const top = stack.pop();
      if (top) {
        flush();
        x = top.x;
        y = top.y;
        heading = top.heading;
      }
    }
  }
  flush();
  return paths;
}

// ─── Meander fill: clip a curve to a shape ───────────────────────────────

type ClipHit = { t: number; x: number; y: number; ring: number; arc: number };

/** Even-odd point-in-polygon over a set of rings (nested rings are holes). */
function insideRings(rings: { x: number; y: number }[][], px: number, py: number): boolean {
  let odd = false;
  for (const ring of rings) {
    const n = ring.length;
    for (let j = 0, k = n - 1; j < n; k = j++) {
      const a = ring[j];
      const b = ring[k];
      if (a.y > py !== b.y > py) {
        const xInt = a.x + ((py - a.y) / (b.y - a.y)) * (b.x - a.x);
        if (px < xInt) odd = !odd;
      }
    }
  }
  return odd;
}

/**
 * Ring vertices strictly between arc position fromArc and fromArc ± dist,
 * walking direction dir (+1 with the ring's winding, −1 against it).
 */
function ringVerticesBetween(
  ring: { x: number; y: number }[],
  cum: number[],
  fromArc: number,
  dist: number,
  dir: 1 | -1,
): PathMm {
  const n = ring.length;
  const P = cum[n];
  const out: PathMm = [];
  if (dir === 1) {
    let j = 0;
    while (j < n && cum[j] <= fromArc + 1e-9) j++;
    for (let m = 0; m < n; m++) {
      const vi = (j + m) % n;
      const pos = cum[vi] > fromArc + 1e-9 ? cum[vi] - fromArc : cum[vi] + P - fromArc;
      if (pos >= dist - 1e-9) break;
      out.push({ x: ring[vi].x, y: ring[vi].y });
    }
  } else {
    let j = n - 1;
    while (j >= 0 && cum[j] >= fromArc - 1e-9) j--;
    for (let m = 0; m < n; m++) {
      const vi = (((j - m) % n) + n) % n;
      const pos = cum[vi] < fromArc - 1e-9 ? fromArc - cum[vi] : fromArc + P - cum[vi];
      if (pos >= dist - 1e-9) break;
      out.push({ x: ring[vi].x, y: ring[vi].y });
    }
  }
  return out;
}

/**
 * Walk the ring's own polyline from one crossing to another, the shorter way
 * around, resampled at 1.5 mm so the walk sews as stitches. Returns null when
 * the walk would run longer than 4× the direct gap - better to jump honestly
 * than drag thread halfway around the shape.
 */
function ringConnector(
  ring: { x: number; y: number }[],
  cum: number[],
  from: ClipHit,
  to: ClipHit,
): PathMm | null {
  const P = cum[cum.length - 1];
  if (!(P > 1e-9)) return null;
  const direct = Math.hypot(to.x - from.x, to.y - from.y);
  const fwd = (((to.arc - from.arc) % P) + P) % P;
  const back = P - fwd;
  const dist = Math.min(fwd, back);
  if (dist > 4 * direct + 1e-9) return null;
  const dir: 1 | -1 = fwd <= back ? 1 : -1;
  const mids = ringVerticesBetween(ring, cum, from.arc, dist, dir);
  const poly: PathMm = [{ x: from.x, y: from.y }, ...mids, { x: to.x, y: to.y }];
  return resamplePath(poly, 1.5);
}

/**
 * Clip polylines to a polygon-with-holes (even-odd rule). Runs of inside
 * points become output paths, cut exactly at the boundary. When the same
 * source path exits and re-enters through the same ring, the two runs are
 * joined by walking the ring's outline between the crossing points (shorter
 * direction, resampled at 1.5 mm), so a space-filling curve stays one
 * continuous thread instead of shattering into jumps. Walks longer than 4×
 * the direct gap break instead - the machine jumps there.
 */
export function clipPathsToRings(paths: PathMm[], rings: { x: number; y: number }[][]): PathMm[] {
  const rs = rings.filter((r) => r.length >= 3);
  if (rs.length === 0) return [];
  const cums = rs.map((r) => {
    const cum: number[] = [0];
    for (let i = 0; i < r.length; i++) {
      const a = r[i];
      const b = r[(i + 1) % r.length];
      cum.push(cum[i] + Math.hypot(b.x - a.x, b.y - a.y));
    }
    return cum;
  });

  const out: PathMm[] = [];
  for (const path of paths) {
    if (path.length < 2) continue;
    let active: PathMm | null = null;
    let exitHit: ClipHit | null = null;
    const flush = () => {
      if (active && active.length >= 2) out.push(active);
      active = null;
    };

    let state = insideRings(rs, path[0].x, path[0].y);
    if (state) active = [{ x: path[0].x, y: path[0].y }];

    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      // Every crossing of this segment with any ring edge, in travel order.
      const hits: ClipHit[] = [];
      const rx = b.x - a.x;
      const ry = b.y - a.y;
      for (let ri = 0; ri < rs.length; ri++) {
        const ring = rs[ri];
        const cum = cums[ri];
        const n = ring.length;
        for (let j = 0; j < n; j++) {
          const c = ring[j];
          const d = ring[(j + 1) % n];
          const sx = d.x - c.x;
          const sy = d.y - c.y;
          const denom = rx * sy - ry * sx;
          if (Math.abs(denom) < 1e-12) continue;
          const qx = c.x - a.x;
          const qy = c.y - a.y;
          const t = (qx * sy - qy * sx) / denom;
          if (t <= 1e-9 || t >= 1 - 1e-9) continue;
          const u = (qx * ry - qy * rx) / denom;
          if (u < 0 || u >= 1) continue; // half-open: shared ring vertices count once
          hits.push({
            t,
            x: a.x + rx * t,
            y: a.y + ry * t,
            ring: ri,
            arc: cum[j] + u * (cum[j + 1] - cum[j]),
          });
        }
      }
      hits.sort((h1, h2) => h1.t - h2.t);

      for (const h of hits) {
        if (state) {
          // Leaving the shape: end the run exactly on the boundary.
          if (active) active.push({ x: h.x, y: h.y });
          exitHit = h;
          state = false;
        } else {
          // Re-entering: try to walk the boundary over from the last exit.
          const conn =
            active && exitHit && exitHit.ring === h.ring
              ? ringConnector(rs[h.ring], cums[h.ring], exitHit, h)
              : null;
          if (active && conn) {
            for (let k = 1; k < conn.length; k++) active.push(conn[k]);
          } else {
            flush();
            active = [{ x: h.x, y: h.y }];
          }
          exitHit = null;
          state = true;
        }
      }

      // Resync against the truth at b - a tangency or vertex graze can slip
      // past the crossing test, and silent drift would corrupt the whole clip.
      const truth = insideRings(rs, b.x, b.y);
      if (truth !== state) {
        if (truth) {
          flush();
          active = [];
          exitHit = null;
        }
        state = truth;
      }
      if (state) {
        if (!active) active = [];
        active.push({ x: b.x, y: b.y });
      }
    }
    flush();
  }
  return out;
}

export const FRACTAL_PRESETS: {
  id: string;
  name: string;
  spec: LSystemSpec;
  defaultIterations: number;
  maxIterations: number;
}[] = [
  {
    id: "hilbert",
    name: "Hilbert curve",
    spec: { axiom: "X", rules: { X: "+YF-XFX-FY+", Y: "-XF+YFY+FX-" }, angleDeg: 90 },
    defaultIterations: 5,
    maxIterations: 7,
  },
  {
    id: "moore",
    name: "Moore curve (closed)",
    spec: { axiom: "LFL+F+LFL", rules: { L: "-RF+LFL+FR-", R: "+LF-RFR-FL+" }, angleDeg: 90 },
    defaultIterations: 4,
    maxIterations: 6,
  },
  {
    id: "peano",
    name: "Peano curve",
    spec: {
      axiom: "L",
      rules: { L: "LFRFL-F-RFLFR+F+LFRFL", R: "RFLFR+F+LFRFL-F-RFLFR" },
      angleDeg: 90,
    },
    defaultIterations: 3,
    maxIterations: 4,
  },
  {
    id: "dragon",
    name: "Dragon curve",
    spec: { axiom: "FX", rules: { X: "X+YF+", Y: "-FX-Y" }, angleDeg: 90 },
    defaultIterations: 11,
    maxIterations: 15,
  },
  {
    id: "terdragon",
    name: "Terdragon",
    spec: { axiom: "F", rules: { F: "F+F-F" }, angleDeg: 120 },
    defaultIterations: 8,
    maxIterations: 11,
  },
  {
    id: "levy",
    name: "Lévy C curve",
    spec: { axiom: "F", rules: { F: "+F--F+" }, angleDeg: 45 },
    defaultIterations: 10,
    maxIterations: 14,
  },
  {
    id: "koch",
    name: "Koch snowflake",
    spec: { axiom: "F--F--F", rules: { F: "F+F--F+F" }, angleDeg: 60 },
    defaultIterations: 4,
    maxIterations: 6,
  },
  {
    id: "gosper",
    name: "Gosper flowsnake",
    spec: { axiom: "F", rules: { F: "F-G--G+F++FF+G-", G: "+F-GG--G-F++F+G" }, angleDeg: 60 },
    defaultIterations: 3,
    maxIterations: 5,
  },
  {
    id: "sierpinski",
    name: "Sierpinski arrowhead",
    spec: { axiom: "F", rules: { F: "G-F-G", G: "F+G+F" }, angleDeg: 60 },
    defaultIterations: 6,
    maxIterations: 9,
  },
  {
    id: "plant",
    name: "Fractal plant",
    spec: { axiom: "X", rules: { X: "F+[[X]-X]-F[-FX]+X", F: "FF" }, angleDeg: 25 },
    defaultIterations: 5,
    maxIterations: 7,
  },
  {
    // Stochastic rules - the '|' alternatives are picked per-substitution by
    // a seeded PRNG (expandLSystemStochastic), so every seed is a new plant.
    id: "wildplant",
    name: "Wild plant",
    spec: {
      axiom: "X",
      rules: { X: "F+[[X]-X]-F[-FX]+X|F-[[X]+X]+F[+FX]-X", F: "FF|FF" },
      angleDeg: 22.5,
    },
    defaultIterations: 5,
    maxIterations: 6,
  },
];

// ─── Component ───────────────────────────────────────────────────────────

const PRESET_LABELS: Record<string, string> = {
  hilbert: "Hilbert",
  moore: "Moore",
  peano: "Peano",
  dragon: "Dragon",
  terdragon: "Terdragon",
  levy: "Lévy C",
  koch: "Koch",
  gosper: "Gosper",
  sierpinski: "Arrowhead",
  plant: "Plant",
  wildplant: "Wild plant",
};

/** Parse "X=F+X" lines into a rule map. Throws with a friendly message. */
function parseRules(text: string): Record<string, string> {
  const rules: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(.)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      throw new Error(`Rules are one per line, one symbol each - like X=F+X. Couldn't read "${line}".`);
    }
    rules[m[1]] = m[2].replace(/\s+/g, "");
  }
  return rules;
}

const INPUT_CLASS =
  "mt-1 w-full border border-hairline bg-bg text-fg px-2 py-1.5 text-[0.8125rem] font-mono";

export default function FractalTool() {
  const [modeId, setModeId] = useState("hilbert");
  const [iterBy, setIterBy] = useState<Record<string, number>>({});
  const [sizeMm, setSizeMm] = useState(120);
  const [stitchLen, setStitchLen] = useState(2.8);
  const [bean, setBean] = useState<1 | 3>(1);
  const [threadHex, setThreadHex] = useState(
    () => THREADS.find((t) => t.code === "1568")?.hex ?? "#082870",
  );

  // Custom system (defaults to the Lévy C curve - another zero-trim classic)
  const [customAxiom, setCustomAxiom] = useState("F");
  const [customRules, setCustomRules] = useState("F=+F--F+");
  const [customAngle, setCustomAngle] = useState("45");

  // Stochastic seed - the dice
  const [seed, setSeed] = useState(1);

  // Meander fill
  const [meanderShape, setMeanderShape] = useState<"circle" | "star" | "heart" | "ring">("circle");
  const [meanderOrder, setMeanderOrder] = useState(6);
  const [meanderSizeMm, setMeanderSizeMm] = useState(90);

  const isMeander = modeId === "meander";
  const preset = FRACTAL_PRESETS.find((p) => p.id === modeId);
  const maxIter = preset?.maxIterations ?? 12;
  const iterations = Math.min(
    maxIter,
    Math.max(1, iterBy[modeId] ?? preset?.defaultIterations ?? 9),
  );

  const modeOptions: (readonly [string, string])[] = [
    ...FRACTAL_PRESETS.map((p) => [p.id, PRESET_LABELS[p.id] ?? p.name] as const),
    ["meander", "Meander fill"] as const,
    ["custom", "Custom"] as const,
  ];

  // Does the active rule set contain '|' alternatives? Then the dice matter.
  const isStochastic = preset
    ? Object.values(preset.spec.rules).some((r) => r.includes("|"))
    : modeId === "custom" && customRules.includes("|");

  // Pipeline: expand → turtle → fit to hoop size → resample to stitch length.
  // resamplePath both merges tiny unit steps and subdivides long ones, so
  // every needle move lands near stitchLen no matter the iteration count.
  const gen = useMemo<{ paths: PathMm[]; error: string | null }>(() => {
    try {
      if (isMeander) {
        // Meander fill: scale a Hilbert curve to overfill the shape's bbox,
        // then clip it to the shape (boundary walks keep it continuous).
        const rings = shapeRings(meanderShape, meanderSizeMm);
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const r of rings)
          for (const p of r) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
          }
        const hilbert = FRACTAL_PRESETS.find((p) => p.id === "hilbert");
        if (!hilbert || !(maxX > minX)) return { paths: [], error: "Could not build the fill." };
        const side = Math.max(maxX - minX, maxY - minY) * 1.04;
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const curve = turtlePaths(expandLSystem(hilbert.spec, meanderOrder), hilbert.spec.angleDeg);
        const placed = fitPaths(curve, side).map((path) =>
          path.map((pt) => ({ x: pt.x + cx, y: pt.y + cy })),
        );
        const clipped = clipPathsToRings(placed, rings);
        if (clipped.length === 0) {
          return { paths: [], error: "The curve missed the shape - bump the shape size." };
        }
        return { paths: clipped.map((p) => resamplePath(p, stitchLen)), error: null };
      }
      let spec: LSystemSpec;
      if (preset) {
        spec = preset.spec;
      } else {
        const axiom = customAxiom.replace(/\s+/g, "");
        if (!axiom) {
          return { paths: [], error: "Give the turtle an axiom to start from - a single F is plenty." };
        }
        const angle = Number(customAngle);
        if (!Number.isFinite(angle) || angle <= 0 || angle >= 180) {
          return { paths: [], error: "Angle needs to be a number between 0 and 180 degrees." };
        }
        spec = { axiom, rules: parseRules(customRules), angleDeg: angle };
      }
      const stochastic = Object.values(spec.rules).some((r) => r.includes("|"));
      const program = stochastic
        ? expandLSystemStochastic(spec, iterations, seed)
        : expandLSystem(spec, iterations);
      const raw = turtlePaths(program, spec.angleDeg);
      if (raw.length === 0) {
        return {
          paths: [],
          error: "These rules never put the pen down - add an F (or A, B, G) somewhere.",
        };
      }
      const fitted = fitPaths(raw, sizeMm);
      return { paths: fitted.map((p) => resamplePath(p, stitchLen)), error: null };
    } catch (err) {
      return { paths: [], error: err instanceof Error ? err.message : "Could not run that system." };
    }
  }, [
    preset,
    iterations,
    seed,
    sizeMm,
    stitchLen,
    customAxiom,
    customRules,
    customAngle,
    isMeander,
    meanderShape,
    meanderOrder,
    meanderSizeMm,
  ]);

  // The honest pipeline: stitches → real DST bytes → re-parse → preview.
  const built = useMemo(
    () =>
      gen.paths.length > 0 ? buildDesign(pathsToStitches(gen.paths, bean), "bayside-fractal") : null,
    [gen, bean],
  );

  const sections = gen.paths.length;
  const heavy = built !== null && built.stats.realStitches > 60000;

  return (
    <div className="space-y-5">
      <ToolLayout
        controls={
          <>
            <SectionBox eyebrow="Curve">
              <ModeButtons small options={modeOptions} value={modeId} onChange={setModeId} />
              {isMeander && (
                <div className="space-y-3">
                  <div className="text-[0.75rem] text-mid">
                    Shape
                    <div className="mt-1">
                      <ModeButtons
                        small
                        options={
                          [
                            ["circle", "Circle"],
                            ["star", "Star"],
                            ["heart", "Heart"],
                            ["ring", "Ring"],
                          ] as const
                        }
                        value={meanderShape}
                        onChange={setMeanderShape}
                      />
                    </div>
                  </div>
                  <RangeRow
                    label="Hilbert order"
                    value={meanderOrder}
                    min={4}
                    max={7}
                    onChange={setMeanderOrder}
                  />
                  <SizeField label="Size" valueMm={meanderSizeMm} min={40} max={330} onChange={setMeanderSizeMm} />
                  <p className="text-[0.6875rem] text-dim leading-relaxed">
                    Stipple, by way of the print bed: a Hilbert curve clipped to the shape -
                    3D-printer infill's gift to embroidery. One wandering line that never crosses
                    itself fills the area with a springy, even texture straight fill rows can't
                    make. Where the curve leaves the shape it walks the outline to its next
                    entrance, so the fill stays continuous.
                  </p>
                </div>
              )}
              {!isMeander && (
                <RangeRow
                  label="Iterations"
                  value={iterations}
                  min={1}
                  max={maxIter}
                  onChange={(v) => setIterBy((m) => ({ ...m, [modeId]: v }))}
                />
              )}
              {!isMeander && isStochastic && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSeed(1 + Math.floor(Math.random() * 999999))}
                    className="border border-hairline bg-bg px-2.5 py-1 text-[0.6875rem] text-fg hover:bg-card"
                  >
                    Roll the dice
                  </button>
                  <span className="font-mono text-[0.6875rem] text-dim tabular-nums">
                    seed {seed} - same seed, same plant
                  </span>
                </div>
              )}
              {isMeander ? null : preset ? (
                <p className="font-mono text-[0.6875rem] text-dim leading-relaxed break-words">
                  {preset.spec.axiom}
                  {Object.entries(preset.spec.rules)
                    .map(([k, v]) => ` · ${k}=${v}`)
                    .join("")}
                  {` · ${preset.spec.angleDeg}°`}
                </p>
              ) : (
                <div className="space-y-3">
                  <label className="block text-[0.75rem] text-mid">
                    Axiom
                    <input
                      value={customAxiom}
                      onChange={(ev) => setCustomAxiom(ev.target.value)}
                      spellCheck={false}
                      className={INPUT_CLASS}
                    />
                  </label>
                  <label className="block text-[0.75rem] text-mid">
                    Rules - one per line, like X=F+X
                    <textarea
                      value={customRules}
                      onChange={(ev) => setCustomRules(ev.target.value)}
                      rows={4}
                      spellCheck={false}
                      className={`${INPUT_CLASS} resize-y`}
                    />
                  </label>
                  <label className="block text-[0.75rem] text-mid">
                    Angle, degrees
                    <input
                      type="number"
                      value={customAngle}
                      onChange={(ev) => setCustomAngle(ev.target.value)}
                      min={1}
                      max={179}
                      step="any"
                      className={INPUT_CLASS}
                    />
                  </label>
                  <p className="text-[0.6875rem] text-dim leading-relaxed">
                    F G draw · A B X Y are silent variables · f moves pen-up · + − turn · [ ] branch
                    and return. A rule may list alternatives split by | - each rewrite rolls the
                    seeded dice and picks one.
                  </p>
                </div>
              )}
            </SectionBox>

            {gen.error && <Warning>{gen.error}</Warning>}

            <SectionBox eyebrow="Stitches">
              {!isMeander && (
                <SizeField label="Size" valueMm={sizeMm} min={30} max={330} onChange={setSizeMm} />
              )}
              <RangeRow
                label="Stitch length"
                value={stitchLen}
                min={1.5}
                max={5}
                step={0.1}
                onChange={setStitchLen}
                fmt={(v) => `${v.toFixed(1)} mm`}
              />
              <div className="text-[0.75rem] text-mid">
                Line weight
                <div className="mt-1">
                  <ModeButtons
                    small
                    options={
                      [
                        ["1", "Running stitch"],
                        ["3", "Bean ×3"],
                      ] as const
                    }
                    value={bean === 3 ? "3" : "1"}
                    onChange={(v) => setBean(v === "3" ? 3 : 1)}
                  />
                </div>
              </div>
            </SectionBox>

            <SectionBox eyebrow="Thread">
              <ThreadRow hex={threadHex} onChange={(hex) => setThreadHex(hex)} />
            </SectionBox>
          </>
        }
        preview={
          <PreviewRail
            built={built}
            colors={[threadHex]}
            name="bayside-fractal"
            emptyHint="Pick a preset or write your own rules - the turtle draws, the machine follows."
          >
            {sections > 0 && (
              <p className="text-[0.75rem] text-mid tabular-nums">
                continuous sections: <span className="text-fg">{sections}</span>
                {sections === 1
                  ? " - the entire curve is one unbroken thread. It sews start to finish with zero trims."
                  : isMeander
                    ? " - a few boundary gaps were too wide to walk, so the fill sews in sections with jumps between them."
                    : " - bracketed branches lift the needle, so this one sews in sections with jumps between them."}
              </p>
            )}
            {heavy && (
              <Warning>
                Over 60,000 stitches - that's a long, dense sit for one hoop. Drop an iteration
                or bump the stitch length.
              </Warning>
            )}
          </PreviewRail>
        }
      />
    </div>
  );
}
