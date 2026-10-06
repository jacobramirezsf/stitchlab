import { useEffect, useMemo, useState } from "react";

// Toolbox: Bayside's own tools + a live view of the studio's are.na tool
// channels. Curate by adding link blocks to the channels - this page just
// reflects them (are.na API is public + CORS-open).

const LABEL =
  "text-[0.6875rem] tracking-[0.14em] uppercase text-dim font-medium";

const CHANNELS: { slug: string; title: string; note?: string }[] = [
  { slug: "useful-exrspoijbiw", title: "useful" },
  { slug: "found-stranger-tools", title: "(Found) (Stranger?) Tools" },
  { slug: "internet-generators", title: "internet generators" },
  { slug: "maker-tools-learning-lab-educ211a", title: "Maker Tools Learning Lab" },
  { slug: "design-s4wsxfgya0i", title: "design!" },
  { slug: "print-queue", title: "print queue", note: "mostly image reference - links only here" },
  {
    slug: "the-browser-is-already-a-game-engine-2026",
    title: "the browser is already a game engine",
    note: "Everest Pipkin's SFPC channel - browser toys, dither tools, vector-era ephemera",
  },
];

type ToolLink = {
  id: number;
  title: string;
  url: string;
  channel: string;
  image?: string; // are.na thumbnail for the block, when it has one
  display?: string; // larger are.na image for the spotlight
  description?: string;
};

// are.na titles/descriptions arrive with HTML entities baked in
const decodeEntities = (s: string) => {
  const t = document.createElement("textarea");
  t.innerHTML = s;
  return t.value;
};

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

