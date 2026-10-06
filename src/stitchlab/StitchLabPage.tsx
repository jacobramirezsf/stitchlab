// Bayside Stitch Lab - internal test bench. Unlisted route (/stitchlab):
// no nav links anywhere, robots noindex, shared by URL only. Nothing here is
// imported by the public site or the /lab composer.
//
// Two benches:
//   Inspect - drop a real .dst/.pes/.pec machine file → true stats, a
//             thread-look preview colored from the Madeira Polyneon
//             inventory, a density heatmap, and animated stitch-out.
//   Create  - generative toys (spirograph / scribble / SVG outline) that
//             export genuine .DST files. The preview is re-parsed from the
//             exact bytes you download, so what you see is the file.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { saveBlob } from "./lib/native";
import { THREADS, THREAD_FAMILIES } from "../data/threads";
import { CMD, colorBlocks, type ParsedPattern } from "./lib/pattern";
import { parseDst, writeDst } from "./lib/dst";
import { parsePes } from "./lib/pec";
import { computeStats, DEFAULT_MACHINE, type MachineParams } from "./lib/stats";
import {
  fitTransform,
  renderDensity,
  renderPattern,
  StitchAnimator,
  type RenderOptions,
} from "./lib/render";
import { defaultHexForBlock, nearestThreads } from "./lib/threadMatch";
import {
  pathsToStitches,
  resamplePath,
  spirograph,
  svgToPaths,
  type PathMm,
} from "./lib/generators";
import { ToolsHost } from "./tools";

const EYEBROW = "text-[0.6875rem] tracking-[0.18em] uppercase text-mid";
const LABEL = "text-[0.6875rem] tracking-[0.14em] uppercase text-mid";
const FABRICS = [
  { name: "Bone", hex: "#f4f2ee" },
  { name: "Oat", hex: "#eceae5" },
  { name: "Navy", hex: "#22304f" },
  { name: "Charcoal", hex: "#191714" },
  { name: "White", hex: "#ffffff" },
];

function formatMinutes(min: number): string {
  if (min < 1) return `${Math.round(min * 60)}s`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ─── Canvas plumbing ─────────────────────────────────────────────────────

type CanvasDraw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

function useCanvas(draw: CanvasDraw | null) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !draw) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, w, h);
  }, [draw]);
  return ref;
}

// ─── Small controls ──────────────────────────────────────────────────────

