// Stitch Lab tool: Harmonograph - the Victorian pendulum drawing machine, in
// thread. Two damped sinusoids per axis trace the curve; frequency ratios that
// *almost* land on small fractions (3 against 2.005) make each revolution miss
// the last one slightly, so the loops stack into ghosted bands as the
// pendulums die down. The whole trace is one continuous running-stitch line -
// zero trims, start to finish.
//
// Two machines in one: 'lateral' is the classic two-pendulum pen; 'rotary'
// spins the paper under it (a turntable third pendulum), which folds the same
// swing into rose-engine petals when the table speed sits just off a simple
// fraction of the pendulums.
//
// Pure math lives at the top of the file (node-importable, no DOM, no
// unseeded randomness); everything React/DOM stays inside the component.

import { useMemo, useState } from "react";
import { THREADS } from "../../data/threads";
import {
  fitPaths,
  pathsToStitches,
  resampleAdaptive,
  resamplePath,
  type PathMm,
} from "../lib/generators";
import {
  LABEL,
  ModeButtons,
  PreviewRail,
  RangeRow,
  SectionBox,
  ThreadRow,
  ToolLayout,
  Warning,
  buildDesign,
  useDebouncedKey,
  SizeField,
} from "./shared";

// ─── Pure math ───────────────────────────────────────────────────────────

const TAU = Math.PI * 2;
const SAMPLES_PER_SEC = 90;

export type HarmonographOpts = {
  fx1: number;
  fx2: number;
  fy1: number;
  fy2: number;
  px1?: number;
  px2?: number;
  py1?: number;
  py2?: number;
  /** Decay rate per second. Default 0.006. */
  damp?: number;
  /** How long the pendulums swing. Default 60. */
  seconds?: number;
  /**
   * 'lateral' (default) - the classic two-pendulum pen, exactly the original
   * behavior. 'rotary' - the pen swings the same way, but the paper rides a
   * turntable spinning at tableFreq, so the trace is drawn in the rotating
   * frame.
   */
  mode?: "lateral" | "rotary";
  /** Turntable revolutions per second (rotary mode only). Default 1. */
  tableFreq?: number;
  /** Per-sinusoid amplitudes, 0–1, default 1 each: a1·fx1, a2·fx2, a3·fy1, a4·fy2. */
  a1?: number;
  a2?: number;
  a3?: number;
  a4?: number;
};

/**
 * Trace the pendulum curve: x(t) = sin(2π·fx1·t + px1)·e^(−damp·t) +
 * sin(2π·fx2·t + px2)·e^(−damp·t), y likewise with fy/py. Sampled at
 * 90 samples/sec. Returns ONE continuous path in unit amplitude (≈ ±2) -
 * the caller fits it to a physical size.
 */
export function harmonograph(opts: HarmonographOpts): PathMm[] {
  const { fx1, fx2, fy1, fy2, px1 = 0, px2 = 0, py1 = 0, py2 = 0 } = opts;
  const damp = Math.max(0, opts.damp ?? 0.006);
  const seconds = Math.min(600, Math.max(1, opts.seconds ?? 60));
  const mode = opts.mode ?? "lateral";
  const tableFreq = opts.tableFreq ?? 1;
  const clampAmp = (v: number | undefined) => Math.min(1, Math.max(0, v ?? 1));
  const a1 = clampAmp(opts.a1);
  const a2 = clampAmp(opts.a2);
  const a3 = clampAmp(opts.a3);
  const a4 = clampAmp(opts.a4);
  // Rotary compounds table speed on top of pendulum frequency, so it samples
  // twice as fast; lateral keeps the original 90/s exactly.
  const rate = mode === "rotary" ? SAMPLES_PER_SEC * 2 : SAMPLES_PER_SEC;
  const n = Math.round(seconds * rate);
  const path: PathMm = [];
  for (let i = 0; i <= n; i++) {
    const t = i / rate;
    const decay = Math.exp(-damp * t);
    let x =
      a1 * Math.sin(TAU * fx1 * t + px1) * decay +
      a2 * Math.sin(TAU * fx2 * t + px2) * decay;
    let y =
      a3 * Math.sin(TAU * fy1 * t + py1) * decay +
      a4 * Math.sin(TAU * fy2 * t + py2) * decay;
    if (mode === "rotary") {
      // Rotate the lateral pen position into the spinning table's frame.
      const phi = TAU * tableFreq * t;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      const rx = x * c + y * s;
      const ry = -x * s + y * c;
      x = rx;
      y = ry;
    }
    path.push({ x, y });
  }
  return [path];
}

/**
 * How long the pendulums swing before the decay envelope e^(−damp·t) sinks to
 * `floor` (default 12% - where the trace visibly peters out), capped at 240 s
 * so feather-light damping doesn't ask for an hour at the machine.
 */
