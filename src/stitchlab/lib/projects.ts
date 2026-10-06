// Stitch Lab - editable-project store: local-first IndexedDB + best-effort
// account sync, with honest states and deliberate conflict handling.
//
// Storage model:
// - IndexedDB `stitchlab-library` gains a `projects` object store (db v2).
//   Projects are always saved locally first; local IS the working copy.
// - Cloud: mixed into the account's free-form `stitchlab` array alongside the
//   existing mirrored designs, discriminated by `t: "project"`. The server
//   does whole-array last-write-wins on that field, so before every push we
//   LOAD the cloud array and merge by id/updatedAt client-side - a stale
//   device can still race between our load and push, but it can no longer
//   blindly clobber, and rev-forking (below) catches what remains.
// - Conflicts: every project carries `rev`. If the cloud copy's rev is AHEAD
//   of the rev we last loaded, someone else edited it; we fork our edits into
//   a "(conflict copy)" instead of silently overwriting either side.
// - Soft delete: `deletedAt` tombstones sync like any other update and are
//   recoverable from the library's "Recently deleted" view.
//
// Budget: the whole account record shares a 4MB cap with the clothing lab and
// the 40 mirrored designs, so only the SYNC_PROJECTS newest projects mirror
// to the account (thumbnails and reference images are size-capped upstream).
// Everything else stays on-device and is labeled that way.

import { getSession, labApi } from "../account";
import { migrateProject, serializeProject, type Project } from "./project";
import { LIBRARY_EVENT } from "./sync";

const DB_NAME = "stitchlab-library";
const DB_VERSION = 2;
const STORE = "projects";
export const PROJECTS_EVENT = "stitchlab:projects-updated";
const SYNC_PROJECTS = 20;

// ── IndexedDB plumbing ─────────────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // v1 created "designs"; keep it. v2 adds "projects".
      if (!db.objectStoreNames.contains("designs")) db.createObjectStore("designs", { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
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
        req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
        t.oncomplete = () => db.close();
        t.onerror = () => db.close();
        t.onabort = () => db.close();
      }),
  );
}

// ── local CRUD ─────────────────────────────────────────────────────────────

/** Stored form: the project plus the rev we last saw in the cloud (for
 *  conflict detection). */
type StoredProject = Project & { _cloudRev?: number };

export async function putProjectLocal(p: Project, cloudRev?: number): Promise<void> {
  const stored: StoredProject = { ...p };
  if (cloudRev !== undefined) stored._cloudRev = cloudRev;
  await tx("readwrite", (s) => s.put(stored));
  window.dispatchEvent(new Event(PROJECTS_EVENT));
}

export async function getProject(id: string): Promise<Project | null> {
  const raw = await tx<unknown>("readonly", (s) => s.get(id) as IDBRequest<unknown>);
  if (!raw) return null;
  try {
    return migrateProject(raw);
  } catch {
    return null;
  }
}

export async function listProjects(): Promise<Project[]> {
  const raw = await tx<unknown[]>("readonly", (s) => s.getAll() as IDBRequest<unknown[]>);
  const out: Project[] = [];
  for (const r of raw) {
    try {
      out.push(migrateProject(r));
    } catch {
      /* skip corrupt record; never take the library down */
    }
  }
  return out;
}

export async function hardDeleteProject(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
  window.dispatchEvent(new Event(PROJECTS_EVENT));
}

async function getCloudRev(id: string): Promise<number | undefined> {
  const raw = (await tx<unknown>("readonly", (s) => s.get(id) as IDBRequest<unknown>)) as
    | StoredProject
    | undefined;
  return raw?._cloudRev;
}

// ── library operations (soft delete, duplicate, organize) ─────────────────

export async function softDeleteProject(id: string): Promise<void> {
  const p = await getProject(id);
  if (!p) return;
  p.deletedAt = Date.now();
  p.updatedAt = Date.now();
  p.rev += 1;
  await putProjectLocal(p);
  void pushProjects().catch(() => {});
}

export async function restoreProject(id: string): Promise<void> {
  const p = await getProject(id);
  if (!p) return;
  delete p.deletedAt;
  p.updatedAt = Date.now();
  p.rev += 1;
  await putProjectLocal(p);
  void pushProjects().catch(() => {});
}

