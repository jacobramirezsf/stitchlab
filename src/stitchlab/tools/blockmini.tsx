// Standalone single-generator tools. Every generator in the Pattern Blocks
// engine that deserves its own front door gets one, built from one factory:
// the block's own param schema becomes the control panel, and the output runs
// through the standard scale → resample → DST pipeline with PreviewRail.
// Adding a generator to sketch.tsx + one line here = a new standalone tool.

import { useMemo, useState } from "react";
import {
  ToolLayout,
  SectionBox,
  RangeRow,
  ModeButtons,
  ThreadRow,
  SizeField,
  PreviewRail,
  buildDesign,
  useDebouncedKey,
  LABEL,
} from "./shared";
import { pathGroupsToStitches, resamplePath, routeStrokes } from "../lib/generators";
import { THREADS } from "../../data/threads";
import { runBlocks, BLOCK_BY_TYPE, type BlockParam } from "./sketch";

const INK = THREADS.find((t) => t.code === "1568")?.hex ?? "#0b1f3a";
const isNum = (p: BlockParam): p is Extract<BlockParam, { min: number }> => "min" in p;

/** Generators whose output changes with the seed. */
const RANDOM_TYPES = new Set(["truchet", "flowField", "contours", "circlePack"]);

function BlockMiniTool({ type, slug }: { type: string; slug: string }) {
  const def = BLOCK_BY_TYPE[type];
  const NAME = `bayside-${slug}`;
  const [params, setParams] = useState<Record<string, number | string>>(() => ({ ...def.defaults }));
  const [sizeMm, setSizeMm] = useState(120);
  const [stitchLen, setStitchLen] = useState(2.2);
  const [bean, setBean] = useState<1 | 3>(1);
  const [seed, setSeed] = useState(1);
  const [threadHex, setThreadHex] = useState(INK);
  const random = RANDOM_TYPES.has(type);

  const key = useDebouncedKey([params, sizeMm, stitchLen, bean, seed]);
  const built = useMemo(() => {
    const groups = runBlocks([{ id: "b", type, params }], { seed, defaultHex: INK }).groups.flat();
    const s = sizeMm / 100;
    // Route before resampling: merge touching strokes + order by nearest
    // endpoint, so the pattern sews with far fewer jumps and trims.
    const paths = routeStrokes(
      groups.filter((p) => p.length >= 2).map((p) => p.map((pt) => ({ x: (pt.x - 50) * s, y: (pt.y - 50) * s }))),
    ).map((p) => resamplePath(p, stitchLen, 0.4));
    if (!paths.length) return null;
    return buildDesign(pathGroupsToStitches([paths], bean), NAME);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow={def.label.toLowerCase()}>
            <p className="text-[0.75rem] text-mid leading-relaxed">{def.hint}</p>
            {def.params.filter(isNum).map((p) => (
              <RangeRow
                key={p.key}
                label={p.label}
                value={Number(params[p.key])}
                min={p.min}
                max={p.max}
                step={p.step}
                onChange={(v) => setParams((m) => ({ ...m, [p.key]: v }))}
                fmt={(v) => (p.step < 1 ? v.toFixed(1) : String(v))}
              />
            ))}
            {random && <RangeRow label="Variation" value={seed} min={1} max={99} step={1} onChange={setSeed} />}
          </SectionBox>
          <SectionBox eyebrow="stitch">
            <SizeField valueMm={sizeMm} min={40} max={330} onChange={setSizeMm} />
            <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={4} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
            <div>
              <div className={`${LABEL} mb-1.5`}>Line weight</div>
              <ModeButtons small options={[["1", "Run"], ["3", "Bean ×3"]] as const} value={String(bean)} onChange={(v) => setBean(Number(v) as 1 | 3)} />
            </div>
            <ThreadRow hex={threadHex} onChange={setThreadHex} />
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail
          built={built}
          colors={[threadHex]}
          name={NAME}
          emptyHint="Adjust the sliders and the pattern appears as soon as it's sewable."
        />
      }
    />
  );
}

const make = (type: string, slug: string) => () => <BlockMiniTool type={type} slug={slug} />;

export const SpiralTool = make("spiral", "spiral");
export const SpirographTool = make("spirograph", "spirograph");
export const LissajousTool = make("lissajous", "lissajous");
export const SuperformulaTool = make("superformula", "superformula");
export const ButterflyTool = make("butterfly", "butterfly");
export const HeartTool = make("heart", "heart");
export const RosetteTool = make("rosette", "rosette");
export const TimesTableTool = make("timesTable", "timestable");
export const FractalTreeTool = make("tree", "fractaltree");
export const WebTool = make("polarGrid", "web");
export const RipplesTool = make("ripples", "ripples");
export const TopoTool = make("contours", "topo");
export const CirclePackTool = make("circlePack", "circlepack");
export const RingsTool = make("concentricRings", "rings");
export const PolygonsTool = make("concentricPolygons", "polygons");
export const SquaresTool = make("concentricSquares", "squares");
export const PolygonRingTool = make("polygonRing", "polygonring");
export const CrosshatchTool = make("grid", "crosshatch");
export const PlaidTool = make("plaid", "plaid");
export const MoireTool = make("moire", "moire");
export const HoneycombTool = make("honeycomb", "honeycomb");
export const WavesTool = make("waveRows", "waves");
export const DotGridTool = make("circleGrid", "dotgrid");
