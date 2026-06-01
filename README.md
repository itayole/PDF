# PDF Page Editor

A privacy-first, browser-based PDF editor with a two-pane workspace:
a **thumbnail rail** on the left and a **full-size page viewer** on the right.
All processing happens **in the browser** (via `pdf-lib` + `pdf.js`); no file is
ever uploaded. The Docker container only serves the static app.

## Features

**Layout**
- Left pane: scrollable page thumbnails (current page highlighted).
- Right pane: **continuous full-size viewer** — every page is stacked vertically,
  so you just scroll from page to page. The current page (indicator + thumbnail
  highlight) follows the scroll position automatically. Pages render lazily as
  they come into view. Prev/next, zoom in/out, and fit-to-width are also there.
- Click a thumbnail to jump (scroll) to that page. Double-click a thumbnail
  (or right-click → *View large*) for an even larger zoom popup.

**Editing** (right-click a thumbnail for the context menu)
- Delete page(s)
- Insert pages from another PDF, before or after the chosen page
- Insert a blank page
- Duplicate page(s)
- Rotate page(s) left/right
- Extract the selected pages into a new PDF

**Organising**
- Drag thumbnails to reorder. Select multiple (Ctrl/Cmd-click, Shift-click for a
  range, or *Select all*) and drag them together.
- Undo / redo (Ctrl+Z / Ctrl+Y), Delete key removes the selection.

**Text overlays** (＋ Text, then click on the page)
- Add text boxes in **English or Hebrew** (language auto-detected). Drag to move,
  double-click to edit, adjust size, delete.
- Hebrew is laid out right-to-left with an embedded Noto Sans Hebrew font.

**Saving**
- Save / download the edited PDF. Page structure, text, and fonts are preserved,
  so a **searchable PDF stays searchable**.
- Optionally stamp **page numbers** (position / format / start value) in the
  final page order.

## Known limitations (by design / technical constraints)

- **PDF/A is not preserved.** If a PDF/A file is opened, a badge warns that the
  saved copy is a standard PDF (searchable text is kept, but PDF/A conformance is
  not). True PDF/A output would require a server-side Ghostscript step.
- **Existing text cannot be edited** — only new text overlays can be added.
  (No PDF library supports reliable in-place text editing.)
- **Hebrew bidi is simplified.** Plain Hebrew and simple mixed text lay out
  correctly; complex bidirectional text (nested Hebrew/Latin/numbers) may not.
- **Text on rotated pages** is placed in the page's coordinate space and will
  rotate with the page — add text before rotating for predictable placement.

## Develop

```bash
npm install
npm run dev      # http://localhost:5300
npm run build    # static site → ./dist
```

## Build & publish the Docker image

```bash
docker build -t ghcr.io/itayole/pdf-editor:latest .
docker tag ghcr.io/itayole/pdf-editor:latest ghcr.io/itayole/pdf-editor:0.1.0
docker push ghcr.io/itayole/pdf-editor:latest
docker push ghcr.io/itayole/pdf-editor:0.1.0
```

## Deploy on QNAP

```bash
docker-compose pull && docker-compose up -d
```

Then open `http://<nas-ip>:8088` (change the host port in `docker-compose.yml`
if 8088 is taken).

## Stack

- [pdf-lib](https://pdf-lib.js.org/) — page copy/assemble, rotation, text, save
- [@pdf-lib/fontkit](https://github.com/Hopding/fontkit) + Noto Sans Hebrew — Hebrew embedding
- [pdf.js](https://mozilla.github.io/pdf.js/) — thumbnail & viewer rendering (worker bundled, no CDN)
- [SortableJS](https://sortablejs.github.io/Sortable/) — drag reorder
- [Vite](https://vitejs.dev/) build → nginx (multi-stage Docker)

## Architecture

- `src/store.js` — state model + undo/redo history + pure `computeReorder`
- `src/pdfio.js` — load/detect, render to canvas, assemble/export
- `src/fonts.js` — Hebrew font loading + RTL layout
- `src/main.js` — two-pane UI, context menu, drag, viewer, overlays, save
