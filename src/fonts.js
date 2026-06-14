// Hebrew text support for added overlays.
//
// pdf-lib has no text shaping or bidi engine. Standard (built-in) fonts also
// have no Hebrew glyphs, so for Hebrew we embed Noto Sans Hebrew (OFL) via
// fontkit, and we lay out right-to-left ourselves.
import fontkit from '@pdf-lib/fontkit';
import hebRegularUrl from '@expo-google-fonts/noto-sans-hebrew/400Regular/NotoSansHebrew_400Regular.ttf?url';

export { fontkit };

let hebBytesPromise = null;
/** Lazily fetch the embedded Hebrew TTF bytes (cached). */
export function loadHebrewFontBytes() {
  if (!hebBytesPromise) hebBytesPromise = fetch(hebRegularUrl).then((r) => r.arrayBuffer());
  return hebBytesPromise;
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
