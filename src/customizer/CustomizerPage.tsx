import { useMemo, useRef, useState } from "react";
import { GARMENTS, type Garment, type GarmentColor } from "../data/garments";
import { SHAPES, type Shape } from "../data/shapes";
import { THREADS, type Thread } from "../data/threads";
import { estimateProject } from "../lib/pricing";
import type { DesignSize } from "../components/BlanksVisualizer.types";
import { apiBase } from "../stitchlab/lib/native";

// Bayside customizer: every photographed blank in the studio, the classic
// vector marks, free placement, and an inquiry that carries the whole design.

const LABEL =
  "text-[0.6875rem] tracking-[0.14em] uppercase text-dim font-medium";
const FIELD =
  "w-full bg-card border border-hairline px-3 py-2.5 text-[0.9375rem] text-fg placeholder:text-dim outline-none focus:border-fg";

// Only blanks with real photos make the switcher.
const BLANKS = GARMENTS.filter((g) => g.colors.length > 0);

// Rough real-world scale: garment ≈ 24" wide filling ~70% of the photo.
const INCH_FRACTION = 0.7 / 24;
const SIZES: { label: string; inches: number; bucket: DesignSize }[] = [
  { label: 'Small — about 2.5"', inches: 2.5, bucket: "small" },
  { label: 'Medium — about 4"', inches: 4, bucket: "medium" },
  { label: 'Large — about 7"', inches: 7, bucket: "large" },
];
const BOUNDS = { minX: 0.16, maxX: 0.84, minY: 0.12, maxY: 0.88 };

// A dozen go-to threads for mark color (full 126 live in the thread library).
const MARK_THREADS: Thread[] = [
  "1640", "1678", "1766", "1637", "1981", "1800",
  "1651", "1971", "1690", "1717", "1608", "1586",
]
  .map((code) => THREADS.find((t) => t.code === code && t.hex))
  .filter((t): t is Thread => Boolean(t))
  .concat(THREADS.filter((t) => t.hex && ["Black", "White"].includes(t.family)).slice(0, 2));

