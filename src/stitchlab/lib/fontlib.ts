// User font library - uploaded TTF/OTF files that persist. Stored in
// IndexedDB locally and mirrored into the account's existing `fonts` array
// (the same one the clothing lab syncs: { name, family, dataURL }), so a font
// uploaded in either lab is available in both, on any signed-in device.
// Merge is add-only by name, like the design library.

import { getSession, labApi } from "../account";

export type UserFont = { name: string; family: string; dataURL: string };

const DB = "stitchlab-fonts";
const STORE = "fonts";

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "name" });
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function listUserFonts(): Promise<UserFont[]> {
  try {
    const db = await openDb();
    return await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      tx.onsuccess = () => res((tx.result as UserFont[]).sort((a, b) => a.name.localeCompare(b.name)));
      tx.onerror = () => rej(tx.error);
    });
  } catch {
    return [];
  }
}

async function putLocal(fonts: UserFont[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    const st = tx.objectStore(STORE);
    for (const f of fonts) st.put(f);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function clearUserFonts(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch { /* keep going */ }
  void pushCloud();
}

export async function removeUserFont(name: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(name);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch { /* keep going */ }
  // push the pruned union so the deletion sticks in the account too
  void pushCloud();
}

async function pushCloud(): Promise<"cloud" | "device"> {
  const session = getSession();
  if (!session) return "device";
  try {
    const local = await listUserFonts();
    await labApi("save", { token: session.token, fonts: local });
    return "cloud";
  } catch {
    return "device";
  }
}

/** Save an uploaded font everywhere: IndexedDB now, account when signed in. */
export async function addUserFont(name: string, dataURL: string): Promise<"cloud" | "device"> {
  const clean = name.replace(/\.(ttf|otf|woff2?)$/i, "").slice(0, 48);
  await putLocal([{ name: clean, family: clean, dataURL }]);
  return pushCloud();
}

/** Merge the account's fonts into the local store (add-only, by name). */
export async function syncUserFonts(): Promise<UserFont[]> {
  const session = getSession();
  if (session) {
    try {
      const data = (await labApi("load", { token: session.token })) as { fonts?: UserFont[] };
      const cloud = (data.fonts ?? []).filter((f) => f?.name && f?.dataURL);
      if (cloud.length) await putLocal(cloud);
    } catch { /* offline - local stands */ }
  }
  return listUserFonts();
}

/** dataURL → ArrayBuffer, for opentype parsing. Decoded directly - a fetch()
 *  of a data: URL is blocked by the site's connect-src CSP. */
export async function fontBytes(f: UserFont): Promise<ArrayBuffer> {
  const comma = f.dataURL.indexOf(",");
  const bin = atob(f.dataURL.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
