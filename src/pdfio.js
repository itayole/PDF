// PDF I/O: load sources, render pages to canvases, and assemble/export the
// edited document. Everything runs in the browser.
import {
  PDFDocument, StandardFonts, degrees, rgb,
  PDFName, PDFDict, PDFRawStream, PDFArray,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
} from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { fontkit, loadFontBytes, resolveFont, splitBidiRuns, containsHebrew } from './fonts.js';
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

/** True if any page carries an interactive form-field (Widget) annotation. */
async function detectFormWidgets(pdfjsDoc) {
  for (let i = 1; i <= pdfjsDoc.numPages; i++) {
    const page = await pdfjsDoc.getPage(i);
    const anns = await page.getAnnotations();
    if (anns.some((a) => a.subtype === 'Widget')) return true;
  }
  return false;
}

/** Load a PDF File into the store's sources. Returns { srcId, numPages, isPdfA }. */
export async function registerSource(file) {
  const bytes = await readFileBytes(file);
  // pdf.js may detach the buffer it's handed, so give it a copy.
  const pdfjsDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const { isPdfA, part } = await detectPdfA(pdfjsDoc);
  const hasWidgets = await detectFormWidgets(pdfjsDoc);
  const srcId = uid('s');
  getState().sources.set(srcId, { name: file.name, bytes, pdfjsDoc, isPdfA, pdfaPart: part, hasWidgets });
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
      rotation: 0, width: vp.width, height: vp.height, overlays: [], patches: [],
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

  // Serialise renders of the same source page: pdf.js drops/garbles content
  // when one PDFPageProxy is rendered to two canvases at once (thumbnail +
  // viewer, or a re-render burst on resize).
  return lockPage(`${item.srcId}:${item.srcPageIndex}`, () => renderPdfPage(item, scale, canvas, dpr));
}

// Per-page promise chain so same-page renders run one at a time.
const pageChains = new Map();
function lockPage(key, fn) {
  const run = (pageChains.get(key) || Promise.resolve()).then(fn, fn);
  pageChains.set(key, run.then(() => {}, () => {}));
  return run;
}

async function renderPdfPage(item, scale, canvas, dpr) {
  const { pdfjsDoc } = getState().sources.get(item.srcId);
  const page = await pdfjsDoc.getPage(item.srcPageIndex + 1);

  // Fitted page: scale the source content (incl. baked rotation) to fit a
  // target page size, centered, with white margins. Fitted pages keep
  // item.rotation = 0 — any rotation is folded into fitRot + swapped fitW/fitH.
  if (item.fitW) {
    const srcRot = (page.rotate + (item.fitRot || 0)) % 360;
    const base = page.getViewport({ scale: 1, rotation: srcRot }); // rotated source dims
    const contentScale = Math.min(item.fitW / base.width, item.fitH / base.height);
    const vp = page.getViewport({ scale: scale * contentScale, rotation: srcRot });
    const cssW = item.fitW * scale;
    const cssH = item.fitH * scale;
    sizeCanvas(canvas, cssW, cssH, dpr);
    const ctx = canvas.getContext('2d');
    // dpr scale + centering offset on the context; render with no extra param
    // (same proven path as below). White-fill the margins first.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.translate((cssW - vp.width) / 2, (cssH - vp.height) / 2);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return {
      cssWidth: cssW,
      cssHeight: cssH,
      toPdfPoint: (x, y) => ({ x: x / scale, y: item.fitH - y / scale }),
      toViewportPoint: (x, y) => ({ x: x * scale, y: (item.fitH - y) * scale }),
    };
  }

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
function drawOverlay(page, o, pdfFont) {
  const color = rgb(...(o.color || [0, 0, 0]));
  const baselineY = o.yPt - o.size * 0.8; // o.yPt is the text's top edge
  if (containsHebrew(o.text)) {
    // Simplified bidi for RTL overlays. fontkit reorders a Hebrew run to correct
    // visual order on its own, but drawing a *mixed* Hebrew+Latin/digit string in
    // one call makes it flip the embedded numbers/Latin (no full bidi engine).
    // So split into directional runs and lay them out right-to-left in logical
    // order, drawing each run separately — fontkit then shapes each in isolation.
    // The resolved font is Hebrew-capable (carries Latin+digit glyphs too).
    let x = o.xPt; // right edge; runs are placed leftward from here
    for (const run of splitBidiRuns(o.text)) {
      const w = pdfFont.widthOfTextAtSize(run.text, o.size);
      x -= w;
      page.drawText(run.text, { x, y: baselineY, size: o.size, font: pdfFont, color });
    }
  } else {
    page.drawText(o.text, { x: o.xPt, y: baselineY, size: o.size, font: pdfFont, color });
  }
}

