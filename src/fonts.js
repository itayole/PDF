// Font support for added text overlays.
//
// Two kinds of fonts are offered:
//  • Latin "standard" fonts — the PDF built-in 14 (Helvetica/Times/Courier).
//    Zero file-size cost, but they have NO Hebrew glyphs.
//  • Hebrew families — embedded TTFs (via fontkit). They carry Latin + digits
//    too, so they can render mixed Hebrew/Latin text.
//
// pdf-lib has no text shaping or bidi engine, so for Hebrew we lay out
// right-to-left ourselves (see splitBidiRuns) and draw each run separately.
import fontkit from '@pdf-lib/fontkit';
import { StandardFonts } from 'pdf-lib';
import hebUrl from '@expo-google-fonts/noto-sans-hebrew/400Regular/NotoSansHebrew_400Regular.ttf?url';
import rubikUrl from '@expo-google-fonts/rubik/400Regular/Rubik_400Regular.ttf?url';
import heeboUrl from '@expo-google-fonts/heebo/400Regular/Heebo_400Regular.ttf?url';
import assistantUrl from '@expo-google-fonts/assistant/400Regular/Assistant_400Regular.ttf?url';
import frankUrl from '@expo-google-fonts/frank-ruhl-libre/400Regular/FrankRuhlLibre_400Regular.ttf?url';

export { fontkit };

// Font catalog. `script:'hebrew'` fonts also render Latin/digits; `script:'latin'`
// (the PDF standard fonts) have no Hebrew glyphs. `standard` = built-in font;
// `url` = embedded TTF; `css` = on-screen preview family; `family` = the
// @font-face name registered for embedded fonts so preview matches output.
export const FONTS = [
  { key: 'helvetica', label: 'Helvetica',   script: 'latin', standard: StandardFonts.Helvetica,  css: 'Helvetica, Arial, sans-serif' },
  { key: 'times',     label: 'Times',       script: 'latin', standard: StandardFonts.TimesRoman, css: '"Times New Roman", Times, serif' },
  { key: 'courier',   label: 'Courier',     script: 'latin', standard: StandardFonts.Courier,    css: '"Courier New", Courier, monospace' },
  { key: 'noto-sans-hebrew', label: 'Noto Sans Hebrew', script: 'hebrew', url: hebUrl,       family: 'Noto Sans Hebrew',  css: '"Noto Sans Hebrew", sans-serif' },
  { key: 'rubik',     label: 'Rubik (רוביק)',         script: 'hebrew', url: rubikUrl,     family: 'Rubik',             css: '"Rubik", sans-serif' },
  { key: 'heebo',     label: 'Heebo (חיבו)',          script: 'hebrew', url: heeboUrl,     family: 'Heebo',             css: '"Heebo", sans-serif' },
  { key: 'assistant', label: 'Assistant (אסיסטנט)',   script: 'hebrew', url: assistantUrl, family: 'Assistant',         css: '"Assistant", sans-serif' },
  { key: 'frank-ruhl', label: 'Frank Ruhl (פרנק רוהל)', script: 'hebrew', url: frankUrl,    family: 'Frank Ruhl Libre',  css: '"Frank Ruhl Libre", serif' },
];

const byKey = new Map(FONTS.map((f) => [f.key, f]));
export const DEFAULT_LATIN = 'helvetica';
export const DEFAULT_HEBREW = 'noto-sans-hebrew';

export const getFont = (key) => byKey.get(key) || byKey.get(DEFAULT_LATIN);

/**
 * Resolve the font an overlay should actually use. Latin standard fonts can't
 * render Hebrew, so Hebrew text falls back to the default Hebrew family — this
 * keeps Hebrew typed with the (default) Latin font working exactly as before.
 * Returns a catalog entry.
 */
export function resolveFont(key, text) {
  const f = getFont(key);
  if (containsHebrew(text) && f.script !== 'hebrew') return byKey.get(DEFAULT_HEBREW);
  return f;
}

// Lazily fetch + cache embedded TTF bytes (for pdf-lib embedding).
const bytesCache = new Map();
export function loadFontBytes(url) {
  if (!bytesCache.has(url)) bytesCache.set(url, fetch(url).then((r) => r.arrayBuffer()));
  return bytesCache.get(url);
}

// Register each embedded font with the browser so the on-screen overlay preview
// matches the saved PDF. Safe to call multiple times; runs once.
let facesRegistered = false;
export function ensureFontFaces() {
  if (facesRegistered || typeof FontFace === 'undefined') return;
  facesRegistered = true;
  for (const f of FONTS) {
    if (!f.url || !f.family) continue;
    try {
      const face = new FontFace(f.family, `url(${f.url})`);
      face.load().then((ff) => document.fonts.add(ff)).catch(() => {});
    } catch { /* preview font is best-effort */ }
  }
}

const HEB = /[֐-׿]/;
export const containsHebrew = (s) => HEB.test(s);

/**
 * Split a logical-order string into maximal directional runs — alternating
 * Hebrew (`heb: true`) and non-Hebrew (Latin / digits / punctuation / spaces).
 *
 * This is the basis of a *simplified* bidi for RTL drawing with pdf-lib, which
 * has no Unicode Bidi Algorithm. The caller lays the runs out right-to-left in
 * logical order and draws each run with its own `drawText`, so fontkit shapes
 * each run in isolation: Hebrew runs reorder to correct visual RTL, while
 * Latin/number runs keep their natural left-to-right order (drawing a mixed
 * string in one call makes fontkit flip the embedded numbers/Latin).
 *
 * Handles plain Hebrew and the practical mixed cases (names, numbers, dates).
 * Complex nested bidi and directional punctuation are not fully resolved.
 */
export function splitBidiRuns(text) {
  const runs = [];
  let cur = '';
  let curHeb = null;
  for (const ch of text) {
    const h = HEB.test(ch);
    if (curHeb === null) { curHeb = h; cur = ch; }
    else if (h === curHeb) { cur += ch; }
    else { runs.push({ heb: curHeb, text: cur }); curHeb = h; cur = ch; }
  }
  if (cur) runs.push({ heb: curHeb, text: cur });
  return runs;
}
