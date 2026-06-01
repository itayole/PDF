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
 * Convert a logical-order string into the visual (left-to-right) order needed
 * to draw RTL text glyph-by-glyph with pdf-lib.
 *
 * Simplified bidi: split into Hebrew vs non-Hebrew runs, reverse the run order
 * (RTL base direction), and reverse the characters within each Hebrew run.
 * Latin/number runs keep their internal order. Good for plain Hebrew and
 * simple mixed text; complex bidi (nested directions) is not fully handled.
 */
export function toVisualRtl(text) {
  const runs = [];
  let cur = '';
  let curHeb = null;
  for (const ch of text) {
    const h = HEB.test(ch);
    if (curHeb === null) { curHeb = h; cur = ch; }
    else if (h === curHeb) { cur += ch; }
    else { runs.push({ h: curHeb, t: cur }); curHeb = h; cur = ch; }
  }
  if (cur) runs.push({ h: curHeb, t: cur });
  runs.reverse();
  return runs.map((r) => (r.h ? [...r.t].reverse().join('') : r.t)).join('');
}
