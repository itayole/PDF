import './style.css';
import Sortable from 'sortablejs';
import {
  getState, emit, subscribe, commit, undo, redo, canUndo, canRedo,
  setSelection, targetIds, uid, computeReorder,
} from './store.js';
import {
  registerSource, pageItemsForSource, renderPage, assemble,
} from './pdfio.js';
import { containsHebrew } from './fonts.js';

const $ = (id) => document.getElementById(id);
const THUMB_W = 150;

// Keep in sync with package.json "version". Shown in the toolbar; the notes
// appear on hover/focus of the version label.
const VERSION = '0.3';
const RELEASE_NOTES = [
  'PDF Editor v0.3',
  '• Two-pane workspace: thumbnail rail + continuous full-size scroll viewer',
  '• Delete, insert (from other PDFs), reorder (multi-select drag), rotate,',
  '  duplicate, blank pages, extract selection',
  '• Add text overlays in English & Hebrew (RTL)',
  '• Page numbering on save; searchable text preserved; PDF/A detection + warning',
  '• Per-page zoom preview in the insert picker',
  '• Undo / redo',
].join('\n');

// Transient view state (not in undo history)
let currentScale = 1;
let fitMode = true;
let placing = false;        // "add text" mode armed
let lastClickedId = null;   // for shift-range selection
let ctxTargetId = null;     // page the context menu was opened on
let pendingInsertIndex = null;
let editingSize = 16;

// Continuous-scroll viewer: one record per page in the stack.
// id -> { container, canvas, layer, item, rendered, mapper }
const pageEls = new Map();
let lastStackSig = null;     // rebuild the stack only when this changes
let suppressScrollSync = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 3200);
}
const rgbCss = (c) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
const pageById = (id) => getState().pages.find((p) => p.id === id);

