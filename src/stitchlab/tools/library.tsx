// Stitch Lab: the Library. Two clearly separated shelves:
//   1. PROJECTS - editable compositions (autosaved, reopenable, versioned).
//   2. EXPORTED DESIGNS - finished stitch files with their exact DST bytes.
// A project keeps its generators editable; a design is a frozen artifact.

import { useEffect, useMemo, useState } from "react";
import { saveBlob } from "../lib/native";
import { deleteDesign, listDesigns, type SavedDesign } from "../lib/library";
import { pushLibrary, LIBRARY_EVENT, AUTH_EVENT } from "../lib/sync";
import {
  PROJECTS_EVENT,
  collectionsOf,
  duplicateProject,
  hardDeleteProject,
  listProjects,
  organizeProjects,
  putProjectLocal,
  restoreProject,
  softDeleteProject,
  type ProjectSort,
} from "../lib/projects";
import type { Project } from "../lib/project";
import { getSession } from "../account";
import { EYEBROW, fmtSize, useUnits } from "./shared";

// navigation helper kept outside components (mutating window.location inside a
// render scope trips the compiler-era lint rules)
const goToHash = (h: string) => { window.location.hash = h; };

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ── projects shelf ─────────────────────────────────────────────────────────

function ProjectsShelf() {
  const [all, setAll] = useState<Project[] | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ProjectSort>("recent");
  const [collection, setCollection] = useState<string | null>(null);
  const [favsOnly, setFavsOnly] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);

  const refresh = () => { void listProjects().then(setAll).catch(() => setAll([])); };
  useEffect(() => {
    refresh();
    window.addEventListener(PROJECTS_EVENT, refresh);
    return () => window.removeEventListener(PROJECTS_EVENT, refresh);
  }, []);

  const shown = useMemo(
    () => organizeProjects(all ?? [], { query, sort, collection, favoritesOnly: favsOnly, deleted: showDeleted }),
    [all, query, sort, collection, favsOnly, showDeleted],
  );
  const collections = useMemo(() => collectionsOf(all ?? []), [all]);
  const deletedCount = useMemo(() => (all ?? []).filter((p) => p.deletedAt).length, [all]);

  const open = (p: Project) => goToHash(`p/${p.id}`);
  const rename = async (p: Project, name: string) => {
    const next = { ...p, name: name.trim() || p.name, updatedAt: Date.now(), rev: p.rev + 1 };
    await putProjectLocal(next);
    setRenaming(null);
  };
  const setFav = async (p: Project) => {
    await putProjectLocal({ ...p, favorite: !p.favorite, updatedAt: Date.now(), rev: p.rev + 1 });
  };
  const setCol = async (p: Project) => {
    const name = window.prompt("Collection name (empty to remove):", p.collection ?? "");
    if (name === null) return;
    const next = { ...p, updatedAt: Date.now(), rev: p.rev + 1 } as Project;
    if (name.trim()) next.collection = name.trim();
    else delete next.collection;
    await putProjectLocal(next);
  };

  if (all !== null && all.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-serif text-[1.25rem] text-fg">Existing projects</h2>
        <span className="text-[0.75rem] text-mid">editable - open any time and keep working</span>

      </div>

      {(all?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects"
            aria-label="Search projects"
            className="border border-hairline bg-bg px-2.5 py-1.5 text-[0.8125rem] text-fg w-44"
          />
          <select value={sort} onChange={(e) => setSort(e.target.value as ProjectSort)} aria-label="Sort projects"
            className="border border-hairline bg-bg px-2 py-1.5 text-[0.8125rem] text-fg">
            <option value="recent">Recently edited</option>
            <option value="created">Newest first</option>
            <option value="name">Name</option>
          </select>
          {collections.length > 0 && (
            <select value={collection ?? ""} onChange={(e) => setCollection(e.target.value || null)} aria-label="Filter by collection"
              className="border border-hairline bg-bg px-2 py-1.5 text-[0.8125rem] text-fg">
              <option value="">All collections</option>
              {collections.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          <button onClick={() => setFavsOnly((v) => !v)} aria-pressed={favsOnly}
            className={`border px-2.5 py-1.5 text-[0.8125rem] ${favsOnly ? "border-fg bg-fg text-bg" : "border-hairline text-mid hover:border-fg"}`}>
            ★ Favorites
          </button>
          {deletedCount > 0 && (
            <button onClick={() => setShowDeleted((v) => !v)} aria-pressed={showDeleted}
              className={`border px-2.5 py-1.5 text-[0.8125rem] ${showDeleted ? "border-fg bg-fg text-bg" : "border-hairline text-mid hover:border-fg"}`}>
              Recently deleted ({deletedCount})
            </button>
          )}
        </div>
      )}

      {all === null ? (
        <p className="text-[0.8125rem] text-mid">Opening projects…</p>
      ) : shown.length === 0 ? (
        <div className="border border-dashed border-mid/60 bg-card px-6 py-10 text-center">
          <p className="text-[0.9375rem] text-fg">{showDeleted ? "Nothing recently deleted." : "No projects yet."}</p>
          {!showDeleted && (
            <p className="mt-1 text-[0.8125rem] text-mid">
              A project combines patterns, lettering, and photos into one design you can keep editing.
            </p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {shown.map((p) => (
            <div key={p.id} className="border border-hairline bg-card p-2.5 space-y-1.5">
              <button onClick={() => !showDeleted && open(p)} className="block w-full" aria-label={`Open ${p.name}`}>
                {p.thumbPng ? (
                  <img src={p.thumbPng} alt="" className="w-full aspect-square object-cover border border-hairline bg-bg" />
                ) : (
                  <div className="w-full aspect-square border border-hairline bg-bg flex items-center justify-center text-[0.6875rem] text-mid">
                    {p.elements.length ? `${p.elements.length} element${p.elements.length === 1 ? "" : "s"}` : "empty"}
                  </div>
                )}
              </button>
              {renaming === p.id ? (
                <input
                  autoFocus
                  defaultValue={p.name}
                  onBlur={(e) => void rename(p, e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(null); }}
                  className="w-full border border-fg bg-bg px-1.5 py-0.5 text-[0.8125rem] text-fg"
                />
              ) : (
                <button onClick={() => setRenaming(p.id)} title="Rename" className="block w-full text-left">
                  <span className="block text-[0.8125rem] text-fg truncate">{p.favorite ? "★ " : ""}{p.name}</span>
                </button>
              )}
              <span className="block text-[0.6875rem] text-mid truncate">
                {p.collection ? `${p.collection} · ` : ""}edited {fmtDate(p.updatedAt)}
              </span>
              <div className="flex gap-1 text-[0.6875rem]">
                {showDeleted ? (
                  <>
                    <button onClick={() => void restoreProject(p.id)} className="flex-1 border border-fg px-2 py-1 text-fg hover:bg-fg hover:text-bg">Restore</button>
                    <button
                      onClick={() => { if (window.confirm("Delete permanently? This can't be undone.")) void hardDeleteProject(p.id); }}
                      className="border border-hairline px-2 py-1 text-mid hover:text-fg"
                    >
                      Erase
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={() => open(p)} className="flex-1 border border-fg px-2 py-1 text-fg hover:bg-fg hover:text-bg">Open</button>
                    <button onClick={() => void setFav(p)} title={p.favorite ? "Unfavorite" : "Favorite"} aria-label={p.favorite ? "Unfavorite" : "Favorite"}
                      className={`border px-2 py-1 ${p.favorite ? "border-fg text-fg" : "border-hairline text-mid hover:text-fg"}`}>★</button>
                    <button onClick={() => void setCol(p)} title="Collection" aria-label="Set collection" className="border border-hairline px-2 py-1 text-mid hover:text-fg">▣</button>
                    <button onClick={() => void duplicateProject(p.id)} title="Duplicate" aria-label="Duplicate" className="border border-hairline px-2 py-1 text-mid hover:text-fg">⧉</button>
                    <button onClick={() => void softDeleteProject(p.id)} title="Delete" aria-label="Delete" className="border border-hairline px-2 py-1 text-mid hover:text-fg">✕</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {showDeleted && shown.length > 0 && (
        <p className="text-[0.6875rem] text-mid">Deleted projects are kept for 30 days, then stop syncing.</p>
      )}
    </section>
  );
}

// ── exported designs shelf (the original library) ─────────────────────────

function DesignsShelf() {
  const units = useUnits();
  const [items, setItems] = useState<SavedDesign[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    listDesigns()
      .then(setItems)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not open the library."));
  };
  useEffect(() => {
    refresh();
    window.addEventListener(LIBRARY_EVENT, refresh);
    return () => window.removeEventListener(LIBRARY_EVENT, refresh);
  }, []);

  const download = (d: SavedDesign) => {
    void saveBlob(new Blob([new Uint8Array(d.bytes)], { type: "application/octet-stream" }), `${d.name}.dst`);
  };
  const remove = async (d: SavedDesign) => {
    await deleteDesign(d.id);
    refresh();
    void pushLibrary().catch(() => {});
  };

  if (error) return <p className="text-[0.8125rem] text-red-700">{error}</p>;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="font-serif text-[1.25rem] text-fg">Exported designs</h2>
        <span className="text-[0.75rem] text-mid">
          finished stitch files - exact DST bytes, not editable
        </span>
      </div>
      {items === null ? (
        <p className="text-[0.8125rem] text-mid">Opening…</p>
      ) : items.length === 0 ? (
        <div className="border border-dashed border-mid/60 bg-card px-6 py-10 text-center">
          <p className="text-[0.9375rem] text-fg">Nothing saved yet.</p>
          <p className="mt-1 text-[0.8125rem] text-mid">
            Every tool's ☆ Save button lands here with the exact DST bytes, ready to re-download.
          </p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {items.map((d) => (
            <div key={d.id} className="border border-hairline bg-card p-3 space-y-2">
              <img src={d.thumbPng} alt={d.name} className="w-full aspect-square object-cover border border-hairline" />
              <div className={EYEBROW}>/ {d.tool} /</div>
              <div className="text-[0.8125rem] text-fg tabular-nums leading-relaxed">
                {d.stitchCount.toLocaleString()} st · {fmtSize(d.widthMm, d.heightMm, units)}
                <span className="block text-mid">{fmtDate(d.createdAt)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                {d.colors.slice(0, 6).map((c, i) => (
                  <span key={i} className="w-4 h-4 border border-hairline" style={{ background: c }} />
                ))}
              </div>
              <div className="flex gap-2">
                <button onClick={() => download(d)} className="flex-1 border border-fg bg-fg text-bg px-3 py-1.5 text-[0.75rem] hover:opacity-85">
                  Download .dst
                </button>
                <button onClick={() => void remove(d)} className="border border-hairline bg-bg px-3 py-1.5 text-[0.75rem] text-fg hover:bg-card">
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── the page ───────────────────────────────────────────────────────────────

export default function LibraryTool() {
  const session = getSession();
  const banner = session ? (
    <p className="border border-hairline bg-card px-3 py-2 text-[0.75rem] text-mid leading-relaxed">
      Signed in as <span className="text-fg">{session.email}</span> - recent projects and designs sync to your
      account automatically, so they survive this browser and follow you across devices.
    </p>
  ) : (
    <p className="border border-amber-700/40 bg-amber-100/60 px-3 py-2 text-[0.75rem] text-amber-900 leading-relaxed">
      Everything here lives only in this browser - clearing browser data would lose it.{" "}
      <button onClick={() => window.dispatchEvent(new Event(AUTH_EVENT))} className="underline font-medium">
        Make a free account
      </button>{" "}
      and your work backs up automatically.
    </p>
  );

  return (
    <div className="space-y-8">
      {banner}
      <ProjectsShelf />
      <DesignsShelf />
    </div>
  );
}