function ThreadSelect({
  value,
  onChange,
  compact,
}: {
  value: string;
  onChange: (hex: string, code: string) => void;
  compact?: boolean;
}) {
  return (
    <select
      className={`border border-hairline bg-bg text-fg rounded-none px-2 ${
        compact ? "py-1 text-[0.75rem]" : "py-1.5 text-[0.8125rem]"
      }`}
      value={value}
      onChange={(ev) => {
        const t = THREADS.find((th) => th.code === ev.target.value);
        if (t?.hex) onChange(t.hex, t.code);
      }}
    >
      <option value="">Pick a cone…</option>
      {THREAD_FAMILIES.map((fam) => {
        const members = THREADS.filter((t) => t.family === fam && t.hex);
        if (members.length === 0) return null;
        return (
          <optgroup key={fam} label={fam}>
            {members.map((t) => (
              <option key={t.code} value={t.code}>
                {t.code} - {t.name}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(ev) => onChange(ev.target.checked)}
        className="accent-accent"
      />
      {label}
    </label>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border border-hairline bg-card px-3 py-2" title={hint}>
      <div className={LABEL}>{label}</div>
      <div className="mt-0.5 text-[0.9375rem] text-fg tabular-nums">{value}</div>
    </div>
  );
}

// ─── Inspect bench ───────────────────────────────────────────────────────

function InspectBench() {
  const [pattern, setPattern] = useState<ParsedPattern | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [assigned, setAssigned] = useState<Record<number, string>>({});
  const [sheen, setSheen] = useState(true);
  const [showTravel, setShowTravel] = useState(false);
  const [density, setDensity] = useState(false);
  const [fabric, setFabric] = useState(FABRICS[0].hex);
  const [machine, setMachine] = useState<MachineParams>(DEFAULT_MACHINE);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(900); // records per second
  const [animPos, setAnimPos] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animatorRef = useRef<StitchAnimator | null>(null);
  const rafRef = useRef<number>(0);

  const stats = useMemo(() => (pattern ? computeStats(pattern, machine) : null), [pattern, machine]);
  const blocks = useMemo(() => (pattern ? colorBlocks(pattern) : []), [pattern]);
  const colors = useMemo(
    () =>
      blocks.map(
        (b) => assigned[b.index] ?? b.colorHex ?? defaultHexForBlock(b.index),
      ),
    [blocks, assigned],
  );

  const loadFile = useCallback(async (file: File) => {
    setError(null);
    setPlaying(false);
    setAnimPos(null);
    setAssigned({});
    try {
      const buf = await file.arrayBuffer();
      const lower = file.name.toLowerCase();
      let parsed: ParsedPattern;
      if (lower.endsWith(".dst")) parsed = parseDst(buf);
      else if (lower.endsWith(".pes") || lower.endsWith(".pec")) parsed = parsePes(buf);
      else throw new Error("Drop a .dst, .pes, or .pec file.");
      setPattern(parsed);
      setFileName(file.name);
    } catch (err) {
      setPattern(null);
      setError(err instanceof Error ? err.message : "Could not parse that file.");
    }
  }, []);

  const renderOpts = useMemo<RenderOptions>(
    () => ({ colors, sheen, showTravel }),
    [colors, sheen, showTravel],
  );

  // Static render (and animation reset) whenever inputs change.
  const staticDraw = useMemo<CanvasDraw | null>(() => {
    if (!pattern) return null;
    return (ctx, w, h) => {
      ctx.fillStyle = fabric;
      ctx.fillRect(0, 0, w, h);
      const view = fitTransform(pattern, w, h);
      if (animPos === null) {
        renderPattern(ctx, pattern, view, renderOpts);
      } else {
        animatorRef.current = new StitchAnimator(ctx, pattern, view, renderOpts, () => {
          ctx.fillStyle = fabric;
          ctx.fillRect(0, 0, w, h);
        });
        animatorRef.current.seek(animPos);
      }
      if (density) {
        const max = renderDensity(ctx, pattern, view);
        ctx.fillStyle = "rgba(28,28,26,0.75)";
        ctx.font = "11px system-ui, sans-serif";
        ctx.fillText(`density peak ≈ ${max.toFixed(1)} passes / 0.8mm cell`, 10, h - 10);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pattern, renderOpts, fabric, density, animPos === null]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !staticDraw) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    staticDraw(ctx, w, h);
  }, [staticDraw]);

  // Playback loop - imperative, canvas-direct; React state only for the readout.
  useEffect(() => {
    if (!playing || !pattern) return;
    let last = performance.now();
    let readoutAt = 0;
    const tick = (now: number) => {
      const animator = animatorRef.current;
      if (!animator) return;
      const advance = ((now - last) / 1000) * speed;
      last = now;
      const target = Math.min(animator.total, animator.position + advance);
      animator.seek(target);
      if (now - readoutAt > 120) {
        readoutAt = now;
        setAnimPos(target);
      }
      if (target >= animator.total) {
        setPlaying(false);
        setAnimPos(animator.total);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, speed, pattern]);

  const startPlayback = () => {
    if (!pattern) return;
    if (animPos === null || animPos >= pattern.stitches.length) setAnimPos(0);
    setPlaying(true);
    if (animPos === null) setAnimPos(0);
  };

  return (
    <div className="space-y-6">
      <div
        onDragOver={(ev) => {
          ev.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(ev) => {
          ev.preventDefault();
          setDragOver(false);
          const f = ev.dataTransfer.files?.[0];
          if (f) void loadFile(f);
        }}
        className={`border border-dashed px-6 py-8 text-center transition-colors ${
          dragOver ? "border-accent bg-card" : "border-mid/60"
        }`}
      >
        <p className="text-[0.9375rem] text-fg">
          Drop a machine file here - <span className="tabular-nums">.dst / .pes / .pec</span>
        </p>
        <p className="mt-1 text-[0.8125rem] text-mid">
          Parsed entirely in your browser. Nothing uploads anywhere.
        </p>
        <label className="mt-3 inline-block cursor-pointer border border-hairline bg-bg px-4 py-1.5 text-[0.8125rem] text-fg hover:bg-card">
          Choose file
          <input
            type="file"
            accept=".dst,.pes,.pec"
            className="hidden"
            onChange={(ev) => {
              const f = ev.target.files?.[0];
              if (f) void loadFile(f);
              ev.target.value = "";
            }}
          />
        </label>
        {error && <p className="mt-3 text-[0.8125rem] text-red-700">{error}</p>}
      </div>

      {pattern && stats && (
        <>
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <h2 className="font-serif text-[1.375rem] text-fg">
              {pattern.name || fileName}
              <span className="ml-3 text-[0.75rem] font-sans uppercase tracking-[0.14em] text-mid">
                {pattern.format}
                {pattern.meta.pesVersion ? ` v${pattern.meta.pesVersion}` : ""}
              </span>
            </h2>
            {pattern.format !== "dst" && (
              <p className="text-[0.75rem] text-mid">
                PES/PEC colors are the machine's 64-color approximation - assign real cones below.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            <Stat label="Stitches" value={stats.realStitches.toLocaleString()} hint="Needle penetrations only - jumps and trims excluded" />
            <Stat label="Size" value={`${stats.widthMm.toFixed(1)} × ${stats.heightMm.toFixed(1)} mm`} />
            <Stat
              label="Colors"
              value={`${stats.colorBlockCount} block${stats.colorBlockCount === 1 ? "" : "s"}`}
              hint={`${stats.colorChanges} color change command(s)`}
            />
            <Stat
              label="Trims"
              value={`${stats.explicitTrims > 0 ? stats.explicitTrims : stats.inferredTrims}${
                stats.explicitTrims > 0 ? "" : " (inferred)"
              }`}
              hint="DST has no trim opcode - runs of 3+ jumps are counted as trims"
            />
            <Stat label="Jumps" value={stats.jumps.toLocaleString()} />
            <Stat
              label="Thread needed"
              value={`${stats.needleThreadM.toFixed(1)} + ${stats.bobbinThreadM.toFixed(1)} m`}
              hint={`Needle + bobbin estimate (A&E consumption model at ${((stats.needleThreadM / Math.max(1, stats.realStitches)) * 1000000).toFixed(1)}mm/stitch). Flat path ${stats.stitchPathM.toFixed(1)}m. Add 10–15% waste when planning cones.`}
            />
            <Stat
              label="Stitch length"
              value={`${stats.avgStitchMm.toFixed(2)} avg / ${stats.maxStitchMm.toFixed(1)} max mm`}
            />
            <Stat label="Density" value={`${stats.stitchesPerMm2.toFixed(1)} st/mm²`} hint="Real stitches over bounding-box area" />
            <Stat
              label="Est. runtime"
              value={formatMinutes(stats.runtimeMinutes)}
              hint={`Stitching ${formatMinutes(stats.runtimeBreakdown.stitching)} + colors ${formatMinutes(
                stats.runtimeBreakdown.colorChanges,
              )} + trims ${formatMinutes(stats.runtimeBreakdown.trims)} + hooping ${formatMinutes(
                stats.runtimeBreakdown.setup,
              )}`}
            />
            <Stat label="Records" value={stats.totalRecords.toLocaleString()} />
          </div>

          <details className="border border-hairline bg-card px-4 py-3">
            <summary className={`${LABEL} cursor-pointer`}>Machine assumptions (editable)</summary>
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
              {(
                [
                  ["stitchesPerMinute", "Stitches / min"],
                  ["secondsPerColorChange", "Sec / color change"],
                  ["secondsPerTrim", "Sec / trim"],
                  ["setupMinutes", "Hooping / setup min"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="text-[0.75rem] text-mid">
                  {label}
                  <input
                    type="number"
                    min={key === "stitchesPerMinute" ? 100 : 0}
                    value={machine[key]}
                    onChange={(ev) =>
                      setMachine((m) => ({ ...m, [key]: Number(ev.target.value) || 0 }))
                    }
                    className="mt-1 w-full border border-hairline bg-bg px-2 py-1 text-[0.8125rem] text-fg tabular-nums"
                  />
                </label>
              ))}
            </div>
          </details>

          <div className="grid lg:grid-cols-[1fr_260px] gap-4 items-start">
            <div className="space-y-3">
              <canvas
                ref={canvasRef}
                className="w-full h-[440px] border border-hairline"
                style={{ background: fabric }}
              />
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <Toggle label="Thread sheen" checked={sheen} onChange={setSheen} />
                <Toggle label="Travel threads" checked={showTravel} onChange={setShowTravel} />
                <Toggle label="Density heatmap" checked={density} onChange={setDensity} />
                <div className="flex items-center gap-1.5 ml-auto">
                  {FABRICS.map((f) => (
                    <button
                      key={f.hex}
                      title={f.name}
                      onClick={() => setFabric(f.hex)}
                      className={`w-6 h-6 border ${
                        fabric === f.hex ? "border-accent border-2" : "border-hairline"
                      }`}
                      style={{ background: f.hex }}
                    />
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 border border-hairline bg-card px-3 py-2.5">
                <button
                  onClick={() => (playing ? setPlaying(false) : startPlayback())}
                  className="border border-fg bg-fg text-bg px-4 py-1 text-[0.8125rem] hover:opacity-85"
                >
                  {playing ? "Pause" : animPos !== null && animPos > 0 ? "Resume" : "Stitch it out"}
                </button>
                <button
                  onClick={() => {
                    setPlaying(false);
                    setAnimPos(null);
                  }}
                  className="border border-hairline bg-bg px-3 py-1 text-[0.8125rem] text-fg hover:bg-card"
                >
                  Full view
                </button>
                <input
                  type="range"
                  min={0}
                  max={pattern.stitches.length}
                  value={animPos ?? pattern.stitches.length}
                  onChange={(ev) => {
                    setPlaying(false);
                    setAnimPos(Number(ev.target.value));
                  }}
                  className="flex-1 min-w-[140px] accent-accent"
                />
                <span className="text-[0.75rem] text-mid tabular-nums">
                  {(animPos ?? pattern.stitches.length).toLocaleString()} /{" "}
                  {pattern.stitches.length.toLocaleString()}
                </span>
                <label className="text-[0.75rem] text-mid flex items-center gap-2">
                  Speed
                  <input
                    type="range"
                    min={60}
                    max={6000}
                    step={20}
                    value={speed}
                    onChange={(ev) => setSpeed(Number(ev.target.value))}
                    className="w-24 accent-accent"
                  />
                </label>
              </div>
            </div>

            <div className="space-y-2">
              <div className={EYEBROW}>/ Thread assignment /</div>
              {blocks.map((b) => {
                const current = colors[b.index];
                const fileHex = b.colorHex;
                const suggestion = fileHex ? nearestThreads(fileHex, 1)[0] : null;
                return (
                  <div key={b.index} className="border border-hairline bg-card px-3 py-2 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span
                        className="w-4 h-4 border border-hairline shrink-0"
                        style={{ background: current }}
                      />
                      <span className="text-[0.8125rem] text-fg">
                        Block {b.index + 1}
                        <span className="text-mid"> - {b.stitchCount.toLocaleString()} st</span>
                      </span>
                    </div>
                    <ThreadSelect
                      compact
                      value={THREADS.find((t) => t.hex === current)?.code ?? ""}
                      onChange={(hex) => setAssigned((a) => ({ ...a, [b.index]: hex }))}
                    />
                    {suggestion && suggestion.thread.hex !== current && (
                      <button
                        onClick={() =>
                          setAssigned((a) => ({ ...a, [b.index]: suggestion.thread.hex! }))
                        }
                        className="text-[0.6875rem] text-accent hover:underline text-left"
                      >
                        ≈ nearest cone: {suggestion.thread.code} {suggestion.thread.name}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Create bench ────────────────────────────────────────────────────────

type CreateMode = "spiro" | "scribble" | "svg";

function CreateBench() {
  const [mode, setMode] = useState<CreateMode>("spiro");
  const [threadHex, setThreadHex] = useState(
    THREADS.find((t) => t.code === "1568")?.hex ?? "#082870",
  );
  const [stitchLen, setStitchLen] = useState(2.8);
  const [bean, setBean] = useState<1 | 3 | 5>(1);
  const [sizeMm, setSizeMm] = useState(90);
  const [fabric, setFabric] = useState(FABRICS[0].hex);

  // Spirograph params
  const [kind, setKind] = useState<"hypo" | "epi">("hypo");
  const [R, setR] = useState(60);
  const [r, setRr] = useState(42);
  const [d, setD] = useState(0.85);

  // Scribble strokes in pad px
  const [strokes, setStrokes] = useState<PathMm[]>([]);
  const padRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef<PathMm | null>(null);

  // SVG
  const [svgText, setSvgText] = useState("");
  const [svgError, setSvgError] = useState<string | null>(null);

  const paths = useMemo<PathMm[]>(() => {
    try {
      setSvgError(null);
      if (mode === "spiro") {
        return spirograph({ kind, R, r, d, sizeMm, stitchLenMm: stitchLen });
      }
      if (mode === "scribble") {
        if (strokes.length === 0) return [];
        const pad = padRef.current;
        const scale = sizeMm / (pad?.clientWidth || 320);
        const smoothed = strokes.map((s) =>
          s.map((p, i, arr) => {
            const a = arr[Math.max(0, i - 1)];
            const c = arr[Math.min(arr.length - 1, i + 1)];
            return { x: ((a.x + p.x + c.x) / 3) * scale, y: ((a.y + p.y + c.y) / 3) * scale };
          }),
        );
        return smoothed.map((s) => resamplePath(s, stitchLen));
      }
      if (mode === "svg" && svgText.trim()) {
        const sampled = svgToPaths(svgText, sizeMm);
        return sampled.map((p) => resamplePath(p, stitchLen));
      }
      return [];
    } catch (err) {
      setSvgError(err instanceof Error ? err.message : "Could not read that SVG.");
      return [];
    }
  }, [mode, kind, R, r, d, sizeMm, stitchLen, strokes, svgText]);

  const designName = useMemo(() => {
    if (mode === "spiro") return `spiro-${kind}-${R}-${r}`;
    if (mode === "scribble") return "bayside-scribble";
    return "bayside-svg";
  }, [mode, kind, R, r]);

  // The honest pipeline: paths → stitches → DST bytes → re-parse → preview.
  const built = useMemo(() => {
    if (paths.length === 0) return null;
    const stitches = pathsToStitches(paths, bean);
    if (stitches.filter((s) => s.cmd === CMD.STITCH).length < 2) return null;
    try {
      const bytes = writeDst(stitches, designName);
      const reparsed = parseDst(bytes.buffer as ArrayBuffer);
      return { bytes, reparsed, stats: computeStats(reparsed) };
    } catch {
      return null;
    }
  }, [paths, bean, designName]);

  const previewDraw = useMemo<CanvasDraw | null>(() => {
    if (!built) return null;
    return (ctx, w, h) => {
      ctx.fillStyle = fabric;
      ctx.fillRect(0, 0, w, h);
      const view = fitTransform(built.reparsed, w, h);
      renderPattern(ctx, built.reparsed, view, { colors: [threadHex], sheen: true });
    };
  }, [built, threadHex, fabric]);
  const previewRef = useCanvas(previewDraw);

  // Scribble pad live drawing
  useEffect(() => {
    const pad = padRef.current;
    if (!pad || mode !== "scribble") return;
    const dpr = window.devicePixelRatio || 1;
    pad.width = Math.round(pad.clientWidth * dpr);
    pad.height = Math.round(pad.clientHeight * dpr);
    const ctx = pad.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, pad.clientWidth, pad.clientHeight);
    ctx.strokeStyle = "#1c1c1a";
    ctx.lineWidth = 1.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of strokes.concat(drawingRef.current ? [drawingRef.current] : [])) {
      ctx.beginPath();
      s.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
    }
  }, [strokes, mode]);

  const download = () => {
    if (!built) return;
    void saveBlob(new Blob([new Uint8Array(built.bytes)], { type: "application/octet-stream" }), `${designName}.dst`);
  };

  const padPointer = (ev: React.PointerEvent<HTMLCanvasElement>, phase: "down" | "move" | "up") => {
    const pad = padRef.current;
    if (!pad) return;
    const rect = pad.getBoundingClientRect();
    const p = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    if (phase === "down") {
      drawingRef.current = [p];
      pad.setPointerCapture(ev.pointerId);
    } else if (phase === "move" && drawingRef.current) {
      const lastP = drawingRef.current[drawingRef.current.length - 1];
      if (Math.hypot(p.x - lastP.x, p.y - lastP.y) > 2) {
        drawingRef.current.push(p);
        setStrokes((s) => s.slice()); // repaint with in-progress stroke
      }
    } else if (phase === "up" && drawingRef.current) {
      const done = drawingRef.current;
      drawingRef.current = null;
      if (done.length > 2) setStrokes((s) => [...s, done]);
      else setStrokes((s) => s.slice());
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {(
          [
            ["spiro", "Spirograph"],
            ["scribble", "Scribble"],
            ["svg", "SVG outline"],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-4 py-1.5 text-[0.8125rem] border ${
              mode === m
                ? "border-fg bg-fg text-bg"
                : "border-hairline bg-bg text-fg hover:bg-card"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid lg:grid-cols-[300px_1fr] gap-5 items-start">
        <div className="space-y-4">
          {mode === "spiro" && (
            <div className="space-y-3 border border-hairline bg-card px-4 py-3">
              <div className={EYEBROW}>/ Wheels /</div>
              <div className="flex gap-2">
                {(["hypo", "epi"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setKind(k)}
                    className={`px-3 py-1 text-[0.75rem] border ${
                      kind === k ? "border-fg bg-fg text-bg" : "border-hairline bg-bg text-fg"
                    }`}
                  >
                    {k === "hypo" ? "Inside (hypo)" : "Outside (epi)"}
                  </button>
                ))}
              </div>
              {(
                [
                  ["Ring R", R, 20, 96, 1, (v: number) => setR(v)],
                  ["Wheel r", r, 5, 95, 1, (v: number) => setRr(v)],
                  ["Pen offset", d, 0, 1.5, 0.05, (v: number) => setD(v)],
                ] as const
              ).map(([label, value, min, max, step, set]) => (
                <label key={label} className="block text-[0.75rem] text-mid">
                  {label} <span className="tabular-nums text-fg">{value}</span>
                  <input
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    onChange={(ev) => set(Number(ev.target.value))}
                    className="w-full accent-accent"
                  />
                </label>
              ))}
            </div>
          )}

          {mode === "scribble" && (
            <div className="space-y-2 border border-hairline bg-card px-4 py-3">
              <div className={EYEBROW}>/ Draw /</div>
              <canvas
                ref={padRef}
                className="w-full aspect-square bg-white border border-hairline touch-none cursor-crosshair"
                onPointerDown={(ev) => padPointer(ev, "down")}
                onPointerMove={(ev) => padPointer(ev, "move")}
                onPointerUp={(ev) => padPointer(ev, "up")}
              />
              <div className="flex gap-2">
                <button
                  onClick={() => setStrokes((s) => s.slice(0, -1))}
                  className="border border-hairline bg-bg px-3 py-1 text-[0.75rem] text-fg hover:bg-card"
                >
                  Undo stroke
                </button>
                <button
                  onClick={() => setStrokes([])}
                  className="border border-hairline bg-bg px-3 py-1 text-[0.75rem] text-fg hover:bg-card"
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {mode === "svg" && (
            <div className="space-y-2 border border-hairline bg-card px-4 py-3">
              <div className={EYEBROW}>/ SVG in /</div>
              <label className="inline-block cursor-pointer border border-hairline bg-bg px-3 py-1.5 text-[0.8125rem] text-fg hover:opacity-80">
                Choose .svg
                <input
                  type="file"
                  accept=".svg,image/svg+xml"
                  className="hidden"
                  onChange={async (ev) => {
                    const f = ev.target.files?.[0];
                    if (f) setSvgText(await f.text());
                    ev.target.value = "";
                  }}
                />
              </label>
              <textarea
                value={svgText}
                onChange={(ev) => setSvgText(ev.target.value)}
                placeholder="…or paste SVG markup"
                rows={5}
                className="w-full border border-hairline bg-bg px-2 py-1.5 text-[0.75rem] text-fg font-mono"
              />
              {svgError && <p className="text-[0.75rem] text-red-700">{svgError}</p>}
              <p className="text-[0.6875rem] text-mid leading-relaxed">
                Outlines only - every path is traced as running stitch. Fills, satin, and
                real digitizing stay human for now.
              </p>
            </div>
          )}

          <div className="space-y-3 border border-hairline bg-card px-4 py-3">
            <div className={EYEBROW}>/ Stitch settings /</div>
            <label className="block text-[0.75rem] text-mid">
              Size (longest side){" "}
              <span className="tabular-nums text-fg">{sizeMm} mm</span>
              <input
                type="range"
                min={30}
                max={200}
                value={sizeMm}
                onChange={(ev) => setSizeMm(Number(ev.target.value))}
                className="w-full accent-accent"
              />
            </label>
            <label className="block text-[0.75rem] text-mid">
              Stitch length <span className="tabular-nums text-fg">{stitchLen.toFixed(1)} mm</span>
              <input
                type="range"
                min={1.5}
                max={5}
                step={0.1}
                value={stitchLen}
                onChange={(ev) => setStitchLen(Number(ev.target.value))}
                className="w-full accent-accent"
              />
            </label>
            <div className="flex items-center gap-2">
              <span className="text-[0.75rem] text-mid">Line weight</span>
              {([1, 3, 5] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setBean(p)}
                  className={`px-2.5 py-1 text-[0.75rem] border ${
                    bean === p ? "border-fg bg-fg text-bg" : "border-hairline bg-bg text-fg"
                  }`}
                >
                  {p === 1 ? "Run" : p === 3 ? "Bean ×3" : "Bean ×5"}
                </button>
              ))}
            </div>
            <div className="text-[0.75rem] text-mid">
              Thread
              <div className="mt-1 flex items-center gap-2">
                <span className="w-5 h-5 border border-hairline" style={{ background: threadHex }} />
                <ThreadSelect
                  value={THREADS.find((t) => t.hex === threadHex)?.code ?? ""}
                  onChange={(hex) => setThreadHex(hex)}
                />
              </div>
            </div>
          </div>

          <button
            onClick={download}
            disabled={!built}
            className="w-full border border-fg bg-fg text-bg px-4 py-2 text-[0.875rem] disabled:opacity-40 hover:opacity-85"
          >
            Download {designName}.dst
          </button>
          <p className="text-[0.6875rem] text-mid leading-relaxed">
            The preview is re-parsed from the exact DST bytes you'll download - what you see is
            the file your machine reads.
          </p>
        </div>

        <div className="space-y-3">
          <canvas
            ref={previewRef}
            className="w-full h-[460px] border border-hairline"
            style={{ background: fabric }}
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {built ? (
              <p className="text-[0.8125rem] text-mid tabular-nums">
                {built.stats.realStitches.toLocaleString()} stitches ·{" "}
                {built.stats.widthMm.toFixed(0)} × {built.stats.heightMm.toFixed(0)} mm ·{" "}
                {built.stats.stitchPathM.toFixed(1)} m thread · ~
                {formatMinutes(built.stats.runtimeMinutes)} on machine
              </p>
            ) : (
              <p className="text-[0.8125rem] text-mid">
                {mode === "scribble"
                  ? "Draw something to generate stitches."
                  : mode === "svg"
                    ? "Load an SVG to generate stitches."
                    : "Adjust the wheels."}
              </p>
            )}
            <div className="flex items-center gap-1.5 ml-auto">
              {FABRICS.map((f) => (
                <button
                  key={f.hex}
                  title={f.name}
                  onClick={() => setFabric(f.hex)}
                  className={`w-6 h-6 border ${
                    fabric === f.hex ? "border-accent border-2" : "border-hairline"
                  }`}
                  style={{ background: f.hex }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────

// Hash routing: "" → inspect, "#create" → create, "#tools" → experiments
// index, "#tools/<slug>" → an individual tool page. Keeps every tool
// linkable on static hosting without server rewrites.
type TabState = { tab: "inspect" | "create" | "tools"; toolSlug: string | null };

function readHash(): TabState {
  const h = window.location.hash.replace(/^#/, "");
  if (h === "create") return { tab: "create", toolSlug: null };
  if (h === "tools") return { tab: "tools", toolSlug: null };
  const m = h.match(/^tools\/([\w-]+)$/);
  if (m) return { tab: "tools", toolSlug: m[1] };
  return { tab: "inspect", toolSlug: null };
}

export default function StitchLabPage() {
  const [{ tab, toolSlug }, setTabState] = useState<TabState>(readHash);

  useEffect(() => {
    const onHash = () => setTabState(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (next: TabState) => {
    const hash =
      next.tab === "inspect"
        ? ""
        : next.tab === "create"
          ? "#create"
          : next.toolSlug
            ? `#tools/${next.toolSlug}`
            : "#tools";
    // Assigning location.hash pushes a history entry (back button works);
    // clearing to inspect uses pushState to avoid a jump-to-top.
    if (hash) window.location.hash = hash;
    else history.pushState(null, "", window.location.pathname);
    setTabState(next);
  };

  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex";
    document.head.appendChild(meta);
    document.title = "Bayside - Stitch Lab (internal)";
    return () => meta.remove();
  }, []);

  return (
    <div className="min-h-screen bg-bg text-fg font-sans">
      <header className="border-b border-hairline">
        <div className="mx-auto max-w-[1100px] px-pad py-5 flex items-baseline justify-between flex-wrap gap-2">
          <div>
            <div className={EYEBROW}>/ Bayside test bench - internal, unlisted /</div>
            <h1 className="font-serif text-[1.75rem] leading-tight">Stitch Lab</h1>
          </div>
          <nav className="flex gap-2">
            {(
              [
                ["inspect", "Inspect a file"],
                ["create", "Create + stitch"],
                ["tools", "Experiments"],
              ] as const
            ).map(([t, label]) => (
              <button
                key={t}
                onClick={() => navigate({ tab: t, toolSlug: null })}
                className={`px-4 py-1.5 text-[0.8125rem] border ${
                  tab === t
                    ? "border-fg bg-fg text-bg"
                    : "border-hairline bg-bg text-fg hover:bg-card"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1100px] px-pad py-8">
        {tab === "inspect" ? (
          <InspectBench />
        ) : tab === "create" ? (
          <CreateBench />
        ) : (
          <ToolsHost
            slug={toolSlug}
            onNavigate={(slug) => navigate({ tab: "tools", toolSlug: slug })}
          />
        )}
      </main>

      <footer className="border-t border-hairline mt-10">
        <div className="mx-auto max-w-[1100px] px-pad py-5 text-[0.6875rem] text-mid leading-relaxed">
          Open-source groundwork for browser-native machine embroidery tools. Format knowledge
          ported from pyembroidery (MIT) and cross-checked against libembroidery (zlib); render
          recipes learned from stitchjs (MIT) and EmbroideryReader. Brother PEC palette via
          pyembroidery. Everything runs locally - no files leave this page.
        </div>
      </footer>
    </div>
  );
}