type Placement = {
  id: string;
  shapeId: string;
  x: number; // 0–1 center
  y: number;
  inches: number;
  flip: boolean;
  threadCode: string;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const uid = () => Math.random().toString(36).slice(2, 9);

function ShapeSvg({ shape, color, flip }: { shape: Shape; color: string; flip?: boolean }) {
  return (
    <svg
      viewBox={shape.viewBox}
      className="w-full h-full"
      style={flip ? { transform: "scaleX(-1)" } : undefined}
      aria-hidden
    >
      {shape.paths.map((d, i) => (
        <path key={i} d={d} fill={color} />
      ))}
    </svg>
  );
}

export default function CustomizerPage() {
  const [garmentId, setGarmentId] = useState(BLANKS[0].id);
  const garment: Garment = BLANKS.find((g) => g.id === garmentId) ?? BLANKS[0];
  const [colorSlug, setColorSlug] = useState(garment.colors[0].slug);
  const color: GarmentColor =
    garment.colors.find((c) => c.slug === colorSlug) ?? garment.colors[0];

  const [armedShape, setArmedShape] = useState<string | null>(null);
  const [inches, setInches] = useState(4);
  const [threadCode, setThreadCode] = useState(MARK_THREADS[0]?.code ?? "1640");
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = (msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2600);
  };

  const previewRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    id: string; startX: number; startY: number; origX: number; origY: number;
    moved: boolean;
  } | null>(null);

  const shapeById = useMemo(() => new Map(SHAPES.map((s) => [s.id, s])), []);
  const threadByCode = useMemo(
    () => new Map(MARK_THREADS.map((t) => [t.code, t])),
    []
  );
  const threadHex = (code: string) => threadByCode.get(code)?.hex ?? "#1c1c1a";

  const switchGarment = (g: Garment) => {
    setGarmentId(g.id);
    // keep placements; land on the closest colorway (same slug if it exists)
    const same = g.colors.find((c) => c.slug === colorSlug);
    setColorSlug((same ?? g.colors[0]).slug);
  };

  const place = (clientX: number, clientY: number) => {
    if (!armedShape || !previewRef.current) return;
    const r = previewRef.current.getBoundingClientRect();
    const fx = clamp((clientX - r.left) / r.width, BOUNDS.minX, BOUNDS.maxX);
    const fy = clamp((clientY - r.top) / r.height, BOUNDS.minY, BOUNDS.maxY);
    setPlacements((p) => [
      ...p,
      { id: uid(), shapeId: armedShape, x: fx, y: fy, inches, flip: false, threadCode },
    ]);
    setArmedShape(null);
    showNotice("Placed — drag to fine-tune, tap to select.");
  };

  const startDrag = (e: React.PointerEvent, p: Placement) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      id: p.id, startX: e.clientX, startY: e.clientY, origX: p.x, origY: p.y,
      moved: false,
    };
  };
  const onDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !previewRef.current) return;
    const r = previewRef.current.getBoundingClientRect();
    const dx = (e.clientX - d.startX) / r.width;
    const dy = (e.clientY - d.startY) / r.height;
    if (Math.abs(dx) + Math.abs(dy) > 0.004) d.moved = true;
    setPlacements((ps) =>
      ps.map((p) =>
        p.id === d.id
          ? {
              ...p,
              x: clamp(d.origX + dx, BOUNDS.minX, BOUNDS.maxX),
              y: clamp(d.origY + dy, BOUNDS.minY, BOUNDS.maxY),
            }
          : p
      )
    );
  };
  const endDrag = (p: Placement) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && !d.moved) setSelected(selected === p.id ? null : p.id);
  };

  const update = (id: string, patch: Partial<Placement>) =>
    setPlacements((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const remove = (id: string) => {
    setPlacements((ps) => ps.filter((p) => p.id !== id));
    if (selected === id) setSelected(null);
  };

  // ── inquiry ────────────────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  const complexity: DesignSize =
    placements.some((p) => p.inches >= 7)
      ? "large"
      : placements.some((p) => p.inches >= 4)
        ? "medium"
        : "small";
  const estimate = useMemo(
    () =>
      placements.length
        ? estimateProject({
            complexity,
            quantity: qty,
            blankCost: garment.blankCost || undefined,
            sourced: true,
            placements: placements.length,
          })
        : null,
    [placements, complexity, qty, garment.blankCost]
  );

  const summary = () => {
    const lines = placements.map((p, i) => {
      const s = shapeById.get(p.shapeId);
      const t = threadByCode.get(p.threadCode);
      return `${i + 1}. ${s?.name ?? p.shapeId} — about ${p.inches}", thread ${p.threadCode}${
        t ? ` ${t.name}` : ""
      }${p.flip ? ", flipped" : ""}, at ${(p.x * 100).toFixed(0)}%/${(p.y * 100).toFixed(0)}% of the front`;
    });
    return [
      `Customizer design — ${garment.brand} ${garment.name} (${garment.type}), color ${color.name}.`,
      ...lines,
    ].join("\n");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!placements.length) {
      showNotice("Place at least one mark first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const body = {
      name,
      email,
      projectType: "Customizer design",
      quantity: String(qty),
      description: summary(),
      notes,
      sourcing: "Bayside sources the blanks",
      selections: {
        garmentId: garment.id,
        garmentLabel: `${garment.brand} ${garment.name}`,
        colorName: color.name,
        threadCode: placements[0]?.threadCode,
        threadName: threadByCode.get(placements[0]?.threadCode ?? "")?.name,
        complexity,
      },
      estimate: estimate ?? undefined,
    };
    try {
      if (location.hostname === "localhost") {
        await new Promise((r) => setTimeout(r, 500));
        setSubmitted(true);
      } else {
        const res = await fetch(`${apiBase()}/api/inquiry`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error("send failed");
        setSubmitted(true);
      }
    } catch {
      setError("Couldn't send just now — email baysidedesignlab@gmail.com instead.");
    }
    setSubmitting(false);
  };

  const markWidthPct = (p: Placement) => p.inches * INCH_FRACTION * 100;

  return (
    <div className="min-h-screen bg-bg text-fg">
      <nav className="sticky top-0 z-30 h-nav flex items-center bg-bg/90 backdrop-blur-md border-b border-hairline">
        <div className="w-full max-w-site mx-auto px-pad flex items-center justify-between">
          <a
            href="https://www.baysidesf.org"
            className="text-fg"
            style={{
              fontFamily: "'Playfair Display', var(--font-serif)",
              fontWeight: 500,
              letterSpacing: "-0.005em",
              fontSize: "clamp(1.0625rem, 1.5vw, 1.25rem)",
            }}
          >
            Bayside
          </a>
          <span className={LABEL}>Customizer</span>
        </div>
      </nav>

      <header className="max-w-site mx-auto px-pad pt-[clamp(2rem,6vw,3.5rem)]">
        <p className={LABEL}>/ Design your piece /</p>
        <h1 className="mt-3 font-serif text-[clamp(1.875rem,4.5vw,2.75rem)] leading-[1.08]">
          Pick a blank, place a mark.
        </h1>
        <p className="mt-3 max-w-[36rem] text-[0.9375rem] text-mid leading-[1.65]">
          Switch through the blanks Bayside stocks, drop on any of the studio
          marks, and send it in. It&rsquo;s a starting point, not a final proof
          — Bayside confirms garment, sizing, and thread before stitching.
        </p>
      </header>

      <main className="max-w-site mx-auto px-pad py-[clamp(1.5rem,4vw,2.5rem)] grid grid-cols-1 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] gap-[clamp(1.25rem,3vw,2.5rem)]">
        {/* preview */}
        <section>
          <div
            ref={previewRef}
            onClick={(e) => place(e.clientX, e.clientY)}
            className={`relative w-full overflow-hidden border border-hairline bg-card select-none ${
              armedShape ? "cursor-crosshair" : ""
            }`}
          >
            <img
              src={color.imageFront}
              alt={`${garment.name} in ${color.name}`}
              className="block w-full pointer-events-none"
              draggable={false}
            />
            {placements.map((p) => {
              const s = shapeById.get(p.shapeId);
              if (!s) return null;
              const w = markWidthPct(p);
              return (
                <div
                  key={p.id}
                  role="button"
                  aria-label={`${s.name} — drag to move, tap to select`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    startDrag(e, p);
                  }}
                  onPointerMove={onDrag}
                  onPointerUp={() => endDrag(p)}
                  onClick={(e) => e.stopPropagation()}
                  className={`absolute cursor-grab active:cursor-grabbing touch-none ${
                    selected === p.id ? "outline outline-2 outline-fg/70 outline-offset-2" : ""
                  }`}
                  style={{
                    left: `${p.x * 100}%`,
                    top: `${p.y * 100}%`,
                    width: `${w}%`,
                    transform: "translate(-50%, -50%)",
                  }}
                >
                  <ShapeSvg shape={s} color={threadHex(p.threadCode)} flip={p.flip} />
                </div>
              );
            })}
            {armedShape ? (
              <div className="absolute inset-x-0 top-3 flex justify-center pointer-events-none">
                <span className="bg-fg text-bg text-[0.75rem] px-3 py-1.5">
                  Tap the garment to place it
                </span>
              </div>
            ) : null}
            {notice ? (
              <div className="absolute inset-x-0 bottom-3 flex justify-center pointer-events-none">
                <span className="bg-fg text-bg text-[0.75rem] px-3 py-1.5">{notice}</span>
              </div>
            ) : null}
          </div>

          {/* colorways */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className={LABEL}>{color.name}</span>
            <span className="flex flex-wrap gap-1.5">
              {garment.colors.map((c) => (
                <button
                  key={c.slug}
                  type="button"
                  title={c.name}
                  onClick={() => setColorSlug(c.slug)}
                  className={`w-6 h-6 rounded-full border cursor-pointer ${
                    c.slug === color.slug
                      ? "border-fg ring-1 ring-fg ring-offset-1 ring-offset-bg"
                      : "border-hairline hover:border-fg"
                  }`}
                  style={{ backgroundColor: c.hex }}
                />
              ))}
            </span>
          </div>

          {/* selected mark controls */}
          {selected ? (
            (() => {
              const p = placements.find((x) => x.id === selected);
              if (!p) return null;
              const s = shapeById.get(p.shapeId);
              return (
                <div className="mt-4 border border-hairline bg-card p-3 flex flex-wrap items-center gap-3 text-[0.8125rem]">
                  <strong className="font-medium">{s?.name}</strong>
                  {SIZES.map((sz) => (
                    <button
                      key={sz.inches}
                      type="button"
                      onClick={() => update(p.id, { inches: sz.inches })}
                      className={`border px-2.5 py-1 cursor-pointer ${
                        p.inches === sz.inches
                          ? "border-fg bg-fg text-bg"
                          : "border-hairline text-mid hover:border-fg"
                      }`}
                    >
                      {sz.inches}&Prime;
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => update(p.id, { flip: !p.flip })}
                    className="border border-hairline px-2.5 py-1 text-mid hover:border-fg cursor-pointer"
                  >
                    ↔ Flip
                  </button>
                  <span className="flex gap-1.5 items-center">
                    {MARK_THREADS.map((t) => (
                      <button
                        key={t.code}
                        type="button"
                        title={`${t.code} ${t.name}`}
                        onClick={() => update(p.id, { threadCode: t.code })}
                        className={`w-5 h-5 rounded-full border cursor-pointer ${
                          p.threadCode === t.code
                            ? "border-fg ring-1 ring-fg ring-offset-1 ring-offset-bg"
                            : "border-hairline"
                        }`}
                        style={{ backgroundColor: t.hex ?? "#999" }}
                      />
                    ))}
                  </span>
                  <button
                    type="button"
                    onClick={() => remove(p.id)}
                    className="ml-auto text-mid underline underline-offset-2 hover:text-fg cursor-pointer"
                  >
                    Remove
                  </button>
                </div>
              );
            })()
          ) : null}
        </section>

        {/* controls */}
        <section className="flex flex-col gap-6">
          <div>
            <h2 className={LABEL}>Blanks</h2>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {BLANKS.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => switchGarment(g)}
                  className={`text-left border p-2.5 cursor-pointer transition-colors ${
                    g.id === garment.id
                      ? "border-fg ring-1 ring-fg"
                      : "border-hairline hover:border-fg"
                  }`}
                >
                  <span className="block text-[0.8125rem] leading-snug">{g.name}</span>
                  <span className="block mt-0.5 text-[0.6875rem] text-mid">
                    {g.brand} · {g.type}
                    {g.weight ? ` · ${g.weight}` : ""} · {g.colors.length} colors
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <h2 className={LABEL}>Studio marks</h2>
            <p className="mt-1 text-[0.75rem] text-mid">
              Tap a mark, then tap the garment. Marks preview in{" "}
              <span className="whitespace-nowrap">
                Madeira {threadCode} {threadByCode.get(threadCode)?.name}
              </span>
              .
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5 items-center">
              {MARK_THREADS.map((t) => (
                <button
                  key={t.code}
                  type="button"
                  title={`${t.code} ${t.name}`}
                  onClick={() => setThreadCode(t.code)}
                  className={`w-5 h-5 rounded-full border cursor-pointer ${
                    threadCode === t.code
                      ? "border-fg ring-1 ring-fg ring-offset-1 ring-offset-bg"
                      : "border-hairline"
                  }`}
                  style={{ backgroundColor: t.hex ?? "#999" }}
                />
              ))}
              <span className="flex gap-1.5 ml-2">
                {SIZES.map((sz) => (
                  <button
                    key={sz.inches}
                    type="button"
                    title={sz.label}
                    onClick={() => setInches(sz.inches)}
                    className={`border px-2 py-0.5 text-[0.75rem] cursor-pointer ${
                      inches === sz.inches
                        ? "border-fg bg-fg text-bg"
                        : "border-hairline text-mid hover:border-fg"
                    }`}
                  >
                    {sz.inches}&Prime;
                  </button>
                ))}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-4 sm:grid-cols-5 gap-2">
              {SHAPES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  title={s.name}
                  aria-pressed={armedShape === s.id}
                  onClick={() => setArmedShape(armedShape === s.id ? null : s.id)}
                  className={`aspect-square border p-1.5 cursor-pointer bg-card transition-colors ${
                    armedShape === s.id
                      ? "border-fg ring-[1.5px] ring-fg ring-offset-2 ring-offset-bg"
                      : "border-hairline hover:border-fg"
                  }`}
                >
                  <ShapeSvg shape={s} color={threadHex(threadCode)} />
                </button>
              ))}
            </div>
          </div>

          {/* picks + inquiry */}
          <div className="border-t border-hairline pt-5">
            <h2 className={LABEL}>Your picks</h2>
            {placements.length === 0 ? (
              <p className="mt-2 text-[0.8125rem] text-mid">
                Nothing placed yet — pick a mark and tap the garment.
              </p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1.5 text-[0.8125rem]">
                {placements.map((p) => {
                  const s = shapeById.get(p.shapeId);
                  const t = threadByCode.get(p.threadCode);
                  return (
                    <li key={p.id} className="flex items-center gap-2">
                      <span
                        className="inline-block w-3 h-3 rounded-full border border-hairline"
                        style={{ backgroundColor: t?.hex ?? "#999" }}
                      />
                      <span>
                        {s?.name} · {p.inches}&Prime;
                        {p.flip ? " · flipped" : ""}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${s?.name}`}
                        onClick={() => remove(p.id)}
                        className="ml-auto text-mid hover:text-fg cursor-pointer"
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {estimate ? (
              <p className="mt-3 text-[0.8125rem] text-mid">
                Ballpark for {qty} piece{qty === 1 ? "" : "s"}:{" "}
                {estimate.totalRange[0] === estimate.totalRange[1]
                  ? `from $${estimate.totalRange[0]}`
                  : `$${estimate.totalRange[0]}–$${estimate.totalRange[1]}`}
                . Final quote depends on garment, stitch count, and artwork
                prep.
              </p>
            ) : null}

            {submitted ? (
              <p className="mt-5 text-[0.9375rem] leading-[1.65]">
                Thanks — Bayside received your design and will follow up with
                next steps and a clearer quote.
              </p>
            ) : (
              <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Name"
                    aria-label="Name"
                    className={FIELD}
                  />
                  <input
                    required
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Email"
                    aria-label="Email"
                    className={FIELD}
                  />
                </div>
                <div className="grid grid-cols-[7rem_1fr] gap-3">
                  <input
                    type="number"
                    min={1}
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    aria-label="Quantity"
                    className={FIELD}
                  />
                  <input
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Notes — sizes, timeline, anything else"
                    aria-label="Notes"
                    className={FIELD}
                  />
                </div>
                {error ? (
                  <p className="text-[0.8125rem] text-red-700">{error}</p>
                ) : null}
                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex items-center justify-center px-7 py-3 bg-fg text-bg text-[0.8125rem] tracking-[0.08em] uppercase transition-opacity duration-150 hover:opacity-85 disabled:opacity-50 cursor-pointer"
                >
                  {submitting ? "Sending…" : "Send my design"}
                </button>
              </form>
            )}
          </div>
        </section>
      </main>

      <footer className="border-t border-hairline">
        <div className="max-w-site mx-auto px-pad py-8 flex flex-wrap items-center justify-between gap-3 text-[0.8125rem] text-mid">
          <span>Bayside — custom embroidery &amp; small-batch merch, SF.</span>
          <a href="/" className="underline underline-offset-2 hover:text-fg">
            Work with Bayside
          </a>
        </div>
      </footer>
    </div>
  );
}