export function runToFadeSeconds(damp: number, floor = 0.12): number {
  const d = Math.max(1e-6, damp);
  const f = Math.min(0.999, Math.max(0.001, floor));
  return Math.min(240, Math.log(1 / f) / d);
}

/** Tiny seedable PRNG (mulberry32) so surprises can be reproduced in tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SurpriseFreqs = {
  fx1: number;
  fx2: number;
  fy1: number;
  fy2: number;
  px1: number;
  px2: number;
  py1: number;
  py2: number;
};

/**
 * Roll a fresh pendulum setup: small integer base frequencies 1–5 with a
 * ±0.02 detune (the detune IS the ghosting), random phases. Pass any rand
 * in [0,1) - Math.random in the UI, mulberry32(seed) in tests.
 */
export function surpriseParams(rand: () => number): SurpriseFreqs {
  const base = () => 1 + Math.floor(rand() * 5);
  const detune = () => Math.round((rand() * 2 - 1) * 2) / 100; // −0.02…0.02
  const phase = () => Math.round(rand() * 628) / 100;
  let bx1 = base();
  let bx2 = base();
  let by1 = base();
  let by2 = base();
  // All four the same collapses to a near-line; nudge one off.
  if (bx1 === bx2 && bx2 === by1 && by1 === by2) by2 = (by2 % 5) + 1;
  return {
    fx1: Math.max(1, bx1 + detune()),
    fx2: Math.max(1, bx2 + detune()),
    fy1: Math.max(1, by1 + detune()),
    fy2: Math.max(1, by2 + detune()),
    px1: phase(),
    px2: phase(),
    py1: phase(),
    py2: phase(),
  };
}

// ─── Component ───────────────────────────────────────────────────────────

const NAME = "bayside-harmonograph";

type MachineMode = "lateral" | "rotary";

type Preset = {
  key: string;
  label: string;
  f: readonly [number, number, number, number];
  /** px1, px2, py1, py2 - defaults to all zero. */
  phases?: readonly [number, number, number, number];
  mode?: MachineMode;
  tableFreq?: number;
  /** Presets that need a specific decay to read right can pin motion too. */
  damp?: number;
  seconds?: number;
};

const PRESETS: readonly Preset[] = [
  { key: "rose", label: "Rose", f: [2, 3.01, 3, 2.005] },
  { key: "butterfly", label: "Butterfly", f: [3, 5.02, 5, 3.01] },
  { key: "web", label: "Web", f: [5, 4.005, 4, 5.01] },
  // Rotary: y leads x by ~π/2 so the pen orbits, and the table turns just off
  // 1/4 of the pendulum speed - each orbit lands a petal-width past the last.
  // Tuned by eye: ±0.01 detune + damp 0.012 over 45 s gives seven curling
  // petal blades instead of a solid tangle.
  {
    key: "rose-engine",
    label: "Rose engine",
    f: [2, 2.01, 2, 1.99],
    phases: [0, 0, 1.57, 1.57],
    mode: "rotary",
    tableFreq: 0.505,
    damp: 0.012,
    seconds: 45,
  },
];

const PRESET_OPTIONS: readonly (readonly [string, string])[] = PRESETS.map(
  (p) => [p.key, p.label] as const,
);

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

