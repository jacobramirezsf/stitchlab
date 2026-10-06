// Cloud sync for the design library. IndexedDB is the working store (fast,
// offline, no quota anxiety); a signed-in account mirrors designs to the
// Bayside backend so clearing a browser or switching devices never loses
// work. Sync is merge-based on design id - cloud and local are unioned, never
// clobbered - and a save's cloud push failing still leaves the local save.

import { getSession, labApi } from "../account";
import { listDesigns, saveDesign, type SavedDesign } from "./library";

/** Most-recent designs mirrored to the account. The whole user record shares
 *  a 4MB cap with clothing-lab ideas, so the mirror is bounded; everything
 *  always stays in the browser library regardless. */
const SYNC_LIMIT = 40;

export type CloudDesign = Omit<SavedDesign, "bytes"> & { bytesB64: string };

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const serialize = (d: SavedDesign): CloudDesign => {
  const { bytes, ...rest } = d;
  return { ...rest, bytesB64: toB64(bytes) };
};
const deserialize = (c: CloudDesign): SavedDesign => {
  const { bytesB64, ...rest } = c;
  return { ...rest, bytes: fromB64(bytesB64) };
};

/** Fired whenever the local library changes from a sync, so open views refresh. */
export const LIBRARY_EVENT = "stitchlab:library-updated";
/** Fired when a tool wants the account modal opened (e.g. the save nudge). */
export const AUTH_EVENT = "stitchlab:auth";

/** Push the local library (most recent SYNC_LIMIT) to the account. */
export async function pushLibrary(): Promise<void> {
  const session = getSession();
  if (!session) return;
  const all = await listDesigns(); // already newest-first
  const payload = all.slice(0, SYNC_LIMIT).map(serialize);
  await labApi("save", { token: session.token, stitchlab: payload });
}

/** Merge cloud designs into the local library, then push the union back.
 *  Returns the number of designs restored from the cloud, or null when
 *  signed out / the server is unreachable (local library is untouched). */
export async function syncLibrary(): Promise<number | null> {
  const session = getSession();
  if (!session) return null;
  try {
    const data = await labApi("load", { token: session.token });
    // Remember the account's role so staff-only views (the tools overview)
    // can gate client-side. The server still authorizes everything real.
    try {
      localStorage.setItem("bayside-lab-role", data.admin ? "admin" : data.staff ? "staff" : "user");
    } catch { /* ignore */ }
    const cloud = (Array.isArray(data.stitchlab) ? data.stitchlab : []) as CloudDesign[];
    const local = await listDesigns();
    const have = new Set(local.map((d) => d.id));
    let restored = 0;
    for (const c of cloud) {
      if (!c || typeof c.id !== "string" || have.has(c.id) || typeof c.bytesB64 !== "string") continue;
      try {
        await saveDesign(deserialize(c));
        restored++;
      } catch {
        /* one bad record never blocks the rest */
      }
    }
    if (restored > 0) window.dispatchEvent(new Event(LIBRARY_EVENT));
    await pushLibrary().catch(() => {});
    return restored;
  } catch {
    return null;
  }
}

/** Save locally, then mirror to the account when signed in.
 *  "cloud" = in the account; "device" = this browser only (signed out);
 *  "device-error" = signed in but the mirror failed (local save is safe). */
export async function saveDesignEverywhere(d: SavedDesign): Promise<"cloud" | "device" | "device-error"> {
  await saveDesign(d);
  window.dispatchEvent(new Event(LIBRARY_EVENT));
  if (!getSession()) return "device";
  try {
    await pushLibrary();
    return "cloud";
  } catch {
    return "device-error";
  }
}
