/**
 * HUD root font size (everything in the HUD is sized in `em`). Pure — unit-tested.
 *
 * The automatic size follows the viewport height so the interface keeps roughly the same share of
 * the screen: relative to 720p it is ×1.0 at 720, ×1.35 at 1080 and ×2.0 at 2160 (4K), i.e.
 * 11.5 px at 540 → 13 px at 720 → 17.5 px at 1080 → 26 px at 2160. A narrow window caps it (the
 * bottom bar needs about 80 em of width). `scale` is the player's "Interface size" setting, a
 * multiplier on top of the automatic size (100 % = automatic).
 */
const STOPS: readonly (readonly [number, number])[] = [
  [540, 11.5],
  [720, 13],
  [1080, 17.5],
  [2160, 26],
];
/** Viewport width (px) the bottom bar needs per px of root font size. */
const WIDTH_PER_EM = 80;

export function hudFontPx(viewportH: number, scale = 1, viewportW = Infinity): number {
  let base = STOPS[0][1];
  if (viewportH >= STOPS[STOPS.length - 1][0]) {
    const [h1, p1] = STOPS[STOPS.length - 1];
    const [h0, p0] = STOPS[STOPS.length - 2];
    base = p1 + ((viewportH - h1) / (h1 - h0)) * (p1 - p0);
  } else {
    for (let i = 0; i + 1 < STOPS.length; i++) {
      const [h0, p0] = STOPS[i];
      const [h1, p1] = STOPS[i + 1];
      if (viewportH <= h1) {
        base = p0 + ((viewportH - h0) / (h1 - h0)) * (p1 - p0);
        break;
      }
    }
  }
  if (viewportW > 0 && Number.isFinite(viewportW)) base = Math.min(base, viewportW / WIDTH_PER_EM);
  return Math.round(Math.min(34, Math.max(10.5, base)) * scale * 4) / 4;
}

/** Automatic scale factor relative to the 720p size (for display: "×1.35 at 1080p"). */
export function autoUiScale(viewportH: number): number {
  return hudFontPx(viewportH) / hudFontPx(720);
}
