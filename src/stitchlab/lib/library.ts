// Design library - saved generations, persisted in IndexedDB (not
// localStorage: DST bytes + thumbnails would blow the 5MB quota fast, while
// IndexedDB comfortably holds hundreds of designs at ~50KB each).

export type SavedDesign = {
  id: string;
  name: string;
  tool: string;
  createdAt: number;
  stitchCount: number;
  widthMm: number;
  heightMm: number;
  colors: string[];
  /** Small PNG data-URL preview (~15KB). */
  thumbPng: string;
  /** The exact DST bytes as generated. */
  bytes: Uint8Array;
};

const DB_NAME = "stitchlab-library";
// v2 adds the "projects" store (lib/projects.ts). Both modules MUST open the
// same version with the same upgrade, or whichever runs second fails.
const DB_VERSION = 2;
const STORE = "designs";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("projects")) {
        db.createObjectStore("projects", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("Library operation failed"));
        t.oncomplete = () => db.close();
      }),
  );
}

export function saveDesign(d: SavedDesign): Promise<IDBValidKey> {
  return tx("readwrite", (s) => s.put(d));
}

export function listDesigns(): Promise<SavedDesign[]> {
  return tx<SavedDesign[]>("readonly", (s) => s.getAll() as IDBRequest<SavedDesign[]>).then(
    (all) => all.sort((a, b) => b.createdAt - a.createdAt),
  );
}

export function deleteDesign(id: string): Promise<undefined> {
  return tx("readwrite", (s) => s.delete(id) as IDBRequest<undefined>);
}

export async function libraryUsage(): Promise<{ count: number; approxMB: number }> {
  const all = await listDesigns();
  let bytes = 0;
  for (const d of all) bytes += d.bytes.byteLength + d.thumbPng.length;
  return { count: all.length, approxMB: bytes / 1024 / 1024 };
}