export async function duplicateProject(id: string): Promise<Project | null> {
  const p = await getProject(id);
  if (!p) return null;
  const copy: Project = {
    ...p,
    id: crypto.randomUUID(),
    name: `${p.name} copy`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    rev: 0,
    elements: p.elements.map((e) => ({ ...e, id: crypto.randomUUID() })),
  };
  delete copy.deletedAt;
  await putProjectLocal(copy);
  return copy;
}

// ── save states + autosave ─────────────────────────────────────────────────

export type SaveState =
  | "saving"
  | "device" // saved locally, signed out
  | "cloud" // saved locally + synced to the account
  | "sync-failed" // saved locally, cloud push failed (offline / quota / error)
  | "conflict" // another device edited this project; we forked a copy
  | "local-error"; // local write itself failed (storage full/blocked)

export type SaveResult = { state: SaveState; forkedId?: string; detail?: string };

/**
 * Save a project: local first (always), then best-effort cloud push.
 * Never claims success it didn't achieve.
 */
export async function saveProject(p: Project): Promise<SaveResult> {
  p.updatedAt = Date.now();
  p.rev += 1;
  try {
    await putProjectLocal(p);
  } catch (e) {
    return { state: "local-error", detail: e instanceof Error ? e.message : "local save failed" };
  }
  if (!getSession()) return { state: "device" };
  try {
    const conflict = await pushProjects();
    if (conflict && conflict.id === p.id) {
      return { state: "conflict", forkedId: conflict.forkedId };
    }
    return { state: "cloud" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    return { state: "sync-failed", detail: /too large|413/i.test(msg) ? "account storage is full" : msg };
  }
}

/** Debounced autosave helper for the editor. */
export function createAutosaver(onState: (r: SaveResult) => void, delayMs = 1500) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Project | null = null;
  let running = false;
  const flush = async () => {
    if (running || !pending) return;
    const p = pending;
    pending = null;
    running = true;
    onState({ state: "saving" });
    const r = await saveProject(p);
    running = false;
    onState(r);
    if (pending) void flush(); // an edit landed mid-save
  };
  return {
    schedule(p: Project) {
      pending = p;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), delayMs);
    },
    /** Immediate save (e.g. before navigating away). */
    async flushNow() {
      if (timer) clearTimeout(timer);
      await flush();
    },
  };
}

// ── cloud sync (via the account's free-form `stitchlab` array) ────────────

type CloudRecord = Record<string, unknown>;
const isProjectRecord = (r: CloudRecord): boolean => r && r.t === "project";

export type MergeDecision = {
  merged: CloudRecord[];
  /** A local project whose cloud copy advanced past what we loaded. */
  conflict: { id: string; cloud: Project } | null;
};

/**
 * Pure merge of the cloud `stitchlab` array with our local projects.
 * - Non-project records (mirrored designs) pass through untouched.
 * - Projects merge by id: newer `updatedAt` wins, EXCEPT when the cloud rev is
 *   ahead of the rev this device last loaded (`cloudRevSeen`) AND local also
 *   changed - that's a genuine two-device conflict, reported to the caller
 *   (the cloud copy stays in the array; the caller forks local edits).
 * Exported for tests.
 */
export function mergeCloudProjects(
  cloudArr: CloudRecord[],
  localProjects: Project[],
  cloudRevSeen: Map<string, number | undefined>,
): MergeDecision {
  const passthrough = cloudArr.filter((r) => !isProjectRecord(r));
  const cloudProjects = new Map<string, Project>();
  for (const r of cloudArr.filter(isProjectRecord)) {
    try {
      const p = migrateProject(r.p);
      cloudProjects.set(p.id, p);
    } catch {
      /* drop unreadable cloud project record */
    }
  }

  let conflict: MergeDecision["conflict"] = null;
  const outProjects = new Map<string, Project>();

  for (const [id, cloud] of cloudProjects) outProjects.set(id, cloud);
  for (const local of localProjects) {
    const cloud = cloudProjects.get(local.id);
    if (!cloud) {
      outProjects.set(local.id, local);
      continue;
    }
    const seen = cloudRevSeen.get(local.id);
    const localChanged = seen !== undefined ? local.rev > seen : local.rev > cloud.rev;
    const cloudAdvanced = seen !== undefined && cloud.rev > seen;
    if (cloudAdvanced && localChanged && !conflict) {
      // genuine divergence: keep the cloud copy in place, surface the conflict
      conflict = { id: local.id, cloud };
      continue;
    }
    if (local.updatedAt >= cloud.updatedAt) outProjects.set(local.id, local);
  }

  const projectRecords = [...outProjects.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, SYNC_PROJECTS)
    .map((p) => ({ t: "project", id: p.id, updatedAt: p.updatedAt, p: JSON.parse(serializeProject(p)) as unknown }));

  return { merged: [...passthrough, ...projectRecords], conflict };
}

