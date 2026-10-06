// Stitch Lab tool: Pattern Blocks - the no-code sibling of Sketch. Instead of
// writing code, you stack visual blocks (concentric rings, spiral, string-art
// star, wave rows, rings of polygons…), fill in their numbers with sliders, and
// reorder them - Scratch/Snap for embroidery. Each block draws with the same
// engine the code editor uses, so the output is identical in kind: real DST.
//
// All generation is the pure, Node-tested runBlocks; this file is the block UI.

import { useMemo, useState } from "react";
import {
  ToolLayout,
  SectionBox,
  RangeRow,
  ModeButtons,
  ThreadRow,
  PreviewRail,
  buildDesign,
  LABEL,
  fmtLen, useUnits,
} from "./shared";
import { pathGroupsToStitches, resamplePath, fitPaths, type PathMm } from "../lib/generators";
import { THREADS } from "../../data/threads";
import { runBlocks, BLOCK_DEFS, BLOCK_BY_TYPE, type Block } from "./sketch";

let seq = 0;
const uid = () => `b${seq++}`;
const DEFAULT_THREAD = THREADS.find((t) => t.code === "1568")?.hex ?? "#0b1f3a";
const ACCENT = THREADS.find((t) => t.code === "1147")?.hex ?? "#b4472e";

function newBlock(type: string): Block {
  const def = BLOCK_BY_TYPE[type];
  return { id: uid(), type, params: { ...def.defaults } };
}

const STARTER: Block[] = [
  { id: uid(), type: "color", params: { hex: ACCENT } },
  { id: uid(), type: "rose", params: { ...BLOCK_BY_TYPE.rose.defaults } },
];

export default function BlocksTool() {
  const units = useUnits();
  const [blocks, setBlocks] = useState<Block[]>(STARTER);
  const [seed, setSeed] = useState(1);
  const [sizeMm, setSizeMm] = useState(120);
  const [stitchLen, setStitchLen] = useState(2.2);
  const [bean, setBean] = useState<1 | 3>(1);
  const [threadHex, setThreadHex] = useState(DEFAULT_THREAD);

  const result = useMemo(() => runBlocks(blocks, { seed, defaultHex: threadHex }), [blocks, seed, threadHex]);

  const built = useMemo(() => {
    if (result.groups.length === 0) return null;
    const fitted = fitPaths(result.groups.flat(), sizeMm);
    const scaledGroups: PathMm[][] = [];
    let idx = 0;
    for (const g of result.groups) {
      scaledGroups.push(fitted.slice(idx, idx + g.length).map((p) => resamplePath(p, stitchLen, 0.4)));
      idx += g.length;
    }
    return buildDesign(pathGroupsToStitches(scaledGroups, bean), "bayside-blocks");
  }, [result, sizeMm, stitchLen, bean]);

  const previewColors = result.colors.length ? result.colors : [threadHex];

  const update = (id: string, key: string, value: number | string) =>
    setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, params: { ...b.params, [key]: value } } : b)));
  const remove = (id: string) => setBlocks((bs) => bs.filter((b) => b.id !== id));
  const move = (id: string, dir: -1 | 1) =>
    setBlocks((bs) => {
      const i = bs.findIndex((b) => b.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= bs.length) return bs;
      const next = [...bs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow={`program (${blocks.length} blocks)`}>
            {blocks.length === 0 && <p className="text-[0.8125rem] text-mid">Add a block below to start a pattern.</p>}
            <div className="space-y-2">
              {blocks.map((b, i) => {
                const def = BLOCK_BY_TYPE[b.type];
                if (!def) return null;
                const isColor = b.type === "color";
                return (
                  <div key={b.id} className={`border ${isColor ? "border-accent/60 bg-card" : "border-hairline"} px-2.5 py-2`}>
                    <div className="flex items-center gap-2 mb-1">
                      {isColor && <span className="w-3.5 h-3.5 border border-hairline" style={{ background: String(b.params.hex) }} />}
                      <span className="flex-1 text-[0.8125rem] text-fg font-medium">{def.label}</span>
                      <button onClick={() => move(b.id, -1)} disabled={i === 0} title="Move up" className="text-mid hover:text-fg disabled:opacity-25 text-[0.7rem] px-0.5">↑</button>
                      <button onClick={() => move(b.id, 1)} disabled={i === blocks.length - 1} title="Move down" className="text-mid hover:text-fg disabled:opacity-25 text-[0.7rem] px-0.5">↓</button>
                      <button onClick={() => remove(b.id)} title="Delete" className="text-mid hover:text-fg text-[0.7rem] px-0.5">✕</button>
                    </div>
                    {def.params.map((param) =>
                      "kind" in param && param.kind === "color" ? (
                        <ThreadRow key={param.key} label={param.label} hex={String(b.params[param.key])} onChange={(hex) => update(b.id, param.key, hex)} />
                      ) : "min" in param ? (
                        <RangeRow key={param.key} label={param.label} value={Number(b.params[param.key])} min={param.min} max={param.max} step={param.step} onChange={(v) => update(b.id, param.key, v)} fmt={(v) => (param.step < 1 ? v.toFixed(1) : String(v))} />
                      ) : null,
                    )}
                    <p className="text-[0.625rem] text-mid leading-relaxed mt-0.5">{def.hint}</p>
                  </div>
                );
              })}
            </div>
          </SectionBox>

          <SectionBox eyebrow="add a block">
            <div className="grid grid-cols-2 gap-1.5">
              {BLOCK_DEFS.map((def) => (
                <button
                  key={def.type}
                  onClick={() => setBlocks((bs) => [...bs, newBlock(def.type)])}
                  className="text-left border border-hairline bg-bg hover:border-accent px-2 py-1 text-[0.75rem] text-fg"
                >
                  + {def.label}
                </button>
              ))}
            </div>
          </SectionBox>

          <SectionBox eyebrow="stitch">
            <RangeRow label="Seed" value={seed} min={1} max={99} step={1} onChange={setSeed} />
            <RangeRow label="Size" value={sizeMm} min={40} max={300} step={5} onChange={setSizeMm} fmt={(v) => fmtLen(v, units)} />
            <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={4} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
            <div>
              <div className={`${LABEL} mb-1.5`}>Line weight</div>
              <ModeButtons small options={[["1", "Run"], ["3", "Bean ×3"]] as const} value={String(bean)} onChange={(v) => setBean(Number(v) as 1 | 3)} />
            </div>
            {result.colors.length <= 1 && <ThreadRow hex={threadHex} onChange={setThreadHex} />}
            {result.colors.length > 1 && (
              <p className="text-[0.6875rem] text-mid leading-relaxed">This pattern uses {result.colors.length} threads from its color blocks, sewn in order.</p>
            )}
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail built={built} colors={previewColors} name="bayside-blocks" emptyHint="Stack some blocks to build a pattern - no code needed.">
          {built && (
            <p className="text-[0.6875rem] text-mid tabular-nums">
              {blocks.filter((b) => b.type !== "color").length} drawing blocks → {result.strokeCount} strokes → {built.stats.realStitches.toLocaleString()} stitches
            </p>
          )}
        </PreviewRail>
      }
    />
  );
}
