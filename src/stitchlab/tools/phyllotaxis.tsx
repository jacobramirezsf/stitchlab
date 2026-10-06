// Stitch Lab tool: Phyllotaxis - sunflower-head geometry in thread.
//
// Vogel's model places seed n at radius √n and angle n × 137.508° (the golden
// angle). Two ways to sew it: "web" visits seeds in birth order - consecutive
// seeds sit across the disc from each other, so the thread weaves a dense
// chord web, one continuous line. "whorl" routes along parastichies - the
// spiral arms your eye actually sees in a sunflower, one arm per residue
// class mod a Fibonacci number. Nudging the angle a tenth of a degree
// dissolves the pattern completely; that slider is the whole toy.
// "fermat" sews the generative spiral itself - r = √t, θ = t·angle sampled
// continuously - one unbroken line from center to rim that every seed is
// born on. Zero trims. Whorl mode can also split alternate arms into two
// close thread shades (one color change) so the whorls pop like a real
// seed head.

import { useMemo, useState } from "react";
import { THREADS } from "../../data/threads";
import type { PathMm } from "../lib/generators";
import {
  fitPaths,
  pathGroupsToStitches,
  pathsToStitches,
  resampleAdaptive,
  resamplePath,
} from "../lib/generators";
import {
  buildDesign,
  useDebouncedKey,
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

export type PhylloOpts = {
  count?: number; // seeds, default 900
  angleDeg?: number; // divergence angle, default 137.508 (golden)
  mode?: "web" | "whorl" | "fermat"; // fermat: one continuous generative spiral
  arms?: 8 | 13 | 21 | 34; // whorl only: parastichy modulus, default 13
};

export function phyllotaxis(opts: PhylloOpts = {}): PathMm[] {
  const count = Math.max(50, Math.min(4000, Math.round(opts.count ?? 900)));
  const angle = ((opts.angleDeg ?? 137.508) * Math.PI) / 180;
  const mode = opts.mode ?? "whorl";
  if (mode === "fermat") {
    // The generative spiral itself: r = √t, θ = t·angle with t running
    // continuously 0 → count. Every seed sits exactly on this curve at
    // integer t (so the line passes through the whole lattice), and at
    // t = count the radius is √count - the same disc the seeds fill.
    // Each birth-to-birth step is subdivided so no sampled segment exceeds
    // 1 model unit; arc per unit t is ≈ angle·√t, hence the ceil below.
    const spiral: PathMm = [{ x: 0, y: 0 }];
    for (let n = 1; n <= count; n++) {
      const sub = Math.max(1, Math.ceil(angle * Math.sqrt(n)));
      for (let s = 1; s <= sub; s++) {
        const t = n - 1 + s / sub;
        const r = Math.sqrt(t);
        spiral.push({ x: r * Math.cos(t * angle), y: r * Math.sin(t * angle) });
      }
    }
    return [spiral];
  }
  const seeds: PathMm = [];
  for (let n = 1; n <= count; n++) {
    const r = Math.sqrt(n);
    const a = n * angle;
    seeds.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
  }
  if (mode === "web") return [seeds];
  const arms = opts.arms ?? 13;
  const paths: PathMm[] = [];
  for (let k = 0; k < arms; k++) {
    const arm: PathMm = [];
    for (let n = k; n < count; n += arms) arm.push(seeds[n]);
    if (arm.length >= 2) paths.push(arm);
  }
  return paths;
}

/**
 * Two-tone whorls: split arms into alternating groups (even / odd arm index).
 * Feed the pair to pathGroupsToStitches so the machine sews all even arms in
 * one shade, takes a single color change, then sews the odd arms - two close
 * Polyneon shades make the whorls pop like a real seed head.
 */
export function splitAlternateArms(paths: PathMm[]): [PathMm[], PathMm[]] {
  const even: PathMm[] = [];
  const odd: PathMm[] = [];
  paths.forEach((p, i) => {
    (i % 2 === 0 ? even : odd).push(p);
  });
  return [even, odd];
}

// ─── Component ───────────────────────────────────────────────────────────

export default function PhyllotaxisTool() {
  const [mode, setMode] = useState<"whorl" | "web" | "fermat">("whorl");
  const [count, setCount] = useState(900);
  const [angleMilli, setAngleMilli] = useState(137508); // slider in millidegrees for fine control
  const [arms, setArms] = useState<8 | 13 | 21 | 34>(13);
  const [sizeMm, setSizeMm] = useState(110);
  const [stitchLen, setStitchLen] = useState(2.8);
  const [adaptive, setAdaptive] = useState(true);
  const [bean, setBean] = useState<1 | 3>(1);
  const [twoTone, setTwoTone] = useState(false);
  const [threadHex, setThreadHex] = useState(
    THREADS.find((t) => t.family === "Yellow" && t.hex)?.hex ??
      THREADS.find((t) => t.hex)?.hex ??
      "#082870",
  );
  // Second shade for two-tone whorls - default one step deeper than the
  // sunflower yellow above (1772 Military Gold).
  const [threadHexB, setThreadHexB] = useState(
    THREADS.find((t) => t.code === "1772" && t.hex)?.hex ??
      THREADS.find((t) => t.family === "Yellow" && t.hex)?.hex ??
      "#C48901",
  );

  const angleDeg = angleMilli / 1000;
  const twoToneActive = mode === "whorl" && twoTone;

  const genKey = useDebouncedKey([count, angleDeg, mode, arms, sizeMm, stitchLen, adaptive, bean, twoTone], 170);
  const built = useMemo(() => {
    const raw = phyllotaxis({ count, angleDeg, mode, arms });
    const fitted = fitPaths(raw, sizeMm).map((p) =>
      adaptive
        ? resampleAdaptive(p, {
            chordErrorMm: 0.15,
            minLenMm: Math.max(0.8, stitchLen / 3),
            maxLenMm: stitchLen,
          })
        : resamplePath(p, stitchLen),
    );
    const stitches =
      mode === "whorl" && twoTone
        ? pathGroupsToStitches(splitAlternateArms(fitted), bean)
        : pathsToStitches(fitted, bean);
    return buildDesign(stitches, "bayside-phyllo");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genKey]);

  const stitchCount = built?.stats.realStitches ?? 0;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Pattern">
            <ModeButtons
              options={[
                ["whorl", "Whorl (spiral arms)"],
                ["web", "Web (chord weave)"],
                ["fermat", "Fermat (one line)"],
              ]}
              value={mode}
              onChange={setMode}
            />
            <RangeRow label="Seeds" value={count} min={200} max={3000} step={50} onChange={setCount} />
            <RangeRow
              label="Divergence angle"
              value={angleMilli}
              min={130000}
              max={145000}
              step={4}
              onChange={setAngleMilli}
              fmt={(v) => `${(v / 1000).toFixed(3)}°`}
            />
            <button
              onClick={() => setAngleMilli(137508)}
              className="border border-hairline bg-bg px-3 py-1 text-[0.75rem] text-fg hover:bg-card"
            >
              Snap to golden angle
            </button>
            {mode === "whorl" && (
              <ModeButtons
                small
                options={[
                  [8, "8 arms"],
                  [13, "13 arms"],
                  [21, "21 arms"],
                  [34, "34 arms"],
                ]}
                value={arms}
                onChange={setArms}
              />
            )}
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Fibonacci arm counts (8, 13, 21, 34) follow the seed lattice cleanly at the
              golden angle. Detune the angle even 0.1° and watch the structure dissolve.
            </p>
            {mode === "fermat" && (
              <p className="text-[0.6875rem] text-mid leading-relaxed">
                Fermat sews the generative spiral itself - the one line every seed is born
                on, center to rim, no trims. Passes tighten toward the rim, so seed count
                and size drive thread length fast.
              </p>
            )}
          </SectionBox>

          <SectionBox eyebrow="Stitch settings">
            <SizeField valueMm={sizeMm} min={40} max={330} onChange={setSizeMm} />
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
            <ModeButtons
              small
              options={[
                [1, "Run"],
                [3, "Bean ×3"],
              ]}
              value={bean}
              onChange={setBean}
            />
          </SectionBox>

          <SectionBox eyebrow="Thread">
            {mode === "whorl" && (
              <ModeButtons
                small
                options={[
                  ["single", "Single color"],
                  ["two", "Two-tone arms"],
                ]}
                value={twoTone ? "two" : "single"}
                onChange={(v) => setTwoTone(v === "two")}
              />
            )}
            <ThreadRow
              label={twoToneActive ? "Even arms" : undefined}
              hex={threadHex}
              onChange={(hex) => setThreadHex(hex)}
            />
            {twoToneActive && (
              <>
                <ThreadRow
                  label="Odd arms"
                  hex={threadHexB}
                  onChange={(hex) => setThreadHexB(hex)}
                />
                <p className="text-[0.6875rem] text-mid leading-relaxed">
                  Keep the two Polyneon shades close - a gold one step deeper than the
                  other. Alternate whorls catch the light separately, and the head pops
                  the way a real seed disc does.
                </p>
              </>
            )}
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail
          built={built}
          colors={twoToneActive ? [threadHex, threadHexB] : [threadHex]}
          name="bayside-phyllo"
          emptyHint="Adjust the seeds."
        >
          {built && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              {mode === "fermat"
                ? "one continuous Fermat spiral, center to rim - zero trims"
                : mode === "web"
                  ? "one continuous chord weave - zero trims"
                  : twoTone
                    ? `${arms} arms in two alternating shades - one color change`
                    : `${arms} continuous arms - one trim between each`}
            </p>
          )}
          {stitchCount > 60000 && (
            <Warning>Over 60k stitches - lower the seed count or size.</Warning>
          )}
          {mode === "web" && count > 1600 && (
            <Warning>
              Dense webs put a lot of thread on light fabric - consider a stable canvas or
              fewer seeds.
            </Warning>
          )}
        </PreviewRail>
      }
    />
  );
}
