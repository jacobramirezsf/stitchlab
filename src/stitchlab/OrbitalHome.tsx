import { useEffect, useRef, useState } from "react";
import { TOOLS } from "./tools";
import { toolPreview } from "./toolPreviews";
import { SECTIONS } from "./sections";

const featured = ["sashikotone", "lettering", "blackwork", "portrait"];
const INK = "#26324d";
function ToolArt({ slug, ink }: { slug: string; ink: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const paths = toolPreview(slug);
    const points = paths.flat();
    if (!points.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const scale = Math.min(260 / Math.max(1, x1 - x0), 160 / Math.max(1, y1 - y0));
    ctx.clearRect(0, 0, 600, 400);
    ctx.save(); ctx.scale(2, 2); ctx.translate(150 - (x0 + x1) * scale / 2, 100 - (y0 + y1) * scale / 2);
    ctx.strokeStyle = ink; ctx.lineWidth = 0.7; ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const path of paths) { ctx.beginPath(); path.forEach((p, i) => i ? ctx.lineTo(p.x * scale, p.y * scale) : ctx.moveTo(p.x * scale, p.y * scale)); ctx.stroke(); }
    ctx.restore();
  }, [slug, ink]);
  return <canvas ref={ref} width={600} height={400} aria-hidden="true" />;
}
const categories = SECTIONS.filter((s) => !s.staffOnly);
const galleryTools = categories.flatMap((s) => s.slugs.map((slug) => ({ tool: TOOLS.find((t) => t.slug === slug), category: s.title }))).filter((x) => x.tool && !x.tool.staffOnly);
function remembered(key: string, fallback: string) { try { return sessionStorage.getItem(key) ?? fallback; } catch { return fallback; } }
export default function ToolGallery({ onOpen }: { onOpen: (slug: string) => void }) {
  const [query, setQuery] = useState(() => remembered("stitchlab-tool-search", ""));
  const [category, setCategory] = useState(() => remembered("stitchlab-tool-category", "All tools"));
  useEffect(() => { try { sessionStorage.setItem("stitchlab-tool-search", query); sessionStorage.setItem("stitchlab-tool-category", category); } catch { /* Storage is optional. */ } }, [query, category]);
  const filtered = galleryTools.filter(({ tool, category: group }) => (category === "All tools" || category === group) && `${tool!.name} ${tool!.tagline} ${tool!.blurb} ${group}`.toLowerCase().includes(query.toLowerCase().trim()));
  const visible = [...filtered].sort((a, b) => (featured.includes(b.tool!.slug) ? 1 : 0) - (featured.includes(a.tool!.slug) ? 1 : 0));
  return <main className="sl-gallery">
    <section className="sl-hero sl-hero-compact">
      <div className="sl-hero-note"><span>01 &nbsp; Choose a tool</span><span>02 &nbsp; Refine your design</span><span>03 &nbsp; Download & stitch</span><p>Free to use. No account needed to create.<br />Embroidery tools export DST, PES & JEF.</p></div>
    </section>
    <section aria-label="Find a tool" className="sl-discovery">
      <label className="sl-search"><span>Search tools</span><input type="search" placeholder="Try a photo, lettering, or texture…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      <div className="sl-filters" aria-label="Tool categories">{["All tools", ...categories.map((s) => s.title)].map((c) => <button key={c} aria-pressed={category === c} onClick={() => setCategory(c)}>{c}</button>)}</div>
    </section>
    <div className="sl-results"><h1>{query ? `Results for “${query}”` : category === "All tools" ? "Find your starting point" : category}</h1><span role="status">{visible.length} tools</span></div>
    {visible.length ? <div className="sl-tool-grid">{visible.map(({ tool: t, category: group }) => t && <button key={t.slug} className="sl-tool-card" onClick={() => onOpen(t.slug)}>
      <div className="sl-tool-art"><ToolArt slug={t.slug} ink={INK} />{t.slug === "sashikotone" && <span className="sl-new">NEW</span>}</div>
      <div className="sl-card-copy"><span className="sl-category">{group}</span><h3>{t.name}<span aria-hidden="true">↗</span></h3><p>{t.tagline}</p><span className="sl-card-action">Open tool →</span></div>
    </button>)}</div> : <div className="sl-empty"><h3>No tools match this search</h3><p>Try a broader word or choose another category.</p><button onClick={() => { setQuery(""); setCategory("All tools"); }}>Show all tools</button></div>}
    <p className="sl-gallery-foot">Previews illustrate each method. Open a tool to generate your design and check its actual stitch dimensions. QR Studio exports images.</p>
  </main>;
}
