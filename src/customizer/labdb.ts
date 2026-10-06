// Customizer Lab persistence: ideas live in IndexedDB on this device.
// Artwork is stored as data URLs inside each idea, so a saved idea survives
// refreshes and reopens fully editable. v2 adds a "drafts" store holding the
// live canvas, so an interrupted session (refresh, crash, timeout) resumes
// exactly where it left off.

export type SavedUpload = {
  id: string;
  name: string;
  dataURL: string;
  aspect: number;
  // present when the design was rendered from typed text — lets the editor
  // re-render it later (different font, edited words, curve, outline)
  textMeta?: { text: string; style: string; font: string; curve?: number; outline?: boolean };
  // where the artwork came from, when it wasn't made here — survives into
  // saved projects so provenance/attribution is always recoverable
  origin?: {
    source: string; // "flickr" | "museum" | …
    id?: string;
    title?: string;
    creator?: string;
    license?: string;
    url?: string;
  };
};

export type SavedPlacement = {
  id: string;
  uploadId: string;
  x: number;
  y: number;
  inches: number;
  flip: boolean;
  view?: "front" | "back"; // legacy ideas = front
  thread?: { code: string; name: string; hex: string }; // recolor to thread
  blend?: "normal" | "multiply" | "overlay" | "soft-light"; // mockup blending
  passes?: number; // 1-5 stacked blend passes (REENO mockup tips)
  rotation?: number; // degrees, 0 = upright
  locked?: boolean; // frozen size — dragging only moves it
};

export type IdeaThread = { code: string; name: string; hex: string };

export type Idea = {
  id: string;
  name: string;
  collection: string; // theme / pitch bucket ("" = uncollected)
  status: "idea" | "queued";
  qty: number;
  garmentId: string;
  colorSlug: string;
  placements: SavedPlacement[];
  uploads: SavedUpload[];
  threads: IdeaThread[];
  notes: string;
  nextNote?: string; // "Next time I want to…" — surfaced when the project reopens
  thumb: string; // small composite preview (data URL)
  costEach?: number; // planning override for blank cost
  createdAt: number;
  updatedAt: number;
};

// live-canvas snapshot — everything needed to put the studio back the way
// it was, including not-yet-saved uploads
export type Draft = {
  id: "current";
  garmentId: string;
  colorSlug: string;
  view: "front" | "back";
  uploads: SavedUpload[];
  placements: SavedPlacement[];
  editingId: string | null;
  ideaName: string;
  collection: string;
  qty: string;
  ideaNotes: string;
  nextNote: string;
  threads: IdeaThread[];
  updatedAt: number;
};

const DB_NAME = "bayside-lab";
const IDEAS = "ideas";
const DRAFTS = "drafts";

function openDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDEAS)) {
        req.result.createObjectStore(IDEAS, { keyPath: "id" });
      }
      if (!req.result.objectStoreNames.contains(DRAFTS)) {
        req.result.createObjectStore(DRAFTS, { keyPath: "id" });
      }
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((res, rej) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      })
  );
}

export const listIdeas = () =>
  tx<Idea[]>(IDEAS, "readonly", (s) => s.getAll() as IDBRequest<Idea[]>).then((ideas) =>
    ideas.sort((a, b) => b.updatedAt - a.updatedAt)
  );

export const putIdea = (idea: Idea) => tx(IDEAS, "readwrite", (s) => s.put(idea));

export const deleteIdea = (id: string) => tx(IDEAS, "readwrite", (s) => s.delete(id));

export const getDraft = () =>
  tx<Draft | undefined>(DRAFTS, "readonly", (s) => s.get("current") as IDBRequest<Draft | undefined>);

export const putDraft = (draft: Draft) => tx(DRAFTS, "readwrite", (s) => s.put(draft));

export const clearDraft = () => tx(DRAFTS, "readwrite", (s) => s.delete("current"));

// Shared-device privacy: wipe every locally stored trace of the account's
// work (ideas + live draft). Called on youth sign-out and on account switch.
export const clearAllLocal = async () => {
  await tx(IDEAS, "readwrite", (s) => s.clear());
  await tx(DRAFTS, "readwrite", (s) => s.clear());
};