// Small link icon: the block's own are.na thumbnail when present, else the
// site favicon. Hides itself if neither loads.
function LinkIcon({ link }: { link: ToolLink }) {
  const [failed, setFailed] = useState(false);
  const src =
    link.image ??
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host(link.url))}&sz=64`;
  if (failed) return <span className="w-8 h-8 shrink-0 border border-hairline bg-bg" />;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="w-8 h-8 shrink-0 object-cover border border-hairline bg-bg"
    />
  );
}

export default function LabToolbox() {
  const [links, setLinks] = useState<ToolLink[] | null>(null);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [spotlight, setSpotlight] = useState<ToolLink | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const all: ToolLink[] = [];
      await Promise.all(
        CHANNELS.map(async (ch) => {
          try {
            for (let page = 1; page <= 3; page++) {
              const res = await fetch(
                `https://api.are.na/v2/channels/${ch.slug}/contents?per=100&page=${page}`
              );
              if (!res.ok) break;
              const data = await res.json();
              const blocks = data.contents ?? [];
              for (const b of blocks) {
                if (b.class === "Link" && b.source?.url) {
                  all.push({
                    id: b.id,
                    title: decodeEntities((b.title || b.source.url).trim()),
                    url: b.source.url,
                    channel: ch.title,
                    image: b.image?.square?.url ?? b.image?.thumb?.url,
                    display: b.image?.display?.url ?? b.image?.large?.url,
                    description:
                      decodeEntities((b.description || "").trim()) || undefined,
                  });
                }
              }
              if (blocks.length < 100) break;
            }
          } catch {
            /* one channel failing shouldn't kill the toolbox */
          }
        })
      );
      if (!live) return;
      if (!all.length) setError(true);
      // de-dupe by URL, newest is fine either way
      const seen = new Set<string>();
      setLinks(
        all.filter((l) => {
          const k = l.url.replace(/\/$/, "");
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
      );
    })();
    return () => {
      live = false;
    };
  }, []);

  const shown = useMemo(
    () =>
      (links ?? []).filter(
        (l) =>
          (!filter || l.channel === filter) &&
          (!query ||
            l.title.toLowerCase().includes(query.toLowerCase()) ||
            l.url.toLowerCase().includes(query.toLowerCase()))
      ),
    [links, filter, query]
  );

  const randomize = () => {
    const pool = shown.length ? shown : (links ?? []);
    if (!pool.length) return;
    // avoid landing on the same tool twice in a row
    let pick = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1 && spotlight && pick.id === spotlight.id) {
      pick = pool[(pool.indexOf(pick) + 1) % pool.length];
    }
    setSpotlight(pick);
  };

  return (
    <main className="max-w-site mx-auto px-pad py-[clamp(1.5rem,4vw,2.5rem)] flex flex-col gap-8">
      <section>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className={LABEL}>From the are.na channels</h2>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools…"
            aria-label="Search tools"
            className="w-[11rem] bg-card border border-hairline px-2.5 py-1.5 text-[0.8125rem] text-fg placeholder:text-dim outline-none focus:border-fg"
          />
          <button
            type="button"
            onClick={randomize}
            disabled={!links?.length}
            title="Spotlight a random tool"
            className="border border-hairline px-2.5 py-1.5 text-[0.75rem] text-mid hover:border-fg disabled:opacity-40 cursor-pointer"
          >
            ⚄ Randomize
          </button>
          <button
            type="button"
            onClick={() => setFilter(null)}
            className={`border px-2.5 py-1 text-[0.75rem] cursor-pointer ${
              filter === null
                ? "border-fg bg-fg text-bg"
                : "border-hairline text-mid hover:border-fg"
            }`}
          >
            All
          </button>
          {CHANNELS.map((c) => (
            <button
              key={c.slug}
              type="button"
              onClick={() => setFilter(filter === c.title ? null : c.title)}
              className={`border px-2.5 py-1 text-[0.75rem] cursor-pointer ${
                filter === c.title
                  ? "border-fg bg-fg text-bg"
                  : "border-hairline text-mid hover:border-fg"
              }`}
            >
              {c.title}
            </button>
          ))}
        </div>

        {spotlight ? (
          <div className="mt-4 border border-fg bg-card p-4 flex flex-col sm:flex-row gap-4">
            {spotlight.display || spotlight.image ? (
              <a href={spotlight.url} target="_blank" rel="noreferrer" className="shrink-0">
                <img
                  src={spotlight.display ?? spotlight.image}
                  alt=""
                  className="w-full sm:w-44 max-h-44 object-cover border border-hairline bg-bg"
                />
              </a>
            ) : null}
            <div className="min-w-0 flex flex-col">
              <span className={LABEL}>Spotlight · {spotlight.channel}</span>
              <a
                href={spotlight.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 font-serif text-[1.125rem] leading-snug hover:underline underline-offset-2"
              >
                {spotlight.title} →
              </a>
              <span className="mt-0.5 text-[0.75rem] text-dim">{host(spotlight.url)}</span>
              {spotlight.description ? (
                <p className="mt-2 text-[0.8125rem] text-mid leading-[1.6] line-clamp-4">
                  {spotlight.description}
                </p>
              ) : (
                <p className="mt-2 text-[0.8125rem] text-dim leading-[1.6]">
                  No notes on the are.na block yet - add a description there and
                  it shows up here.
                </p>
              )}
              <div className="mt-auto pt-3 flex gap-3 text-[0.75rem]">
                <button
                  type="button"
                  onClick={randomize}
                  className="text-mid underline underline-offset-2 hover:text-fg cursor-pointer"
                >
                  Another one
                </button>
                <button
                  type="button"
                  onClick={() => setSpotlight(null)}
                  className="text-mid hover:text-fg cursor-pointer"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {links === null ? (
          <p className="mt-6 text-[0.875rem] text-mid">Loading the channels…</p>
        ) : error && !links.length ? (
          <p className="mt-6 text-[0.875rem] text-mid">
            Couldn&rsquo;t reach are.na just now - try again in a minute.
          </p>
        ) : (
          <>
            <p className="mt-2 text-[0.75rem] text-dim">
              {shown.length} link{shown.length === 1 ? "" : "s"} · add a block to
              a channel on are.na and it shows up here.
            </p>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {shown.map((l) => (
                <a
                  key={l.id}
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="border border-hairline bg-card px-3 py-2.5 hover:border-fg transition-colors flex items-center gap-2.5"
                >
                  <LinkIcon link={l} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[0.875rem] leading-snug line-clamp-2">
                      {l.title}
                    </span>
                    <span className="mt-0.5 flex items-center justify-between gap-2 text-[0.6875rem] text-dim">
                      <span className="truncate">{host(l.url)}</span>
                      <span className="shrink-0">{l.channel}</span>
                    </span>
                  </span>
                </a>
              ))}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