export default function HarmonographTool() {
  const [fx1, setFx1] = useState(2);
  const [fx2, setFx2] = useState(3.01);
  const [fy1, setFy1] = useState(3);
  const [fy2, setFy2] = useState(2.005);
  const [px1, setPx1] = useState(0);
  const [px2, setPx2] = useState(0);
  const [py1, setPy1] = useState(0);
  const [py2, setPy2] = useState(0);
  const [a1, setA1] = useState(1);
  const [a2, setA2] = useState(1);
  const [a3, setA3] = useState(1);
  const [a4, setA4] = useState(1);
  const [mode, setMode] = useState<MachineMode>("lateral");
  const [tableFreq, setTableFreq] = useState(1);
  const [damp, setDamp] = useState(0.006);
  const [seconds, setSeconds] = useState(60);
  const [sizeMm, setSizeMm] = useState(110);
  const [stitchLen, setStitchLen] = useState(2.5);
  const [adaptive, setAdaptive] = useState(true);
  const [line, setLine] = useState<"run" | "bean">("run");
  const [threadHex, setThreadHex] = useState(
    THREADS.find((t) => t.code === "1568")?.hex ?? "#082870",
  );

  const setFreqs = (f: readonly [number, number, number, number]) => {
    setFx1(f[0]);
    setFx2(f[1]);
    setFy1(f[2]);
    setFy2(f[3]);
  };
  const setPhases = (p1: number, p2: number, p3: number, p4: number) => {
    setPx1(p1);
    setPx2(p2);
    setPy1(p3);
    setPy2(p4);
  };

  const applyPreset = (key: string) => {
    const p = PRESETS.find((pr) => pr.key === key);
    if (!p) return;
    setFreqs(p.f);
    const ph = p.phases ?? ([0, 0, 0, 0] as const);
    setPhases(ph[0], ph[1], ph[2], ph[3]);
    setMode(p.mode ?? "lateral");
    if (p.tableFreq !== undefined) setTableFreq(p.tableFreq);
    if (p.damp !== undefined) setDamp(p.damp);
    if (p.seconds !== undefined) setSeconds(p.seconds);
    setA1(1);
    setA2(1);
    setA3(1);
    setA4(1);
  };

  const surprise = () => {
    const p = surpriseParams(Math.random);
    setFreqs([p.fx1, p.fx2, p.fy1, p.fy2]);
    setPhases(p.px1, p.px2, p.py1, p.py2);
  };

  const activePreset =
    PRESETS.find((p) => {
      const ph = p.phases ?? [0, 0, 0, 0];
      return (
        near(fx1, p.f[0]) &&
        near(fx2, p.f[1]) &&
        near(fy1, p.f[2]) &&
        near(fy2, p.f[3]) &&
        near(px1, ph[0]) &&
        near(px2, ph[1]) &&
        near(py1, ph[2]) &&
        near(py2, ph[3]) &&
        mode === (p.mode ?? "lateral") &&
        (mode === "lateral" || near(tableFreq, p.tableFreq ?? 1)) &&
        near(a1, 1) &&
        near(a2, 1) &&
        near(a3, 1) &&
        near(a4, 1)
      );
    })?.key ?? "custom";

  // The honest pipeline: curve → fit to mm → resample to stitch length →
  // machine stitches. Errors surface as a Warning instead of a blank rail.
  const genKey = useDebouncedKey([fx1, fx2, fy1, fy2, px1, px2, py1, py2, damp, seconds, mode, tableFreq, a1, a2, a3, a4, sizeMm, stitchLen, line], 170);
  const gen = useMemo(() => {
    try {
      const raw = harmonograph({
        fx1, fx2, fy1, fy2, px1, px2, py1, py2, damp, seconds,
        mode, tableFreq, a1, a2, a3, a4,
      });
      const fitted = fitPaths(raw, sizeMm);
      const resampled = fitted.map((p) =>
        adaptive
          ? resampleAdaptive(p, {
              chordErrorMm: 0.15,
              minLenMm: Math.max(0.8, stitchLen / 3),
              maxLenMm: stitchLen,
            })
          : resamplePath(p, stitchLen),
      );
      const stitches = pathsToStitches(resampled, line === "bean" ? 3 : 1);
      return { stitches, error: null as string | null };
    } catch (err) {
      return {
        stitches: null,
        error: err instanceof Error ? err.message : "Could not trace that curve.",
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genKey]);

  const fadeS = Math.round(runToFadeSeconds(damp));

  const built = useMemo(() => buildDesign(gen.stitches, NAME), [gen.stitches]);

  const tooDense = built !== null && built.stats.realStitches > 60000;

  const freqFmt = (v: number) => v.toFixed(3);
  const phaseFmt = (v: number) => v.toFixed(2);

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="pendulums">
            <p className="text-[0.75rem] text-mid leading-relaxed">
              Two decaying pendulums per axis. Ratios that just miss a small fraction - 3
              against 2.005 - make each pass drift off the last, and the loops stack into
              ghosted bands as the swing dies down.
            </p>
            <div>
              <div className={LABEL}>Machine</div>
              <div className="mt-1.5">
                <ModeButtons
                  small
                  options={[
                    ["lateral", "Lateral"],
                    ["rotary", "Rotary table"],
                  ] as const}
                  value={mode}
                  onChange={setMode}
                />
              </div>
            </div>
            {mode === "rotary" && (
              <>
                <RangeRow
                  label="Table speed"
                  value={tableFreq}
                  min={0.2}
                  max={3}
                  step={0.005}
                  onChange={setTableFreq}
                  fmt={freqFmt}
                />
                <p className="text-[0.6875rem] text-mid leading-relaxed">
                  The paper spins under the pen. Park the table just off a simple
                  fraction of the pendulum speed - 0.505 against 2 - and each orbit
                  lands a petal-width past the last.
                </p>
              </>
            )}
            <button
              onClick={surprise}
              className="w-full border border-fg px-4 py-2 text-[0.8125rem] text-fg hover:bg-fg hover:text-bg transition-colors"
            >
              Surprise me
            </button>
            <ModeButtons small options={PRESET_OPTIONS} value={activePreset} onChange={applyPreset} />
            <RangeRow label="X pendulum 1" value={fx1} min={1} max={8} step={0.01} onChange={setFx1} fmt={freqFmt} />
            <RangeRow label="X pendulum 2" value={fx2} min={1} max={8} step={0.01} onChange={setFx2} fmt={freqFmt} />
            <RangeRow label="Y pendulum 1" value={fy1} min={1} max={8} step={0.01} onChange={setFy1} fmt={freqFmt} />
            <RangeRow label="Y pendulum 2" value={fy2} min={1} max={8} step={0.005} onChange={setFy2} fmt={freqFmt} />
            <details>
              <summary className="cursor-pointer text-[0.75rem] text-mid select-none">
                Phases &amp; amplitudes - where each pendulum starts, how hard it swings
              </summary>
              <div className="mt-2 space-y-1">
                <RangeRow label="X phase 1" value={px1} min={0} max={6.28} step={0.01} onChange={setPx1} fmt={phaseFmt} />
                <RangeRow label="X phase 2" value={px2} min={0} max={6.28} step={0.01} onChange={setPx2} fmt={phaseFmt} />
                <RangeRow label="Y phase 1" value={py1} min={0} max={6.28} step={0.01} onChange={setPy1} fmt={phaseFmt} />
                <RangeRow label="Y phase 2" value={py2} min={0} max={6.28} step={0.01} onChange={setPy2} fmt={phaseFmt} />
                <RangeRow label="X amp 1" value={a1} min={0} max={1} step={0.05} onChange={setA1} fmt={phaseFmt} />
                <RangeRow label="X amp 2" value={a2} min={0} max={1} step={0.05} onChange={setA2} fmt={phaseFmt} />
                <RangeRow label="Y amp 1" value={a3} min={0} max={1} step={0.05} onChange={setA3} fmt={phaseFmt} />
                <RangeRow label="Y amp 2" value={a4} min={0} max={1} step={0.05} onChange={setA4} fmt={phaseFmt} />
              </div>
            </details>
          </SectionBox>

          <SectionBox eyebrow="motion">
            <RangeRow
              label="Damping"
              value={damp}
              min={0.002}
              max={0.02}
              step={0.001}
              onChange={setDamp}
              fmt={(v) => v.toFixed(3)}
            />
            <RangeRow
              label="Duration"
              value={seconds}
              min={20}
              max={240}
              step={5}
              onChange={setSeconds}
              fmt={(v) => `${v}s`}
            />
            <button
              onClick={() => setSeconds(fadeS)}
              className="w-full border border-hairline px-4 py-2 text-[0.8125rem] text-fg hover:border-fg transition-colors"
            >
              Run to fade - {fadeS}s
            </button>
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Run to fade stops when the swing has died to 12% of its first pass - the
              trace's natural end at this damping. Low damping and a long run means
              more revolutions - denser bands, more stitches. High damping spirals in
              fast.
            </p>
          </SectionBox>

          <SectionBox eyebrow="stitch">
            <SizeField label="Size" valueMm={sizeMm} min={40} max={330} onChange={setSizeMm} />
            <RangeRow
              label="Stitch length"
              value={stitchLen}
              min={1.5}
              max={5}
              step={0.1}
              onChange={setStitchLen}
              fmt={(v) => `${v.toFixed(1)} mm`}
            />
            <label className="flex items-start gap-2 text-[0.8125rem] text-fg cursor-pointer">
              <input
                type="checkbox"
                checked={adaptive}
                onChange={(ev) => setAdaptive(ev.target.checked)}
                className="accent-accent mt-0.5"
              />
              <span>
                Adaptive stitch length
                <span className="block text-[0.6875rem] text-mid leading-relaxed">
                  Chord-tolerance stitching (0.15&nbsp;mm cap): long on straights, short in
                  curves. The slider sets the maximum.
                </span>
              </span>
            </label>
            <div>
              <div className={LABEL}>Line weight</div>
              <div className="mt-1.5">
                <ModeButtons
                  small
                  options={[
                    ["run", "Run stitch"],
                    ["bean", "Bean ×3"],
                  ] as const}
                  value={line}
                  onChange={setLine}
                />
              </div>
            </div>
            <ThreadRow hex={threadHex} onChange={(hex) => setThreadHex(hex)} />
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail
          built={built}
          colors={[threadHex]}
          name={NAME}
          emptyHint="Nudge the pendulums - the curve appears as soon as it's sewable."
        >
          {gen.error && <Warning>{gen.error}</Warning>}
          {tooDense && (
            <Warning>
              {built.stats.realStitches.toLocaleString()} stitches - that's a long sit at
              the machine and a lot of needle holes in one small area. Raise the damping,
              shorten the duration, or lengthen the stitch and the count drops fast.
            </Warning>
          )}
          {built && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              one continuous line · {built.stats.realStitches.toLocaleString()} stitches
            </p>
          )}
        </PreviewRail>
      }
    />
  );
}