// Thumbnail bitmap cache keyed by visual identity (so duplicated pages share).
const thumbCache = new Map();
function thumbKey(item) {
  return item.kind === 'blank'
    ? `blank:${item.width}x${item.height}:${item.rotation}`
    : `${item.srcId}:${item.srcPageIndex}:${item.rotation}`;
}
async function getThumb(item) {
  const key = thumbKey(item);
  if (thumbCache.has(key)) return thumbCache.get(key);
  const promise = (async () => {
    const canvas = document.createElement('canvas');
    const scale = THUMB_W / item.width;
    await renderPage(item, scale, canvas);
    return canvas.toDataURL('image/png');
  })();
  thumbCache.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
function render() {
  renderToolbar();
  renderThumbs();
  renderViewer();
}

function renderToolbar() {
  const st = getState();
  const has = st.pages.length > 0;
  $('btn-undo').disabled = !canUndo();
  $('btn-redo').disabled = !canRedo();
  $('btn-text').disabled = !has;
  $('btn-save').disabled = !has;
  $('btn-select-all').disabled = !has;
  $('btn-text').classList.toggle('btn-text-active', placing);

  $('doc-name').textContent = has ? st.docName : '';
  $('page-count').textContent = has ? `${st.pages.length} page${st.pages.length === 1 ? '' : 's'}` : '';

  // PDF/A badge if any loaded source is PDF/A.
  const pdfa = [...st.sources.values()].find((s) => s.isPdfA);
  const badge = $('pdfa-badge');
  if (pdfa) {
    badge.hidden = false;
    badge.textContent = `PDF/A${pdfa.pdfaPart ? ' ' + pdfa.pdfaPart : ''}`;
    badge.title = 'This file is PDF/A. The edited copy this tool saves is a standard PDF and will NOT retain PDF/A conformance.';
  } else {
    badge.hidden = true;
  }
}

function renderThumbs() {
  const st = getState();
  const wrap = $('thumbs');
  wrap.innerHTML = '';

  // "+" zone for inserting pages at a given index (0 = before first page).
  const addInsertRow = (index, edge) => {
    const row = document.createElement('div');
    row.className = 'insert-row' + (edge ? ' insert-row-edge' : '');
    row.title = index === 0 ? 'Insert pages before the first page'
      : index === st.pages.length ? 'Insert pages after the last page'
      : `Insert pages here (before page ${index + 1})`;
    const plus = document.createElement('span');
    plus.className = 'insert-plus';
    plus.textContent = '+';
    row.appendChild(plus);
    row.addEventListener('click', (e) => { e.stopPropagation(); beginInsertAt(index); });
    wrap.appendChild(row);
  };

  if (st.pages.length) addInsertRow(0, true);

  st.pages.forEach((item, index) => {
    const el = document.createElement('div');
    el.className = 'thumb';
    el.dataset.id = item.id;
    if (st.selection.has(item.id)) el.classList.add('selected');
    if (st.currentPageId === item.id) el.classList.add('current');

    const idx = document.createElement('span');
    idx.className = 'thumb-index';
    idx.textContent = index + 1;

    const cw = document.createElement('div');
    cw.className = 'thumb-canvas-wrap';
    const sp = document.createElement('span');
    sp.className = 'spinner';
    sp.textContent = '…';
    cw.appendChild(sp);

    const badges = document.createElement('div');
    badges.className = 'thumb-badges';
    if (item.kind === 'blank') badges.innerHTML += '<span class="badge">blank</span>';
    if (item.rotation) badges.innerHTML += `<span class="badge rot">${item.rotation}°</span>`;
    if ((item.overlays || []).length) badges.innerHTML += '<span class="badge text">T</span>';

    el.append(idx, cw, badges);
    wrap.appendChild(el);

    getThumb(item)
      .then((url) => {
        const img = document.createElement('img');
        img.src = url;
        cw.replaceChildren(img);
      })
      .catch(() => (sp.textContent = '⚠'));

    el.addEventListener('click', (e) => onThumbClick(e, item.id, index));
    el.addEventListener('dblclick', () => openZoom(item.id));
    el.addEventListener('contextmenu', (e) => onThumbContext(e, item.id));

    addInsertRow(index + 1, index === st.pages.length - 1);
  });
}

function onThumbClick(e, id, index) {
  const st = getState();
  const sel = new Set(st.selection);
  if (e.shiftKey && lastClickedId) {
    const a = st.pages.findIndex((p) => p.id === lastClickedId);
    const b = index;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) sel.add(st.pages[i].id);
  } else if (e.ctrlKey || e.metaKey) {
    sel.has(id) ? sel.delete(id) : sel.add(id);
  } else {
    sel.clear();
    sel.add(id);
  }
  lastClickedId = id;
  st.selection = sel;
  st.currentPageId = id;
  emit();
  scrollToPage(id); // bring the clicked page into view in the scroll viewer
}

// ---------------------------------------------------------------------------
// Viewer (right pane) — continuous vertical scroll of every page
// ---------------------------------------------------------------------------
function fitScale(item) {
  const avail = $('viewer').clientWidth - 48;
  const swap = item.rotation === 90 || item.rotation === 270;
  const dispW = swap ? item.height : item.width;
  return Math.max(0.1, Math.min(3, avail / dispW));
}
function dispSize(item, scale) {
  const swap = item.rotation === 90 || item.rotation === 270;
  return { w: (swap ? item.height : item.width) * scale, h: (swap ? item.width : item.height) * scale };
}

function renderViewer() {
  const st = getState();
  const has = st.pages.length > 0;
  $('viewer-empty').hidden = has;
  $('viewer-stage').hidden = !has;
  $('v-prev').disabled = $('v-next').disabled = $('v-zoom-in').disabled =
    $('v-zoom-out').disabled = $('v-fit').disabled = !has;
  if (!has) { $('v-indicator').textContent = '—'; $('viewer-stage').innerHTML = ''; pageEls.clear(); lastStackSig = null; return; }

  if (!pageById(st.currentPageId)) st.currentPageId = st.pages[0].id;
  if (fitMode) currentScale = fitScale(pageById(st.currentPageId) || st.pages[0]);

  const sig = st.pages.map((p) => `${p.id}:${p.rotation}`).join('|') + `@${currentScale.toFixed(3)}`;
  if (sig !== lastStackSig) {
    rebuildStack(currentScale);
    lastStackSig = sig;
  } else {
    // No structural change: just refresh overlays on already-rendered pages
    // (covers text add/edit/undo without re-rasterising the page).
    for (const rec of pageEls.values()) if (rec.rendered) renderOverlaysFor(rec);
  }
  updateViewerBar();
}

