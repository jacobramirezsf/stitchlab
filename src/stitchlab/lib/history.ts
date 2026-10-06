// Stitch Lab - generic undo/redo history over immutable snapshots.
//
// Pure and framework-free so it can be unit tested. The editor stores
// Project.elements snapshots; pushing a new state clears the redo stack.
// `replace` updates the present WITHOUT creating an undo step - used for
// continuous gestures (drag/resize) where only the gesture's end should be
// one undoable step.

export type History<T> = {
  past: T[];
  present: T;
  future: T[];
};

export function createHistory<T>(initial: T): History<T> {
  return { past: [], present: initial, future: [] };
}

export function push<T>(h: History<T>, next: T, limit = 100): History<T> {
  const past = [...h.past, h.present];
  if (past.length > limit) past.splice(0, past.length - limit);
  return { past, present: next, future: [] };
}

/** Update the present without an undo step (mid-gesture). */
export function replace<T>(h: History<T>, next: T): History<T> {
  return { ...h, present: next };
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  const past = h.past.slice(0, -1);
  return { past, present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  const [next, ...future] = h.future;
  return { past: [...h.past, h.present], present: next, future };
}

export const canUndo = <T,>(h: History<T>): boolean => h.past.length > 0;
export const canRedo = <T,>(h: History<T>): boolean => h.future.length > 0;
