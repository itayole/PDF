// PDF I/O: load sources, render pages to canvases, and assemble/export the
// edited document. Everything runs in the browser.
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { fontkit, loadHebrewFontBytes, toVisualRtl, containsHebrew } from './fonts.js';
import { getState, uid } from './store.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
function readFileBytes(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result));
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

async function detectPdfA(pdfjsDoc) {
  try {
    const md = await pdfjsDoc.getMetadata();
    const part = md?.metadata?.get?.('pdfaid:part');
    if (part) {
      const conf = md.metadata.get('pdfaid:conformance') || '';
      return { isPdfA: true, part: `${part}${conf}`.toUpperCase() };
    }
    const raw = md?.metadata?.getRaw?.();
    if (raw && /pdfaid/i.test(raw)) return { isPdfA: true, part: '' };
  } catch { /* metadata is best-effort */ }
  return { isPdfA: false, part: '' };
}

/** Load a PDF File into the store's sources. Returns { srcId, numPages, isPdfA }. */
export async function registerSource(file) {
  const bytes = await readFileBytes(file);
  // pdf.js may detach the buffer it's handed, so give it a copy.
  const pdfjsDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const { isPdfA, part } = await detectPdfA(pdfjsDoc);
  const srcId = uid('s');
  getState().sources.set(srcId, { name: file.name, bytes, pdfjsDoc, isPdfA, pdfaPart: part });
  return { srcId, numPages: pdfjsDoc.numPages, isPdfA, part };
}

/** Build page items for every page of a freshly-registered source. */
export async function pageItemsForSource(srcId) {
  const { pdfjsDoc } = getState().sources.get(srcId);
  const items = [];
  for (let i = 0; i < pdfjsDoc.numPages; i++) {
    const page = await pdfjsDoc.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    items.push({
      id: uid('p'), kind: 'pdf', srcId, srcPageIndex: i,
      rotation: 0, width: vp.width, height: vp.height, overlays: [],
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
/**
 * Render a page item into `canvas` at the given scale. Returns a coordinate
 * mapper so callers can translate between canvas (CSS px, top-left origin) and
 * unrotated PDF points (bottom-left origin) — used for placing text overlays.
 */
export async function renderPage(item, scale, canvas) {
  const dpr = window.devicePixelRatio || 1;

  if (item.kind === 'blank') {
    // Rotation of a blank only swaps display dimensions.
    const swap = item.rotation === 90 || item.rotation === 270;
    const cssW = (swap ? item.height : item.width) * scale;
    const cssH = (swap ? item.width : item.height) * scale;
    sizeCanvas(canvas, cssW, cssH, dpr);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cssW, cssH);
    return blankMapper(item, scale, cssW, cssH);
  }

  const { pdfjsDoc } = getState().sources.get(item.srcId);
  const page = await pdfjsDoc.getPage(item.srcPageIndex + 1);
  const rotation = (page.rotate + item.rotation) % 360;
  const viewport = page.getViewport({ scale, rotation });
  sizeCanvas(canvas, viewport.width, viewport.height, dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return {
    cssWidth: viewport.width,
    cssHeight: viewport.height,
    toPdfPoint: (x, y) => { const [px, py] = viewport.convertToPdfPoint(x, y); return { x: px, y: py }; },
    toViewportPoint: (x, y) => { const [vx, vy] = viewport.convertToViewportPoint(x, y); return { x: vx, y: vy }; },
  };
}

function sizeCanvas(canvas, cssW, cssH, dpr) {
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
}

// Coordinate mapper for blank pages (rotation 0 is exact; rotated blanks are
// approximated — text is rarely added to blank rotated pages).
function blankMapper(item, scale, cssW, cssH) {
  return {
    cssWidth: cssW,
    cssHeight: cssH,
    toPdfPoint: (x, y) => ({ x: x / scale, y: item.height - y / scale }),
    toViewportPoint: (x, y) => ({ x: x * scale, y: (item.height - y) * scale }),
  };
}

// ---------------------------------------------------------------------------
// Assembly / export
// ---------------------------------------------------------------------------
function drawOverlay(page, o, fonts) {
  const color = rgb(...(o.color || [0, 0, 0]));
  const baselineY = o.yPt - o.size * 0.8; // o.yPt is the text's top edge
  if (o.lang === 'he') {
    const visual = toVisualRtl(o.text);
    const w = fonts.heb.widthOfTextAtSize(visual, o.size);
    page.drawText(visual, { x: o.xPt - w, y: baselineY, size: o.size, font: fonts.heb, color });
  } else {
    page.drawText(o.text, { x: o.xPt, y: baselineY, size: o.size, font: fonts.helv, color });
  }
}

function stampPageNumbers(out, cfg, font) {
  const pages = out.getPages();
  const total = pages.length;
  const size = 11;
  const m = 28;
  pages.forEach((page, i) => {
    const num = cfg.start + i;
    const label = cfg.format === 'n-total' ? `${num} / ${total}`
      : cfg.format === 'page-n' ? `Page ${num}` : `${num}`;
    const { width, height } = page.getSize();
    const w = font.widthOfTextAtSize(label, size);
    const top = cfg.position.startsWith('top');
    const y = top ? height - m : m - size * 0.3;
    let x;
    if (cfg.position.endsWith('left')) x = m;
    else if (cfg.position.endsWith('right')) x = width - w - m;
    else x = (width - w) / 2;
    page.drawText(label, { x, y, size, font, color: rgb(0.1, 0.12, 0.18) });
  });
}

/** Assemble the given ordered page items into a new PDF; returns bytes. */
export async function assemble(pageItems, { pageNumbering } = {}) {
  const sources = getState().sources;
  const out = await PDFDocument.create();

  const helv = await out.embedFont(StandardFonts.Helvetica);
  let heb = null;
  const needHeb = pageItems.some((p) => (p.overlays || []).some((o) => o.lang === 'he' || containsHebrew(o.text)));
  if (needHeb) {
    out.registerFontkit(fontkit);
    heb = await out.embedFont(await loadHebrewFontBytes());
  }
  const fonts = { helv, heb };

  const loaded = new Map(); // srcId -> PDFDocument (loaded once)
  for (const item of pageItems) {
    let page;
    if (item.kind === 'blank') {
      page = out.addPage([item.width, item.height]);
    } else {
      if (!loaded.has(item.srcId)) {
        loaded.set(item.srcId, await PDFDocument.load(sources.get(item.srcId).bytes.slice()));
      }
      const [copied] = await out.copyPages(loaded.get(item.srcId), [item.srcPageIndex]);
      page = out.addPage(copied);
    }
    if (item.rotation) {
      const cur = page.getRotation().angle;
      page.setRotation(degrees((cur + item.rotation) % 360));
    }
    for (const o of item.overlays || []) drawOverlay(page, o, fonts);
  }

  if (pageNumbering?.enabled) stampPageNumbers(out, pageNumbering, helv);
  return out.save();
}