function rebuildStack(scale) {
  const stage = $('viewer-stage');
  const keepCurrent = getState().currentPageId;
  stage.innerHTML = '';
  pageEls.clear();

  for (const item of getState().pages) {
    const container = document.createElement('div');
    container.className = 'viewer-page';
    container.dataset.id = item.id;
    const { w, h } = dispSize(item, scale);
    container.style.width = `${w}px`;
    container.style.height = `${h}px`; // placeholder so scroll height is correct pre-render
    const canvas = document.createElement('canvas');
    const layer = document.createElement('div');
    layer.className = 'overlay-layer';
    container.append(canvas, layer);
    stage.appendChild(container);
    pageEls.set(item.id, { container, canvas, layer, item, rendered: false, mapper: null });
  }
  // Keep the previously-current page in view after a rebuild (e.g. zoom).
  if (keepCurrent && pageEls.has(keepCurrent)) {
    suppressScrollSync = true;
    pageEls.get(keepCurrent).container.scrollIntoView({ block: 'center' });
    setTimeout(() => { suppressScrollSync = false; }, 60);
  }
  maintainRender();
}

// Render the pages currently near the viewport (scroll-driven virtualisation).
// Uses scroll geometry rather than IntersectionObserver so it fires reliably.
function maintainRender() {
  if (!pageEls.size) return;
  const viewer = $('viewer');
  const vTop = viewer.getBoundingClientRect().top;
  const margin = 700;
  for (const rec of pageEls.values()) {
    if (rec.rendered) continue;
    const r = rec.container.getBoundingClientRect();
    const relTop = r.top - vTop;
    const relBottom = r.bottom - vTop;
    if (relBottom > -margin && relTop < viewer.clientHeight + margin) {
      renderPageInto(rec, currentScale);
    }
  }
}

/** Render a single page synchronously-enough for placement; returns a promise. */
async function renderPageInto(rec, scale) {
  rec.rendered = true; // guard against double render while awaiting
  try {
    rec.mapper = await renderPage(rec.item, scale, rec.canvas);
    rec.container.style.width = `${rec.mapper.cssWidth}px`;
    rec.container.style.height = `${rec.mapper.cssHeight}px`;
    renderOverlaysFor(rec);
  } catch {
    rec.rendered = false;
  }
  return rec;
}

function renderOverlaysFor(rec) {
  const layer = rec.layer;
  // Don't clobber an in-progress edit on this page.
  if (layer.querySelector('.text-overlay.editing')) return;
  layer.innerHTML = '';
  if (!rec.mapper) return;
  for (const o of rec.item.overlays || []) {
    const vp = rec.mapper.toViewportPoint(o.xPt, o.yPt);
    const el = document.createElement('div');
    el.className = 'text-overlay';
    el.dataset.id = o.id;
    el.dataset.lang = o.lang;
    el.style.left = `${vp.x}px`;
    el.style.top = `${vp.y}px`;
    el.style.fontSize = `${o.size * currentScale}px`;
    el.style.color = rgbCss(o.color);
    el.textContent = o.text;
    attachOverlayHandlers(el, o, rec);
    layer.appendChild(el);
  }
}

function updateViewerBar() {
  const st = getState();
  const idx = st.pages.findIndex((p) => p.id === st.currentPageId);
  $('v-indicator').textContent = `${idx + 1} / ${st.pages.length}`;
  $('v-zoom-level').textContent = `${Math.round(currentScale * 100)}%`;
  $('v-prev').disabled = idx <= 0;
  $('v-next').disabled = idx >= st.pages.length - 1;
}