/**
 * Push local projects to the account. Loads the cloud array first and merges
 * (see mergeCloudProjects). Returns conflict info when a fork was created.
 * Throws on network/auth/quota failure (caller reports sync-failed).
 */
export async function pushProjects(): Promise<{ id: string; forkedId: string } | null> {
  const session = getSession();
  if (!session) return null;
  const data = (await labApi("load", { token: session.token })) as { stitchlab?: CloudRecord[] };
  const cloudArr = Array.isArray(data.stitchlab) ? data.stitchlab : [];
  const locals = (await listProjects()).filter((p) => !p.deletedAt || Date.now() - p.deletedAt < 30 * 24 * 3600 * 1000);
  const seen = new Map<string, number | undefined>();
  for (const p of locals) seen.set(p.id, await getCloudRev(p.id));

  const { merged, conflict } = mergeCloudProjects(cloudArr, locals, seen);

  let forked: { id: string; forkedId: string } | null = null;
  if (conflict) {
    // fork our local edits, adopt the cloud copy under the original id
    const local = locals.find((p) => p.id === conflict.id);
    if (local) {
      const fork: Project = {
        ...local,
        id: crypto.randomUUID(),
        name: `${local.name} (conflict copy)`,
        rev: 0,
        updatedAt: Date.now(),
      };
      await putProjectLocal(fork);
      await putProjectLocal(conflict.cloud, conflict.cloud.rev);
      forked = { id: conflict.id, forkedId: fork.id };
      merged.push({ t: "project", id: fork.id, updatedAt: fork.updatedAt, p: JSON.parse(serializeProject(fork)) as unknown });
    }
  }

  await labApi("save", { token: session.token, stitchlab: merged });
  // record the revs we just pushed as "seen"
  for (const p of await listProjects()) {
    await tx("readwrite", (s) => s.put({ ...p, _cloudRev: p.rev } as StoredProject));
  }
  window.dispatchEvent(new Event(LIBRARY_EVENT));
  return forked;
}

/** Pull cloud projects into the local store (add or update-newer). Called on
 *  sign-in / app start. Never deletes local work. */
export async function syncProjectsDown(): Promise<number> {
  const session = getSession();
  if (!session) return 0;
  const data = (await labApi("load", { token: session.token })) as { stitchlab?: CloudRecord[] };
  const cloudArr = Array.isArray(data.stitchlab) ? data.stitchlab : [];
  let restored = 0;
  for (const r of cloudArr.filter(isProjectRecord)) {
    try {
      const cloud = migrateProject(r.p);
      const local = await getProject(cloud.id);
      if (!local || cloud.updatedAt > local.updatedAt) {
        await putProjectLocal(cloud, cloud.rev);
        restored++;
      }
    } catch {
      /* skip unreadable */
    }
  }
  if (restored) window.dispatchEvent(new Event(PROJECTS_EVENT));
  return restored;
}

// ── search / sort helpers (pure; used by the library UI) ──────────────────

export type ProjectSort = "recent" | "created" | "name";

export function organizeProjects(
  all: Project[],
  opts: { query?: string; collection?: string | null; favoritesOnly?: boolean; sort?: ProjectSort; deleted?: boolean },
): Project[] {
  const q = (opts.query ?? "").trim().toLowerCase();
  let out = all.filter((p) => (opts.deleted ? !!p.deletedAt : !p.deletedAt));
  if (q) out = out.filter((p) => p.name.toLowerCase().includes(q) || (p.collection ?? "").toLowerCase().includes(q));
  if (opts.collection) out = out.filter((p) => p.collection === opts.collection);
  if (opts.favoritesOnly) out = out.filter((p) => p.favorite);
  const sort = opts.sort ?? "recent";
  out.sort((a, b) =>
    sort === "recent" ? b.updatedAt - a.updatedAt : sort === "created" ? b.createdAt - a.createdAt : a.name.localeCompare(b.name),
  );
  return out;
}

export function collectionsOf(all: Project[]): string[] {
  return [...new Set(all.filter((p) => !p.deletedAt && p.collection).map((p) => p.collection!))].sort();
}
