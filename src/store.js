// Central application state with an undo/redo history.
//
// `sources` (loaded PDFs) and transient view state (selection, current page,
// zoom) live outside the history. Only the *document model* — the ordered page
// list and the page-numbering settings — is snapshotted, since that's what the
// user means by "undo".

let nextId = 1;
export const uid = (prefix = 'id') => `${prefix}${nextId++}`;

const state = {
  // srcId -> { name, bytes:Uint8Array, pdfjsDoc, isPdfA, pdfaPart }
  sources: new Map(),

  // Ordered working document. Each page:
  //   { id, kind:'pdf'|'blank', srcId, srcPageIndex, rotation:0|90|180|270,
  //     width, height,            // unrotated page size in PDF points
  //     overlays: [ {id, text, lang:'en'|'he', xPt, yPt, size, color} ] }
  pages: [],

  docName: 'document.pdf',

  // Page numbering applied at save time, in final page order.
  pageNumbering: { enabled: false, position: 'bottom-center', start: 1, format: 'n' },

  // --- transient (not in history) ---
  selection: new Set(),   // selected page ids
  currentPageId: null,    // page shown in the right-hand viewer
};

const HISTORY_LIMIT = 100;
const undoStack = [];
const redoStack = [];
const listeners = new Set();

function snapshot() {
  return JSON.stringify({ pages: state.pages, docName: state.docName, pageNumbering: state.pageNumbering });
}
function restore(snap) {
  const obj = JSON.parse(snap);
  state.pages = obj.pages;
  state.docName = obj.docName;
  state.pageNumbering = obj.pageNumbering;
  // Drop selection/current that no longer exist.
  const ids = new Set(state.pages.map((p) => p.id));
  state.selection = new Set([...state.selection].filter((id) => ids.has(id)));
  if (!ids.has(state.currentPageId)) state.currentPageId = state.pages[0]?.id ?? null;
}

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) fn(state);
}

/**
 * Run a history-worthy mutation. Pushes the pre-mutation snapshot onto the
 * undo stack, clears redo, applies the change, then notifies listeners.
 */
export function commit(mutator) {
  undoStack.push(snapshot());
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  mutator(state);
  emit();
}

export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }

export function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  emit();
}
export function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  emit();
}

// --- transient setters (no history) ---
export function setSelection(ids) {
  state.selection = new Set(ids);
  emit();
}
export function setCurrent(id) {
  state.currentPageId = id;
  emit();
}

/**
 * Compute the new page id order after a drag.
 * `domOrder` is the post-drop DOM order of ids; `draggedId` is the grabbed
 * page; `movingIds` are all ids that should travel together (in document
 * order). The whole moving block is placed where the dragged page landed.
 */
export function computeReorder(domOrder, draggedId, movingIds) {
  const movingSet = new Set(movingIds);
  const result = [];
  for (const id of domOrder) {
    if (id === draggedId) result.push(...movingIds);
    else if (!movingSet.has(id)) result.push(id);
  }
  return result;
}

/** The page ids an action should target: the selection if the page is part of
 *  a multi-selection, otherwise just the page itself. */
export function targetIds(pageId) {
  if (state.selection.has(pageId) && state.selection.size > 1) {
    // preserve document order
    return state.pages.filter((p) => state.selection.has(p.id)).map((p) => p.id);
  }
  return [pageId];
}