// As the user scrolls, mark the most-centred page current (no store emit, to
// avoid churn) and keep the thumbnail highlight + indicator in sync.
let scrollTick = false;
$('viewer').addEventListener('scroll', () => {
  if (scrollTick) return;
  scrollTick = true;
  setTimeout(() => { scrollTick = false; maintainRender(); if (!suppressScrollSync) syncCurrentToScroll(); }, 80);
});
function syncCurrentToScroll() {
  if (!pageEls.size) return;
  const viewer = $('viewer');
  const center = viewer.getBoundingClientRect().top + viewer.clientHeight / 2;
  let best = null, bestD = Infinity;
  for (const [id, rec] of pageEls) {
    const r = rec.container.getBoundingClientRect();
    const d = Math.abs(r.top + r.height / 2 - center);
    if (d < bestD) { bestD = d; best = id; }
  }
  if (best && best !== getState().currentPageId) {
    getState().currentPageId = best;
    updateViewerBar();
    [...$('thumbs').children].forEach((c) => c.classList.toggle('current', c.dataset.id === best));
  }
}

function scrollToPage(id) {
  const rec = pageEls.get(id);
  if (!rec) return;
  rec.container.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Programmatic scroll may not emit scroll events everywhere; render directly.
  setTimeout(maintainRender, 50);
}

$('v-prev').addEventListener('click', () => stepPage(-1));
$('v-next').addEventListener('click', () => stepPage(1));
function stepPage(d) {
  const st = getState();
  const idx = st.pages.findIndex((p) => p.id === st.currentPageId);
  const next = st.pages[idx + d];
  if (next) { st.currentPageId = next.id; updateViewerBar(); scrollToPage(next.id); }
}
$('v-zoom-in').addEventListener('click', () => { fitMode = false; currentScale = Math.min(3, currentScale * 1.2); lastStackSig = null; renderViewer(); });
$('v-zoom-out').addEventListener('click', () => { fitMode = false; currentScale = Math.max(0.1, currentScale / 1.2); lastStackSig = null; renderViewer(); });
$('v-fit').addEventListener('click', () => { fitMode = true; lastStackSig = null; renderViewer(); });

// ---------------------------------------------------------------------------
// Text overlays: place / edit / move
// ---------------------------------------------------------------------------
$('btn-text').addEventListener('click', () => {
  placing = !placing;
  $('viewer').classList.toggle('placing', placing);
  renderToolbar();
  if (placing) toast('Click on the page where you want to add text');
});

$('viewer-stage').addEventListener('click', async (e) => {
  if (!placing) return;
  if (e.target.classList.contains('text-overlay')) return;
  const container = e.target.closest('.viewer-page');
  if (!container) return;
  let rec = pageEls.get(container.dataset.id);
  if (!rec) return;
  if (!rec.mapper) await renderPageInto(rec, currentScale); // ensure placeable
  if (!rec.mapper) return;
  const rect = rec.canvas.getBoundingClientRect();
  const pt = rec.mapper.toPdfPoint(e.clientX - rect.left, e.clientY - rect.top);
  placing = false;
  $('viewer').classList.remove('placing');
  renderToolbar();
  startEditing(null, { xPt: pt.x, yPt: pt.y }, rec);
}, true);

function attachOverlayHandlers(el, o, rec) {
  let down = null;
  let moved = false;
  el.addEventListener('pointerdown', (e) => {
    if (el.isContentEditable) return;
    down = { x: e.clientX, y: e.clientY, left: parseFloat(el.style.left), top: parseFloat(el.style.top) };
    moved = false;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    if (moved) { el.style.left = `${down.left + dx}px`; el.style.top = `${down.top + dy}px`; }
  });
  el.addEventListener('pointerup', () => {
    if (!down) return;
    const wasMoved = moved;
    down = null;
    if (wasMoved) {
      const pt = rec.mapper.toPdfPoint(parseFloat(el.style.left), parseFloat(el.style.top));
      commit((s) => {
        const it = s.pages.find((p) => p.id === rec.item.id);
        const ov = it.overlays.find((x) => x.id === o.id);
        ov.xPt = pt.x; ov.yPt = pt.y;
      });
    } else {
      startEditing(el, o, rec);
    }
  });
}

/**
 * Edit an overlay. If `existing` has an id it's an edit; otherwise it's a new
 * overlay at {xPt,yPt} that is only committed when non-empty text is entered.
 */