// Draw an opaque "cover" rectangle over an area of existing page content, so
// new text overlays can be placed on top. Stored in unrotated PDF point space
// (same convention as overlays): xPt/yPt is the rectangle's top-left corner.
// NOTE: this only hides content visually — the underlying text remains in the
// file and is still selectable/extractable (this is a cover, not redaction).
function drawPatch(page, p) {
  page.drawRectangle({
    x: p.xPt,
    y: p.yPt - p.hPt,
    width: p.wPt,
    height: p.hPt,
    color: rgb(...(p.color || [1, 1, 1])),
  });
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

// Draw a source page scaled to fit a target-size page, centered, preserving
// aspect ratio (white margins). Mirrors the on-screen fit render.
async function drawFittedPage(out, srcDoc, item) {
  const emb = await out.embedPage(srcDoc.getPage(item.srcPageIndex));
  const page = out.addPage([item.fitW, item.fitH]);
  const srcRotate = srcDoc.getPage(item.srcPageIndex).getRotation().angle;
  const Rtot = (((srcRotate + (item.fitRot || 0)) % 360) + 360) % 360;
  const ew = emb.width, eh = emb.height;
  const visW = (Rtot === 90 || Rtot === 270) ? eh : ew;
  const visH = (Rtot === 90 || Rtot === 270) ? ew : eh;
  const s = Math.min(item.fitW / visW, item.fitH / visH);
  const drawnW = visW * s, drawnH = visH * s;
  const left = (item.fitW - drawnW) / 2;
  const bottom = (item.fitH - drawnH) / 2;
  // pdf.js renders /Rotate clockwise; pdf-lib rotates counter-clockwise, so the
  // pdf-lib angle is (360 - Rtot). Anchor point shifts per quadrant.
  let x = left, y = bottom;
  if (Rtot === 90) { x = left + drawnW; }
  else if (Rtot === 180) { x = left + drawnW; y = bottom + drawnH; }
  else if (Rtot === 270) { y = bottom + drawnH; }
  page.drawPage(emb, { x, y, xScale: s, yScale: s, rotate: degrees((360 - Rtot) % 360) });
  return page;
}

// Annotation flag bits (PDF 32000-1, 12.5.3) we must honour when baking.
const F_HIDDEN = 1 << 1; // bit 2
const F_NOVIEW = 1 << 5; // bit 6

/**
 * Flatten a page's interactive form-field widgets into its content stream so
 * added text overlays (drawn afterwards) are no longer painted over by the
 * widgets' opaque appearances. Interactive forms render widget annotations on
 * top of page content; without this, overlays land *under* the white field
 * boxes and appear missing or faint.
 *
 * For each /Widget annotation we draw its normal appearance (AP /N) as a Form
 * XObject mapped from the appearance BBox (×Matrix) onto the annotation Rect
 * per PDF 32000-1 §12.5.5, then drop the widget from the annotation array.
 * Returns the number of widgets baked.
 */
function flattenWidgets(page, context) {
  const annots = page.node.Annots && page.node.Annots();
  if (!annots || !annots.asArray) return 0;
  const refs = annots.asArray().slice();
  const kept = [];
  let baked = 0;

  for (const ref of refs) {
    const a = context.lookup(ref);
    if (!(a instanceof PDFDict) || a.get(PDFName.of('Subtype'))?.toString() !== '/Widget') {
      kept.push(ref);
      continue;
    }
    // From here on the widget is consumed (baked or dropped) — never kept,
    // so it can't paint over the overlays.
    const ap = a.lookupMaybe(PDFName.of('AP'), PDFDict);
    const rectObj = a.lookup(PDFName.of('Rect'), PDFArray);
    if (!ap || !rectObj) continue;

    const flags = Number(a.lookup(PDFName.of('F'))?.asNumber?.() ?? 0);
    if (flags & (F_HIDDEN | F_NOVIEW)) continue; // not visible → just drop it

    // /N may be the appearance stream directly, or a sub-dictionary of states
    // keyed by the widget's current /AS (e.g. checkboxes).
    let nObj = ap.lookup(PDFName.of('N'));
    if (nObj instanceof PDFDict && !(nObj instanceof PDFRawStream)) {
      const as = a.get(PDFName.of('AS'));
      nObj = as ? context.lookup(nObj.get(as)) : undefined;
    }
    if (!(nObj instanceof PDFRawStream)) continue;
    const nRef = ap.get(PDFName.of('N')) instanceof PDFRawStream ? null : ap.get(PDFName.of('N'));
    // Resolve a reference we can put in the XObject resource dict.
    const xobjRef = nRef && !(nRef instanceof PDFRawStream) ? nRef : context.register(nObj);

    const num = (o) => (o && o.asNumber ? o.asNumber() : 0);
    const rect = rectObj.asArray().map(num);
    const bboxObj = nObj.dict.lookup(PDFName.of('BBox'), PDFArray);
    const bbox = bboxObj ? bboxObj.asArray().map(num) : [0, 0, rect[2] - rect[0], rect[3] - rect[1]];
    const mObj = nObj.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray);
    const m = mObj ? mObj.asArray().map(num) : [1, 0, 0, 1, 0, 0];

    // Transform the appearance BBox corners by its Matrix, take the bounds.
    const corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]]
      .map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    const tx0 = Math.min(...xs), ty0 = Math.min(...ys), tx1 = Math.max(...xs), ty1 = Math.max(...ys);
    const rx0 = Math.min(rect[0], rect[2]), ry0 = Math.min(rect[1], rect[3]);
    const rx1 = Math.max(rect[0], rect[2]), ry1 = Math.max(rect[1], rect[3]);
    const sx = (tx1 - tx0) === 0 ? 1 : (rx1 - rx0) / (tx1 - tx0);
    const sy = (ty1 - ty0) === 0 ? 1 : (ry1 - ry0) / (ty1 - ty0);
    // Matrix A maps the (Matrix-transformed) BBox onto Rect; the Do operator
    // applies the XObject's own /Matrix internally, so we emit only A here.
    const e = rx0 - sx * tx0;
    const f = ry0 - sy * ty0;

    const name = `Flt${baked}`;
    let res = page.node.Resources();
    if (!res) { res = context.obj({}); page.node.set(PDFName.of('Resources'), res); }
    let xdict = res.lookup(PDFName.of('XObject'), PDFDict);
    if (!xdict) { xdict = context.obj({}); res.set(PDFName.of('XObject'), xdict); }
    xdict.set(PDFName.of(name), xobjRef);

    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(sx, 0, 0, sy, e, f),
      drawObject(name),
      popGraphicsState(),
    );
    baked++;
  }

  const newArr = PDFArray.withContext(context);
  kept.forEach((r) => newArr.push(r));
  page.node.set(PDFName.of('Annots'), newArr);
  return baked;
}

