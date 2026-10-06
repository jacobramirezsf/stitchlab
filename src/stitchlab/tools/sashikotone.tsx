import { useMemo, useState } from "react";
import {
  ToolLayout, SectionBox, RangeRow, ModeButtons, ImagePick, ThreadRow, PreviewRail,
  Warning, SizeField, buildDesign, useDebounced, type LumImg,
} from "./shared";
import { sashikoTone, toneSample, TONE_DEFAULTS, type ToneOptions } from "../lib/sashikoTone";
import { pathGroupsToStitches } from "../lib/generators";

const NAME = "bayside-sashikotone";
export default function SashikoToneTool() {
  const [photo, setPhoto] = useState<LumImg | null>(null);
  const [fileName, setFileName] = useState("");
  const [sample, setSample] = useState<"bloom" | "waves" | "ramp">("bloom");
  const [options, setOptions] = useState<ToneOptions>({ ...TONE_DEFAULTS });
  const [colorA, setColorA] = useState("#5C6753");
  const [colorB, setColorB] = useState("#4B010E");
  const [twoTone, setTwoTone] = useState(false);
  const source = useMemo(() => photo ?? toneSample(sample), [photo, sample]);
  const settled = useDebounced(options, 180);
  const pending = settled !== options;
  const result = useMemo(() => {
    try { return { data: sashikoTone(source, settled), error: "" }; }
    catch (error) { return { data: null, error: error instanceof Error ? error.message : "Could not make this design." }; }
  }, [source, settled]);
  const candidate = useMemo(() => {
    if (!result.data || pending) return null;
    const { horizontal, vertical } = result.data;
    return buildDesign(pathGroupsToStitches(twoTone ? [horizontal, vertical] : [[...horizontal, ...vertical]]), NAME);
  }, [result.data, pending, twoTone]);
  const overBudget = (candidate?.stats.realStitches ?? 0) > 60000;
  const built = overBudget ? null : candidate;
  // An empty first group must not offset the second group's color identity.
  const colors = twoTone && result.data
    ? [...(result.data.horizontal.length ? [colorA] : []), ...(result.data.vertical.length ? [colorB] : [])]
    : [colorA];
  const update = <K extends keyof ToneOptions>(field: K, value: ToneOptions[K]) =>
    setOptions((old) => ({ ...old, [field]: value }));
  return <ToolLayout controls={<>
    <SectionBox eyebrow="Picture">
      <ModeButtons small options={[["bloom", "Bloom"], ["waves", "Waves"], ["ramp", "Tone sampler"]]} value={photo ? "" : sample} onChange={(v) => { setSample(v as typeof sample); setPhoto(null); setFileName(""); }} />
      <ImagePick fileName={fileName} longSide={360} onImage={(img, name) => { setPhoto(img); setFileName(name); }} hint="Try a face, a leaf, or a bold silhouette. Samples work without an upload." />
    </SectionBox>
    <SectionBox eyebrow="Pattern">
      <ModeButtons small options={[["woven", "Woven tone"], ["open", "Open dashes"]]} value={options.mode} onChange={(v) => update("mode", v)} />
      <p className="text-xs text-mid leading-relaxed">{options.mode === "woven"
        ? "A light stitched ground stays visible. Shadow dashes widen into narrow three-pass ribbons, so the picture appears through thread coverage. One path per row or column."
        : "Fabric stays bare between selected dashes. The picture reads through dash density, with jumps between dashes. More carries and possible trims."}</p>
      <ModeButtons small options={[["alternate", "Crosses"], ["fibonacci", "Fibonacci"], ["random", "Seeded weave"]]} value={options.word} onChange={(v) => update("word", v)} />
      {options.word === "random" && <button className="border border-hairline px-3 py-2 text-xs" onClick={() => update("seed", options.seed + 37)}>New weave · seed {options.seed}</button>}
      <RangeRow label="Contrast" value={options.gamma} min={0.4} max={2.4} step={0.1} onChange={(v) => update("gamma", v)} fmt={(v) => v.toFixed(1)} />
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={options.invert} onChange={(e) => update("invert", e.target.checked)} />Invert light and dark</label>
    </SectionBox>
    <SectionBox eyebrow="Stitch">
      <SizeField valueMm={options.sizeMm} min={50} max={220} onChange={(v) => update("sizeMm", v)} />
      <RangeRow label="Grid pitch" value={options.pitchMm} min={2.5} max={7} step={0.25} onChange={(v) => update("pitchMm", v)} fmt={(v) => `${v.toFixed(2)} mm`} />
      <RangeRow label="Stitch length" value={options.stitchMm} min={1} max={3} step={0.25} onChange={(v) => update("stitchMm", v)} fmt={(v) => `${v.toFixed(2)} mm`} />
      <ThreadRow label={twoTone ? "Rows" : "Thread"} hex={colorA} onChange={setColorA} />
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={twoTone} onChange={(e) => setTwoTone(e.target.checked)} />Separate row and column colors</label>
      {twoTone && <ThreadRow label="Columns" hex={colorB} onChange={setColorB} />}
    </SectionBox>
    <Warning>A machine interpretation inspired by sashiko; the reverse will differ from hand stitching. Stitch a tone sampler before a large piece.</Warning>
    {overBudget && <div role="alert"><Warning>Over 60,000 stitches. Increase grid pitch or reduce size before exporting.</Warning></div>}
    {result.error && <div role="alert"><Warning>{result.error}</Warning></div>}
  </>} preview={<PreviewRail built={built} colors={colors} name={NAME} showDensity
    emptyHint={pending ? "Updating stitches…" : overBudget ? "Increase pitch or reduce size to export." : "No dashes at this tone. Invert the image or try Woven tone."}>
    {result.data && <p role="status" className="text-xs text-mid tabular-nums">{result.data.cols} × {result.data.rows} cells · actual pitch {result.data.pitchMm.toFixed(2)} mm · {result.data.activeDashes.toLocaleString()} weighted dashes · {(result.data.horizontal.length + result.data.vertical.length).toLocaleString()} paths</p>}
  </PreviewRail>} />;
}