function startEditing(el, existing, rec) {
  const item = rec.item;
  // Clear any stale editing element so only one edit is ever live.
  rec.layer.querySelectorAll('.text-overlay.editing').forEach((e) => e.remove());

  const isNew = !existing.id;
  editingSize = existing.size || 16;
  if (isNew) {
    el = document.createElement('div');
    el.className = 'text-overlay editing';
    el.dataset.lang = 'en';
    const vp = rec.mapper.toViewportPoint(existing.xPt, existing.yPt);
    el.style.left = `${vp.x}px`;
    el.style.top = `${vp.y}px`;
    el.style.fontSize = `${editingSize * currentScale}px`;
    rec.layer.appendChild(el);
  } else {
    el.classList.add('editing');
    el.textContent = existing.text;
  }
  el.contentEditable = 'true';

  let done = false;
  const finish = () => {
    if (done) return; // blur can fire more than once
    done = true;
    el.removeEventListener('blur', finish);
    hideOvTools();
    const text = el.textContent.trim();
    const lang = containsHebrew(text) ? 'he' : 'en';
    // Remove the transient editing element; render() rebuilds the overlay from
    // committed state (correct lang/position) once it's no longer "editing".
    el.remove();
    if (!text) {
      if (!isNew) commit((s) => { const it = s.pages.find((p) => p.id === item.id); it.overlays = it.overlays.filter((x) => x.id !== existing.id); });
      return;
    }
    commit((s) => {
      const it = s.pages.find((p) => p.id === item.id);
      if (isNew) it.overlays.push({ id: uid('o'), text, lang, xPt: existing.xPt, yPt: existing.yPt, size: editingSize, color: [0, 0, 0] });
      else { const ov = it.overlays.find((x) => x.id === existing.id); ov.text = text; ov.lang = lang; ov.size = editingSize; }
    });
  };
  // Attach handlers BEFORE focusing so nothing can prevent commit-on-blur.
  el.addEventListener('blur', finish);
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') el.blur(); });
  showOvTools(el, existing, item, isNew);
  el.focus();
  selectAllText(el);
}

function selectAllText(el) {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch { /* selection is best-effort */ }
}