/** Assemble the given ordered page items into a new PDF; returns bytes. */
export async function assemble(pageItems, { pageNumbering, flattenForms = true } = {}) {
  const sources = getState().sources;
  const out = await PDFDocument.create();

  out.registerFontkit(fontkit);
  const helv = await out.embedFont(StandardFonts.Helvetica); // page numbers

  // Embed each overlay font on demand, once. Keyed by the resolved catalog key
  // (Hebrew text picked with a Latin font resolves to the default Hebrew font).
  const embedded = new Map([['helvetica', helv]]);
  const fontForOverlay = async (o) => {
    const f = resolveFont(o.font, o.text);
    if (!embedded.has(f.key)) {
      // Subset embedded fonts: only the glyphs actually used are written into
      // the output, which keeps saved PDFs small even though the full TTF is
      // bundled in the app. (Standard base-14 fonts aren't embedded at all.)
      embedded.set(f.key, f.standard ? await out.embedFont(f.standard)
        : await out.embedFont(await loadFontBytes(f.url), { subset: true }));
    }
    return embedded.get(f.key);
  };

  const loaded = new Map(); // srcId -> PDFDocument (loaded once)
  const loadSrc = async (srcId) => {
    if (!loaded.has(srcId)) loaded.set(srcId, await PDFDocument.load(sources.get(srcId).bytes.slice()));
    return loaded.get(srcId);
  };

  for (const item of pageItems) {
    let page;
    if (item.kind === 'blank') {
      page = out.addPage([item.width, item.height]);
    } else if (item.fitW) {
      page = await drawFittedPage(out, await loadSrc(item.srcId), item);
    } else {
      const [copied] = await out.copyPages(await loadSrc(item.srcId), [item.srcPageIndex]);
      page = out.addPage(copied);
    }
    if (item.rotation) {
      const cur = page.getRotation().angle;
      page.setRotation(degrees((cur + item.rotation) % 360));
    }
    // Bake interactive form-field widgets into the page first, so overlays draw
    // on top of (not under) the form's opaque field boxes. No-op for pages
    // without widgets (blank pages, fitted pages whose annotations weren't copied).
    if (flattenForms) flattenWidgets(page, out.context);
    // Patches first (cover existing content), then text overlays on top of them.
    for (const p of item.patches || []) drawPatch(page, p);
    for (const o of item.overlays || []) drawOverlay(page, o, await fontForOverlay(o));
  }

  if (pageNumbering?.enabled) stampPageNumbers(out, pageNumbering, helv);
  return out.save();
}
