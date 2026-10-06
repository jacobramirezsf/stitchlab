// Stitchlab: searchable individual tools, with direct #<slug> routes.
// Existing project and library routes remain available for saved work.

import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { TOOLS, ToolIntro, ANIMATION_SLUGS, type ToolDef } from "./tools";
import { useCanvas, type CanvasDraw } from "./tools/shared";
import { toolPreview } from "./toolPreviews";
import { getSession, clearSession, getRole } from "./account";
import { SECTIONS } from "./sections";
import { syncLibrary, AUTH_EVENT } from "./lib/sync";
import { syncProjectsDown } from "./lib/projects";
import "./interface.css";

const OrbitalHome = lazy(() => import("./OrbitalHome"));
const EditorPage = lazy(() => import("./editor/EditorPage"));
const AccountModal = lazy(() => import("./AccountModal"));
const ProfileModal = lazy(() => import("./ProfileModal"));

const BY_SLUG: Record<string, ToolDef> = Object.fromEntries(TOOLS.map((t) => [t.slug, t]));

function readHash(): string {
  return window.location.hash.replace(/^#\/?/, "").trim();
}

function Header({
  onHome,
  onWorkspace,
  onLibrary,
  onAllTools,
  active,
  staff,
  email,
  onSignIn,
  onMakeAccount,
  onProfile,
}: {
  onHome: () => void;
  onWorkspace: () => void;
  onLibrary: () => void;
  onAllTools: () => void;
  active: "home" | "workspace" | "library" | "overview" | "tool";
  staff: boolean;
  email: string | null;
  onSignIn: () => void;
  onMakeAccount: () => void;
  onProfile: () => void;
}) {
  return (
    <header className="sl-header border-b border-hairline">
      {/* One row, always - on phones the nav labels compress instead of the
          header wrapping to two lines and eating the small screen. */}
      <div className="mx-auto max-w-[1100px] px-3 sm:px-pad py-2.5 sm:py-3 flex flex-nowrap items-center justify-between gap-x-2 sm:gap-x-3">
        <div className="flex items-center gap-2 sm:gap-4 min-w-0">
          <button onClick={onHome} className="text-left shrink-0">
            <span className="font-serif text-[1.125rem] sm:text-[1.375rem] leading-none text-fg">Stitchlab</span>
            <span className="ml-2 text-[0.875rem] text-mid hidden sm:inline">by Bayside</span>
          </button>
          <nav className="flex items-center gap-0.5 sm:gap-1 min-w-0 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
            <button
              onClick={onHome}
              className={`px-2 sm:px-2.5 py-1 text-[0.75rem] sm:text-[0.8125rem] whitespace-nowrap ${active === "home" ? "bg-fg text-bg" : "text-mid hover:text-fg"}`}
            >
              Tools
            </button>
            {staff && (
              <button
                onClick={onWorkspace}
                className={`px-2 sm:px-2.5 py-1 text-[0.75rem] sm:text-[0.8125rem] whitespace-nowrap ${active === "workspace" ? "bg-fg text-bg" : "text-mid hover:text-fg"}`}
              >
                <span className="sm:hidden">Studio</span>
                <span className="hidden sm:inline">Workspace</span>
              </button>
            )}
            <button
              onClick={onLibrary}
              className={`px-2 sm:px-2.5 py-1 text-[0.75rem] sm:text-[0.8125rem] whitespace-nowrap ${active === "library" ? "bg-fg text-bg" : "text-mid hover:text-fg"}`}
            >
              <span className="sm:hidden">Library</span>
              <span className="hidden sm:inline">My library</span>
            </button>
            {staff && (
              <button
                onClick={onAllTools}
                className={`px-2 sm:px-2.5 py-1 text-[0.75rem] sm:text-[0.8125rem] whitespace-nowrap ${active === "overview" ? "bg-fg text-bg" : "text-mid hover:text-fg"}`}
              >
                All tools
              </button>
            )}
          </nav>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {email ? (
            <button
              onClick={onProfile}
              title={`${email} - profile & account`}
              className="flex items-center gap-2 border border-hairline px-1.5 sm:px-2 py-1 hover:border-fg"
            >
              <span className="w-6 h-6 rounded-full bg-fg text-bg text-[0.75rem] flex items-center justify-center uppercase">{email[0]}</span>
              <span className="text-[0.8125rem] text-fg max-w-[16ch] truncate hidden sm:inline">{email}</span>
            </button>
          ) : (
            <>
              <button onClick={onSignIn} className="text-[0.75rem] sm:text-[0.8125rem] text-mid hover:text-fg whitespace-nowrap">Sign in</button>
              <button onClick={onMakeAccount} className="border border-fg bg-fg text-bg px-2 sm:px-2.5 py-1.5 text-[0.75rem] sm:text-[0.8125rem] hover:opacity-85 whitespace-nowrap">
                <span className="sm:hidden">Sign up</span>
                <span className="hidden sm:inline">Make an account</span>
              </button>
            </>
          )}
          <a href="/" className="text-[0.8125rem] text-mid hover:text-fg hidden md:inline">Bayside home</a>
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-hairline mt-16">
      <div className="mx-auto max-w-[1100px] px-pad py-6 text-[0.6875rem] text-mid leading-relaxed">
        Free, open-source embroidery tools that run entirely in your browser. Your photos and files never leave your
        computer. Format work is ported from pyembroidery (MIT) and cross-checked against libembroidery (zlib); render
        recipes learned from stitchjs (MIT). Made at Bayside in San Francisco.
      </div>
    </footer>
  );
}

function PreviewThumb({ slug }: { slug: string }) {
  const draw = useMemo<CanvasDraw>(
    () => (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      const paths = toolPreview(slug);
      const pad = 12;
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      for (const p of paths) for (const q of p) { if (q.x < mnx) mnx = q.x; if (q.x > mxx) mxx = q.x; if (q.y < mny) mny = q.y; if (q.y > mxy) mxy = q.y; }
      if (!isFinite(mnx)) return;
      const bw = Math.max(1, mxx - mnx), bh = Math.max(1, mxy - mny);
      const s = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh);
      const ox = (w - bw * s) / 2 - mnx * s, oy = (h - bh * s) / 2 - mny * s;
      ctx.strokeStyle = "#26324d";
      ctx.lineWidth = 1;
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
  return <canvas ref={useCanvas(draw)} className="w-full h-[126px]" style={{ background: "#f7f5f1" }} />;
}

function ToolCard({ t, onOpen }: { t: ToolDef; onOpen: (slug: string) => void }) {
  return (
    <button onClick={() => onOpen(t.slug)} className="text-left border border-hairline bg-card hover:border-fg transition-colors group flex flex-col overflow-hidden">
      <PreviewThumb slug={t.slug} />
      <div className="px-3 py-2.5 border-t border-hairline">
        <div className="font-serif text-[1.0625rem] text-fg group-hover:underline leading-tight">{t.name}</div>
        <div className="mt-0.5 text-[0.75rem] text-mid leading-snug line-clamp-2">{t.tagline}</div>
      </div>
    </button>
  );
}

function Landing({ onOpen }: { onOpen: (slug: string) => void }) {
  const [cat, setCat] = useState("All");
  const publicSections = SECTIONS.filter((s) => !s.staffOnly);
  const cats = ["All", ...publicSections.map((s) => s.title)];
  const activeSection = publicSections.find((s) => s.title === cat);
  const slugs = cat === "All" ? publicSections.flatMap((s) => s.slugs) : activeSection?.slugs ?? [];
  const tools = slugs.map((s) => BY_SLUG[s]).filter(Boolean);

  return (
    <>
      <section className="mx-auto max-w-[1100px] px-pad pt-9 pb-5">
        <div className="max-w-[64ch]">
          <div className="text-[0.6875rem] tracking-[0.18em] uppercase text-mid">Bayside Stitch Lab</div>
          <h1 className="mt-1.5 font-serif text-[2.25rem] leading-[1.1] text-fg">Turn ideas into real embroidery files</h1>
          <p className="mt-3 text-[1rem] text-mid leading-relaxed">
            Free tools that turn photos, text, patterns, and math into machine-embroidery files you can download and
            stitch. Everything runs in your browser, so your images stay on your computer, and almost every tool ends in
            a real .DST or .PES file (QR Studio and the animation tools export images instead).
          </p>
          <p className="mt-4 border-l-2 border-hairline pl-3 text-[0.8125rem] text-mid leading-relaxed">
            These tools are still in development, so a stitch-out may not come out the way the preview looks. Your tests
            and feedback help me keep refining them. If you stitch one, I'd love to see how it turned out. Send photos or
            notes to <span className="text-fg font-medium select-all">baysidedesignlab@gmail.com</span>.
          </p>
        </div>
      </section>

      <div className="sticky top-0 z-10 bg-bg/95 backdrop-blur border-b border-hairline">
        <div className="mx-auto max-w-[1100px] px-pad py-2.5 flex gap-2 overflow-x-auto">
          {cats.map((c) => (
            <button key={c} onClick={() => setCat(c)}
              className={`shrink-0 px-3 py-1.5 text-[0.8125rem] border whitespace-nowrap ${cat === c ? "border-fg bg-fg text-bg" : "border-hairline text-mid hover:text-fg hover:border-mid"}`}>
              {c}
            </button>
          ))}
        </div>
      </div>

      <section className="mx-auto max-w-[1100px] px-pad pt-4 pb-2">
        {cat !== "All" && activeSection && <p className="text-[0.875rem] text-mid mb-3">{activeSection.blurb}</p>}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {tools.map((t) => <ToolCard key={t.slug} t={t} onOpen={onOpen} />)}
        </div>
      </section>
    </>
  );
}

/** A single tool in its own canvas: slim bar (back · name · tagline · About)
 *  over the tool's editor frame. No page scroll on desktop. */
function SoloToolView({ tool }: { tool: ToolDef }) {
  const Tool = tool.component;
  const [aboutOpen, setAboutOpen] = useState(false);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="sl-tool-heading relative shrink-0 border-b border-hairline bg-card">
        <div className="mx-auto max-w-[1440px] px-pad py-1.5 flex items-baseline gap-x-3 min-w-0">
          <button onClick={() => { window.location.hash = ""; }} className="text-[0.75rem] text-accent hover:underline shrink-0">← All tools</button>
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
        {/* Mobile: full-bleed so the tool's app shell owns the exact viewport
            (no padding to throw its height math off). Desktop keeps the frame. */}
        <div className="sl-tool-body mx-auto max-w-[1600px] p-0 lg:px-5 lg:py-3">
          <Suspense fallback={<div className="text-[0.8125rem] text-mid py-16 text-center">Loading the tool…</div>}>
            <Tool />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

/** The library keeps a classic scrolling page. */
function LibraryView({ tool }: { tool: ToolDef }) {
  const Tool = tool.component;
  return (
    <div className="mx-auto max-w-[1100px] px-pad py-5 w-full">
      <h1 className="font-serif text-[1.5rem] leading-tight text-fg mb-1">{tool.name}</h1>
      <p className="text-[0.875rem] text-mid mb-4">{tool.tagline}</p>
      <Suspense fallback={<div className="text-[0.8125rem] text-mid py-16 text-center">Opening the library…</div>}>
        <Tool />
      </Suspense>
    </div>
  );
}

export default function StitchLabHome() {
  const [hash, setHash] = useState<string>(() => readHash());
  const [email, setEmail] = useState<string | null>(() => getSession()?.email ?? null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authView, setAuthView] = useState<"signin" | "signup" | "reset">("signin");
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    const onHash = () => setHash(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // animation tools moved to their own page - old links keep working
  useEffect(() => {
    if (hash && ANIMATION_SLUGS.includes(hash)) {
      window.location.replace(`/animation#${hash}`);
    }
  }, [hash]);
  useEffect(() => { window.scrollTo(0, 0); }, [hash]);
  // Meaningful tab titles: tool pages, library, and the home each name
  // themselves (bookmarks and shared #links stop all looking like the
  // homepage).
  useEffect(() => {
    const t = hash && BY_SLUG[hash] ? BY_SLUG[hash].name
      : hash === "new" || hash.startsWith("p/") ? "Project"
      : null;
    document.title = t ? `${t} - Bayside Stitch Lab` : "Bayside Stitch Lab";
  }, [hash]);

  // Tools can ask for the account modal (e.g. the "make a free account" save
  // nudge) without knowing about this component.
  useEffect(() => {
    const onAuth = () => { setAuthView("signup"); setAuthOpen(true); };
    window.addEventListener(AUTH_EVENT, onAuth);
    return () => window.removeEventListener(AUTH_EVENT, onAuth);
  }, []);

  // Signed in: merge cloud designs into this browser and mirror back. Runs on
  // load and again after every sign-in, so work is never stranded either side.
  useEffect(() => {
    if (email) { void syncLibrary(); void syncProjectsDown().catch(() => {}); }
  }, [email]);

  const open = (s: string) => { window.location.hash = s; setHash(s); };
  const home = () => { window.location.hash = ""; setHash(""); };
  const signOut = () => { clearSession(); setEmail(null); };
  const openAuth = (view: "signin" | "signup" | "reset") => { setAuthView(view); setAuthOpen(true); };

  // Routing: visitors land in the Workspace. #<slug> opens that tool in its
  // own canvas; #tools is the staff-only overview grid; anything unknown
  // falls back to the Workspace.
  const staff = ["staff", "admin"].includes(getRole());
  const workspace = BY_SLUG.workspace;
  const overview = hash === "tools" && staff;
  const toolRaw = overview ? undefined : hash && hash !== "tools" ? BY_SLUG[hash] : undefined;
  // Staff-bench tools are invisible to the public - even by direct link.
  const tool = toolRaw?.staffOnly && !staff ? undefined : toolRaw;
  // Landing is the orbital home (every tool circling the live canvas);
  // #workspace opens the studio; unknown hashes fall back to home.
  const editorProjectId = hash === "new" ? "new" : hash.startsWith("p/") ? hash.slice(2) : null;
  const view: "home" | "overview" | "workspace" | "library" | "tool" | "editor" =
    editorProjectId ? "editor"
    : overview ? "overview"
    : !hash ? "home"
    : !tool ? "home"
    : tool.slug === "workspace" ? "workspace"
    : tool.slug === "librarypage" ? "library"
    : "tool";
  // The grid home is a normal scrolling page (with footer); editors stay fullscreen.
  const fullscreen = view === "workspace" || view === "tool" || view === "editor";

  return (
    <div className={`stitchlab-ui bg-bg text-fg font-sans ${fullscreen ? "h-dvh flex flex-col overflow-hidden" : "min-h-screen"}`}>
      <div className="shrink-0">
        <Header
          onHome={home}
          onWorkspace={() => open("workspace")}
          onLibrary={() => open("librarypage")}
          onAllTools={() => open("tools")}
          active={view === "editor" ? "library" : view}
          staff={staff}
          email={email}
          onSignIn={() => openAuth("signin")}
          onMakeAccount={() => openAuth("signup")}
          onProfile={() => setProfileOpen(true)}
        />
      </div>
      {view === "home" ? (
        <Suspense fallback={<div className="text-[0.8125rem] text-mid py-16 text-center">Loading the Lab…</div>}>
          <OrbitalHome onOpen={open} />
        </Suspense>
      ) : view === "workspace" ? (
        <div className="flex-1 min-h-0">
          <Suspense fallback={<div className="text-[0.8125rem] text-mid py-16 text-center">Loading the Workspace…</div>}>
            <workspace.component />
          </Suspense>
        </div>
      ) : view === "editor" && editorProjectId ? (
        <div className="flex-1 min-h-0">
          <Suspense fallback={<div className="text-[0.8125rem] text-mid py-16 text-center">Opening the project…</div>}>
            <EditorPage projectId={editorProjectId} onExit={() => { window.location.hash = "librarypage"; }} />
          </Suspense>
        </div>
      ) : view === "tool" && tool && tool.fullscreen ? (
        <div className="flex-1 min-h-0">
          <Suspense fallback={<div className="text-[0.8125rem] text-mid py-16 text-center">Loading the tool…</div>}>
            <tool.component />
          </Suspense>
        </div>
      ) : view === "tool" && tool ? (
        <SoloToolView tool={tool} />
      ) : view === "library" && tool ? (
        <LibraryView tool={tool} />
      ) : (
        <Landing onOpen={open} />
      )}
      {!fullscreen && <Footer />}
      {authOpen && (
        <Suspense fallback={null}>
          <AccountModal
            initialView={authView}
            onClose={() => setAuthOpen(false)}
            onSignedIn={(mail) => setEmail(mail)}
          />
        </Suspense>
      )}
      {profileOpen && email && (
        <Suspense fallback={null}>
          <ProfileModal
            onClose={() => setProfileOpen(false)}
            onSignOut={signOut}
            onChangePassword={() => { setProfileOpen(false); openAuth("reset"); }}
          />
        </Suspense>
      )}
    </div>
  );
}