// Floating size/delete toolbar shown while editing an overlay.
let ovTools = null;
function showOvTools(el, existing, item, isNew) {
  hideOvTools();
  ovTools = document.createElement('div');
  ovTools.className = 'ctx';
  ovTools.style.padding = '0.25rem';
  ovTools.innerHTML = `<div style="display:flex;align-items:center;gap:.3rem;padding:.2rem">
    <button data-a="dec">A−</button><span data-size style="min-width:2rem;text-align:center">${editingSize}</span>
    <button data-a="inc">A+</button><button data-a="del" style="color:var(--danger)">🗑</button></div>`;
  const r = el.getBoundingClientRect();
  ovTools.style.left = `${r.left}px`;
  ovTools.style.top = `${Math.max(8, r.top - 44)}px`;
  document.body.appendChild(ovTools);
  ovTools.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus on text
  ovTools.addEventListener('click', (e) => {
    const a = e.target.dataset.a;
    if (a === 'inc') editingSize = Math.min(96, editingSize + 2);
    else if (a === 'dec') editingSize = Math.max(6, editingSize - 2);
    else if (a === 'del') {
      hideOvTools();
      if (!isNew) commit((s) => { const it = s.pages.find((p) => p.id === item.id); it.overlays = it.overlays.filter((x) => x.id !== existing.id); });
      else el.remove();
      return;
    }
    el.style.fontSize = `${editingSize * currentScale}px`;
    ovTools.querySelector('[data-size]').textContent = editingSize;
  });
}
function hideOvTools() { if (ovTools) { ovTools.remove(); ovTools = null; } }

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------
function onThumbContext(e, id) {
  e.preventDefault();
  const st = getState();
  if (!st.selection.has(id)) { st.selection = new Set([id]); st.currentPageId = id; lastClickedId = id; emit(); }
  ctxTargetId = id;
  const menu = $('ctx');
  menu.hidden = false;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - w - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - h - 8)}px`;
}
document.addEventListener('click', () => { $('ctx').hidden = true; });
document.addEventListener('scroll', () => { $('ctx').hidden = true; }, true);

$('ctx').addEventListener('click', (e) => {
  const act = e.target.dataset?.act;
  if (!act) return;
  $('ctx').hidden = true;
  const ids = targetIds(ctxTargetId);
  ctxAction(act, ids);
});

function ctxAction(act, ids) {
  const idset = new Set(ids);
  switch (act) {
    case 'zoom': openZoom(ctxTargetId); break;
    case 'addtext':
      getState().currentPageId = ctxTargetId; fitMode = true; lastStackSig = null;
      placing = true; $('viewer').classList.add('placing'); emit();
      toast('Click on the page where you want to add text');
      break;
    case 'delete':
      commit((s) => { s.pages = s.pages.filter((p) => !idset.has(p.id)); });
      toast(`Deleted ${ids.length} page${ids.length === 1 ? '' : 's'}`);
      break;
    case 'rotate-cw': rotate(idset, 90); break;
    case 'rotate-ccw': rotate(idset, -90); break;
    case 'duplicate':
      commit((s) => {
        const out = [];
        for (const p of s.pages) {
          out.push(p);
          if (idset.has(p.id)) out.push({ ...structuredClone(p), id: uid('p') });
        }
        s.pages = out;
      });
      toast('Duplicated');
      break;
    case 'blank-after':
      commit((s) => {
        const out = [];
        for (const p of s.pages) {
          out.push(p);
          if (idset.has(p.id)) out.push({ id: uid('p'), kind: 'blank', rotation: 0, width: p.width, height: p.height, overlays: [] });
        }
        s.pages = out;
      });
      toast('Blank page added');
      break;
    case 'insert-before':
    case 'insert-after': {
      const idx = getState().pages.findIndex((p) => p.id === ctxTargetId);
      beginInsertAt(act === 'insert-before' ? idx : idx + 1);
      break;
    }
    case 'extract': extractSelection(ids); break;
  }
}

function rotate(idset, delta) {
  commit((s) => {
    for (const p of s.pages) if (idset.has(p.id)) p.rotation = ((p.rotation + delta) % 360 + 360) % 360;
  });
  lastStackSig = null;
  toast('Rotated');
}

// ---------------------------------------------------------------------------
// Zoom popup
// ---------------------------------------------------------------------------
function openZoom(id) {
  const item = pageById(id);
  if (item) openZoomFor(item, `Page ${getState().pages.indexOf(item) + 1}`);
}

// Render any page item (document or insert-picker page) at a large size.
async function openZoomFor(item, title) {
  $('zoom-title').textContent = title;
  $('zoom-modal').hidden = false;
  const modalW = $('zoom-modal').querySelector('.zoom-body').clientWidth - 32;
  const swap = item.rotation === 90 || item.rotation === 270;
  const dispW = swap ? item.height : item.width;
  const scale = Math.max(0.3, Math.min(3, modalW / dispW));
  await renderPage(item, scale, $('zoom-canvas'));
}
$('zoom-close').addEventListener('click', () => ($('zoom-modal').hidden = true));
$('zoom-modal').addEventListener('click', (e) => { if (e.target === $('zoom-modal')) $('zoom-modal').hidden = true; });

// ---------------------------------------------------------------------------
// Open / insert files
// ---------------------------------------------------------------------------
$('btn-open').addEventListener('click', () => $('file-open').click());
$('file-open').addEventListener('change', async () => {
  const file = $('file-open').files[0];
  $('file-open').value = '';
  if (!file) return;
  if (getState().pages.length && !confirm('Replace the current document? Unsaved changes will be lost.')) return;
  try {
    const { srcId, isPdfA } = await registerSource(file);
    const items = await pageItemsForSource(srcId);
    commit((s) => { s.pages = items; s.docName = file.name; });
    const st = getState();
    st.currentPageId = items[0]?.id ?? null;
    st.selection = new Set();
    lastStackSig = null;
    emit();
    toast(`Opened ${file.name} (${items.length} pages)` + (isPdfA ? ' — PDF/A detected' : ''));
  } catch (err) {
    console.error(err);
    toast('Could not open this PDF. Is it password-protected?', true);
  }
});

// Start an insert at the given page index, then open the file chooser.
function beginInsertAt(index) {
  pendingInsertIndex = index;
  $('file-insert').click();
}

$('file-insert').addEventListener('change', async () => {
  const file = $('file-insert').files[0];
  $('file-insert').value = '';
  if (!file) return;
  try {
    const { srcId } = await registerSource(file);
    openPicker(srcId);
  } catch (err) {
    console.error(err);
    toast('Could not read this PDF.', true);
  }
});

// ---------------------------------------------------------------------------
// Insert picker
// ---------------------------------------------------------------------------
let pickerSrcId = null;
let pickerSel = new Set();
async function openPicker(srcId) {
  pickerSrcId = srcId;
  pickerSel = new Set();
  const src = getState().sources.get(srcId);
  $('insert-src-name').textContent = src.name;
  $('insert-target').textContent = `Inserting at position ${pendingInsertIndex + 1}`;
  $('insert-grid').innerHTML = '';
  $('insert-modal').hidden = false;

  const items = await pageItemsForSource(srcId);
  // Default to all pages selected (user can deselect the ones they don't want).
  items.forEach((_, i) => pickerSel.add(i));
  $('insert-confirm').disabled = pickerSel.size === 0;

  items.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'page-card selected';
    card.dataset.i = i;
    const check = document.createElement('div'); check.className = 'picker-check'; check.textContent = '✓';
    const cw = document.createElement('div'); cw.className = 'page-canvas-wrap';
    const sp = document.createElement('span'); sp.className = 'spinner'; sp.textContent = '…'; cw.appendChild(sp);
    const ft = document.createElement('div'); ft.className = 'page-footer'; ft.textContent = `Page ${i + 1}`;
    // Zoom button (bottom-right): preview the page large without selecting it.
    const zoom = document.createElement('button');
    zoom.className = 'picker-zoom';
    zoom.title = 'View this page larger';
    zoom.textContent = '🔍';
    zoom.addEventListener('click', (e) => {
      e.stopPropagation();
      openZoomFor(item, `Page ${i + 1} — ${src.name}`);
    });
    card.append(check, cw, ft, zoom);
    card.addEventListener('click', () => {
      if (pickerSel.has(i)) { pickerSel.delete(i); card.classList.remove('selected'); check.textContent = ''; }
      else { pickerSel.add(i); card.classList.add('selected'); check.textContent = '✓'; }
      $('insert-confirm').disabled = pickerSel.size === 0;
    });
    $('insert-grid').appendChild(card);
    const canvas = document.createElement('canvas');
    renderPage(item, THUMB_W / item.width, canvas).then(() => cw.replaceChildren(canvas)).catch(() => (sp.textContent = '⚠'));
  });
}
$('insert-select-all').addEventListener('click', () => $('insert-grid').querySelectorAll('.page-card:not(.selected)').forEach((c) => c.click()));
$('insert-select-none').addEventListener('click', () => $('insert-grid').querySelectorAll('.page-card.selected').forEach((c) => c.click()));
$('insert-close').addEventListener('click', () => ($('insert-modal').hidden = true));
$('insert-modal').addEventListener('click', (e) => { if (e.target === $('insert-modal')) $('insert-modal').hidden = true; });
$('insert-confirm').addEventListener('click', async () => {
  const sel = [...pickerSel].sort((a, b) => a - b);
  const all = await pageItemsForSource(pickerSrcId);
  const newPages = sel.map((i) => all[i]);
  const at = pendingInsertIndex ?? getState().pages.length;
  commit((s) => { s.pages.splice(at, 0, ...newPages); });
  $('insert-modal').hidden = true;
  toast(`Inserted ${newPages.length} page${newPages.length === 1 ? '' : 's'}`);
});

// ---------------------------------------------------------------------------
// Drag-to-reorder (with multi-select move)
// ---------------------------------------------------------------------------
new Sortable($('thumbs'), {
  animation: 150, draggable: '.thumb', ghostClass: 'sortable-ghost', forceFallback: true,
  onEnd: (evt) => {
    const st = getState();
    const draggedId = evt.item?.dataset.id;
    const domOrder = [...$('thumbs').children].map((c) => c.dataset.id).filter(Boolean);
    const existing = new Set(st.pages.map((p) => p.id));
    // Safety: only act if the DOM is a clean permutation of the current pages.
    // Otherwise re-render from state — never drop pages from a bad drag event.
    if (!draggedId || domOrder.length !== st.pages.length || !domOrder.every((id) => existing.has(id))) {
      render();
      return;
    }
    const sel = st.selection;
    // If the grabbed page is part of a multi-selection, move the whole set.
    const movingIds = sel.has(draggedId) && sel.size > 1
      ? st.pages.filter((p) => sel.has(p.id)).map((p) => p.id)
      : [draggedId];
    const order = computeReorder(domOrder, draggedId, movingIds);
    if (order.length !== st.pages.length) { render(); return; }
    commit((s) => { s.pages = order.map((id) => s.pages.find((p) => p.id === id)); });
  },
});

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------
$('btn-save').addEventListener('click', () => {
  const st = getState();
  const pn = st.pageNumbering;
  $('pn-enabled').checked = pn.enabled;
  $('pn-position').value = pn.position;
  $('pn-format').value = pn.format;
  $('pn-start').value = pn.start;
  $('pn-options').style.display = pn.enabled ? '' : 'none';
  const pdfa = [...st.sources.values()].find((s) => s.isPdfA);
  const note = $('save-pdfa-note');
  if (pdfa) { note.hidden = false; note.textContent = '⚠ The source is PDF/A. Searchable text is preserved, but the saved file is a standard PDF and will not be PDF/A-conformant.'; }
  else { note.hidden = true; }
  $('save-modal').hidden = false;
});
$('pn-enabled').addEventListener('change', (e) => { $('pn-options').style.display = e.target.checked ? '' : 'none'; });
$('save-close').addEventListener('click', () => ($('save-modal').hidden = true));
$('save-cancel').addEventListener('click', () => ($('save-modal').hidden = true));
$('save-modal').addEventListener('click', (e) => { if (e.target === $('save-modal')) $('save-modal').hidden = true; });

$('save-confirm').addEventListener('click', async () => {
  const st = getState();
  commit((s) => {
    s.pageNumbering = {
      enabled: $('pn-enabled').checked,
      position: $('pn-position').value,
      format: $('pn-format').value,
      start: parseInt($('pn-start').value, 10) || 1,
    };
  });
  $('save-modal').hidden = true;
  $('btn-save').disabled = true;
  try {
    const bytes = await assemble(st.pages, { pageNumbering: st.pageNumbering });
    downloadBytes(bytes, st.docName.replace(/\.pdf$/i, '') + '-edited.pdf');
    toast('Saved');
  } catch (err) {
    console.error(err);
    toast('Failed to save PDF.', true);
  } finally {
    $('btn-save').disabled = st.pages.length === 0;
  }
});

async function extractSelection(ids) {
  const st = getState();
  const items = st.pages.filter((p) => ids.includes(p.id));
  try {
    const bytes = await assemble(items, {});
    downloadBytes(bytes, st.docName.replace(/\.pdf$/i, '') + `-extract-${items.length}p.pdf`);
    toast(`Extracted ${items.length} page${items.length === 1 ? '' : 's'}`);
  } catch (err) { console.error(err); toast('Extract failed.', true); }
}

function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Toolbar misc + keyboard
// ---------------------------------------------------------------------------
$('btn-undo').addEventListener('click', () => { lastStackSig = null; undo(); });
$('btn-redo').addEventListener('click', () => { lastStackSig = null; redo(); });
$('btn-select-all').addEventListener('click', () => setSelection(getState().pages.map((p) => p.id)));

document.addEventListener('keydown', (e) => {
  if (document.activeElement?.isContentEditable) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); lastStackSig = null; undo(); }
  else if (ctrl && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); lastStackSig = null; redo(); }
  else if (ctrl && e.key.toLowerCase() === 'a' && getState().pages.length) { e.preventDefault(); setSelection(getState().pages.map((p) => p.id)); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && getState().selection.size) {
    const ids = new Set(getState().selection);
    commit((s) => { s.pages = s.pages.filter((p) => !ids.has(p.id)); });
  }
});

// Version label (release notes on hover/focus).
$('app-version').textContent = `v${VERSION}`;
$('app-version').title = RELEASE_NOTES;

subscribe(render);
render();
