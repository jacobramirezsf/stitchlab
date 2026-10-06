// Profile & account overview. Opened from the signed-in email in the header:
// identity (name, photo, bio, links), what this Bayside account holds across
// the Stitch Lab and the clothing customizer, and account management.

import { useEffect, useRef, useState } from "react";
import { labApi, getSession } from "./account";
import { listDesigns } from "./lib/library";

type Profile = { name?: string; photo?: string; bio?: string; links?: string[] };

const LABEL = "text-[0.6875rem] tracking-[0.14em] uppercase text-mid";
const FIELD = "mt-1 w-full border border-hairline bg-bg text-fg px-2.5 py-2 text-[0.9375rem]";

/** Downscale + cover-crop a photo to a small square data URL (~10KB). */
async function photoToDataUrl(f: File): Promise<string> {
  const url = URL.createObjectURL(f);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("Could not read that image.")); img.src = url; });
    const S = 160;
    const c = document.createElement("canvas");
    c.width = S; c.height = S;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable.");
    const s = Math.max(S / img.width, S / img.height);
    ctx.drawImage(img, (S - img.width * s) / 2, (S - img.height * s) / 2, img.width * s, img.height * s);
    return c.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function ProfileModal({
  onClose,
  onSignOut,
  onChangePassword,
}: {
  onClose: () => void;
  onSignOut: () => void;
  onChangePassword: () => void;
}) {
  const session = getSession();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [links, setLinks] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [cloudDesigns, setCloudDesigns] = useState(0);
  const [localDesigns, setLocalDesigns] = useState(0);
  const [labIdeas, setLabIdeas] = useState(0);
  const [staff, setStaff] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    void (async () => {
      try {
        const [data, local] = await Promise.all([
          labApi("load", { token: session.token }),
          listDesigns().catch(() => []),
        ]);
        if (!alive) return;
        const p = (data.profile ?? {}) as Profile;
        setName(p.name ?? "");
        setBio(p.bio ?? "");
        setLinks((p.links ?? []).join("\n"));
        setPhoto(p.photo ?? null);
        setCloudDesigns(Array.isArray(data.stitchlab) ? data.stitchlab.length : 0);
        setLabIdeas(Array.isArray(data.ideas) ? data.ideas.length : 0);
        setStaff(Boolean(data.staff));
        setLocalDesigns(local.length);
      } catch (e) {
        if (alive) setLoadError(e instanceof Error ? e.message : "Couldn't load your account.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!session) return null;

  const saveProfile = async () => {
    setSaveState("saving");
    setSaveError(null);
    try {
      const profile: Profile = {
        name: name.trim(),
        bio: bio.trim(),
        links: links.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 5),
        ...(photo ? { photo } : {}),
      };
      await labApi("save", { token: session.token, profile });
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1800);
    } catch (e) {
      setSaveState("idle");
      setSaveError(e instanceof Error ? e.message : "Couldn't save. Try again.");
    }
  };

  const pickPhoto = async (f: File | undefined) => {
    if (!f) return;
    try {
      setPhoto(await photoToDataUrl(f));
    } catch {
      setSaveError("Couldn't read that image - try a JPG or PNG.");
    }
  };

  const initial = (name.trim() || session.email)[0]?.toUpperCase() ?? "?";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-10 bg-fg/40 overflow-y-auto" onClick={onClose}>
      <div className="bg-bg border border-hairline w-full max-w-[460px] shadow-xl my-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-hairline">
          <span className="font-serif text-[1.125rem] text-fg">Your account</span>
          <button onClick={onClose} className="text-mid hover:text-fg text-[0.8125rem]">Close ✕</button>
        </div>

        {loading ? (
          <p className="px-4 py-8 text-center text-[0.8125rem] text-mid">Loading your account…</p>
        ) : loadError ? (
          <p className="px-4 py-8 text-center text-[0.8125rem]" style={{ color: "#c0392b" }}>{loadError}</p>
        ) : (
          <div className="px-4 py-4 space-y-5">
            {/* Identity */}
            <div className="flex items-start gap-3">
              <button
                onClick={() => fileRef.current?.click()}
                title="Change photo"
                className="shrink-0 w-16 h-16 rounded-full border border-hairline overflow-hidden bg-card flex items-center justify-center hover:border-fg"
              >
                {photo ? (
                  <img src={photo} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span className="font-serif text-[1.5rem] text-mid">{initial}</span>
                )}
              </button>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { void pickPhoto(e.target.files?.[0]); e.target.value = ""; }} />
              <div className="min-w-0 flex-1">
                <div className="text-[0.9375rem] text-fg truncate">{session.email}</div>
                <div className="mt-0.5 flex items-center gap-2 text-[0.6875rem] text-mid">
                  {staff && <span className="border border-hairline px-1.5 py-0.5 uppercase tracking-[0.1em]">Staff</span>}
                  <button onClick={() => fileRef.current?.click()} className="text-accent hover:underline">
                    {photo ? "Change photo" : "Add a photo"}
                  </button>
                  {photo && <button onClick={() => setPhoto(null)} className="hover:text-fg">Remove</button>}
                </div>
              </div>
            </div>

            <label className="block">
              <span className={LABEL}>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="How you'd like to be credited" className={FIELD} />
            </label>
            <label className="block">
              <span className={LABEL}>Bio</span>
              <textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={500} rows={2} placeholder="A line about you or your work" className={`${FIELD} resize-y`} />
            </label>
            <label className="block">
              <span className={LABEL}>Links</span>
              <textarea value={links} onChange={(e) => setLinks(e.target.value)} rows={2} placeholder={"One per line - website, Instagram, shop…"} className={`${FIELD} resize-y`} />
            </label>

            {saveError && <p className="text-[0.8125rem]" style={{ color: "#c0392b" }}>{saveError}</p>}
            <button
              onClick={() => void saveProfile()}
              disabled={saveState !== "idle"}
              className="w-full border border-fg bg-fg text-bg px-4 py-2 text-[0.9375rem] disabled:opacity-50 hover:opacity-85"
            >
              {saveState === "saved" ? "Saved ✓" : saveState === "saving" ? "Saving…" : "Save profile"}
            </button>

            {/* What this account holds */}
            <div className="space-y-2">
              <div className={LABEL}>Your Bayside account</div>
              <div className="border border-hairline bg-card px-3 py-2.5 text-[0.8125rem] text-fg flex items-center justify-between gap-2">
                <div>
                  <div>Stitch Lab</div>
                  <div className="text-[0.6875rem] text-mid">
                    {cloudDesigns} design{cloudDesigns === 1 ? "" : "s"} synced
                    {localDesigns > cloudDesigns ? ` · ${localDesigns} in this browser` : ""}
                  </div>
                </div>
                <a href="/stitchlab#librarypage" className="text-[0.75rem] text-accent hover:underline shrink-0">Library →</a>
              </div>
              <div className="border border-hairline bg-card px-3 py-2.5 text-[0.8125rem] text-fg flex items-center justify-between gap-2">
                <div>
                  <div>Clothing customizer</div>
                  <div className="text-[0.6875rem] text-mid">
                    {labIdeas > 0 ? `${labIdeas} saved idea${labIdeas === 1 ? "" : "s"}` : "Same login - nothing saved there yet"}
                  </div>
                </div>
                <a href="/lab" className="text-[0.75rem] text-accent hover:underline shrink-0">Open →</a>
              </div>
            </div>

            {/* Manage */}
            <div className="space-y-2">
              <div className={LABEL}>Manage</div>
              <div className="flex flex-wrap gap-2">
                <button onClick={onChangePassword} className="border border-hairline bg-bg px-3 py-1.5 text-[0.8125rem] text-fg hover:bg-card">Change password</button>
                <button onClick={() => { onSignOut(); onClose(); }} className="border border-hairline bg-bg px-3 py-1.5 text-[0.8125rem] text-fg hover:bg-card">Sign out</button>
              </div>
              <p className="text-[0.6875rem] text-mid leading-relaxed">
                Want your account or data deleted? Email{" "}
                <span className="text-fg select-all">baysidedesignlab@gmail.com</span> and it's done.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
