// Bayside Animation - the animation tools in their own standalone page at
// /animation. Same registry and rendering contracts as the Stitch Lab, scoped
// to the tools that produce moving output (write-on lettering, stitch-out
// GIFs/videos). Old /stitchlab#<slug> links redirect here.

import { Suspense, useEffect, useMemo, useState } from "react";
import { TOOLS, ToolIntro, ANIMATION_SLUGS, type ToolDef } from "./tools";
import { useCanvas, type CanvasDraw } from "./tools/shared";
import { toolPreview } from "./toolPreviews";
import { getRole } from "./account";

const BY_SLUG: Record<string, ToolDef> = Object.fromEntries(TOOLS.map((t) => [t.slug, t]));

const readHash = () => window.location.hash.replace(/^#\/?/, "").trim();

function PreviewThumb({ slug }: { slug: string }) {
  const draw = useMemo<CanvasDraw>(
    () => (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      const paths = toolPreview(slug);
      const pad = 14;
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      for (const p of paths) for (const q of p) { if (q.x < mnx) mnx = q.x; if (q.x > mxx) mxx = q.x; if (q.y < mny) mny = q.y; if (q.y > mxy) mxy = q.y; }
      if (!isFinite(mnx)) return;
      const bw = Math.max(1, mxx - mnx), bh = Math.max(1, mxy - mny);
      const s = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh);
      const ox = (w - bw * s) / 2 - mnx * s, oy = (h - bh * s) / 2 - mny * s;
      ctx.strokeStyle = "#26324d";
      ctx.lineWidth = 1.2;
      ctx.lineJoin = "round";
      for (const path of paths) {
        if (path.length < 2) continue;
        ctx.beginPath();
        path.forEach((p, i) => (i ? ctx.lineTo(p.x * s + ox, p.y * s + oy) : ctx.moveTo(p.x * s + ox, p.y * s + oy)));
        ctx.stroke();
      }
    },
    [slug],
  );
  return <canvas ref={useCanvas(draw)} className="w-full h-[150px]" style={{ background: "#f7f5f1" }} />;
}

export default function AnimationHome() {
  const [hash, setHash] = useState(readHash());
  useEffect(() => {
    const onHash = () => setHash(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // the old combined Photo Motion tool split into standalone tools
  useEffect(() => {
    if (hash === "photomotion") window.location.replace("/animation#animdots");
  }, [hash]);

  const staff = ["staff", "admin"].includes(getRole());
  const tools = ANIMATION_SLUGS.map((s) => BY_SLUG[s]).filter(
    (t): t is ToolDef => Boolean(t) && (!t.staffOnly || staff)
  );
  const toolRaw = hash ? BY_SLUG[hash] : undefined;
  const tool =
    toolRaw && ANIMATION_SLUGS.includes(toolRaw.slug) && (!toolRaw.staffOnly || staff)
      ? toolRaw
      : undefined;
  const [aboutOpen, setAboutOpen] = useState(false);

  return (
    <div className={`bg-bg text-fg font-sans ${tool ? "h-dvh flex flex-col overflow-hidden" : "min-h-screen"}`}>
      <header className="shrink-0 border-b border-hairline">
        <div className="mx-auto max-w-[1100px] px-pad py-3 flex flex-wrap items-center justify-between gap-2">
          <button
            onClick={() => { window.location.hash = ""; }}
            className="text-left"
          >
            <span className="font-serif text-[1.375rem] leading-none text-fg">Bayside</span>
            <span className="ml-2 text-[0.875rem] text-mid">Animation</span>
          </button>
          <a href="/stitchlab" className="text-[0.8125rem] text-mid hover:text-fg">Stitch Lab →</a>
        </div>
      </header>

      {tool ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="relative shrink-0 border-b border-hairline bg-card">
            <div className="mx-auto max-w-[1440px] px-pad py-1.5 flex items-baseline gap-x-3 min-w-0">
              <button onClick={() => { window.location.hash = ""; }} className="text-[0.75rem] text-accent hover:underline shrink-0">← All animation tools</button>
              <span className="font-serif text-[1.0625rem] text-fg shrink-0">{tool.name}</span>
              <span className="text-[0.75rem] text-mid truncate min-w-0 hidden sm:inline">{tool.tagline}</span>
              <button onClick={() => setAboutOpen((v) => !v)} className="ml-auto text-[0.6875rem] text-mid hover:text-fg shrink-0">
                {aboutOpen ? "Hide info ▴" : "About ▾"}
              </button>
            </div>
            {aboutOpen && (
              <div className="absolute inset-x-0 top-full z-30 border-b border-hairline bg-bg/95 backdrop-blur px-pad py-3">
                <div className="mx-auto max-w-[1440px]"><ToolIntro tool={tool} /></div>
              </div>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className={tool.fullscreen ? "h-full" : "mx-auto max-w-[1440px] px-pad py-3"}>
              <Suspense fallback={<div className="text-[0.8125rem] text-mid py-16 text-center">Loading the tool…</div>}>
                <tool.component />
              </Suspense>
            </div>
          </div>
        </div>
      ) : (
        <>
          <section className="mx-auto max-w-[1100px] px-pad pt-9 pb-5">
            <div className="max-w-[64ch]">
              <div className="text-[0.6875rem] tracking-[0.18em] uppercase text-mid">Bayside Animation</div>
              <h1 className="mt-1.5 font-serif text-[2.25rem] leading-[1.1] text-fg">Make it move</h1>
              <p className="mt-3 text-[1rem] text-mid leading-relaxed">
                Tools that turn lettering and stitch designs into GIFs, videos, and
                high-resolution stills - words that write themselves out, designs that
                sew themselves on screen. Everything runs in your browser.
              </p>
            </div>
          </section>
          <section className="mx-auto max-w-[1100px] px-pad pb-16">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {tools.map((t) => (
                <button
                  key={t.slug}
                  onClick={() => { window.location.hash = t.slug; }}
                  className="text-left border border-hairline bg-card hover:border-fg transition-colors group flex flex-col overflow-hidden"
                >
                  <PreviewThumb slug={t.slug} />
                  <div className="px-3.5 py-3 border-t border-hairline">
                    <div className="font-serif text-[1.125rem] text-fg group-hover:underline leading-tight">{t.name}</div>
                    <div className="mt-1 text-[0.8125rem] text-mid leading-snug">{t.tagline}</div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
