import { describe, expect, it } from 'vitest';
import { autoUiScale, hudFontPx } from './scale';

describe('hudFontPx — HUD size follows the viewport height', () => {
  it('is ×1.0 at 720p, ≈×1.35 at 1080p and ×2 at 4K', () => {
    expect(autoUiScale(720)).toBeCloseTo(1, 5);
    expect(autoUiScale(1080)).toBeCloseTo(1.35, 1);
    expect(autoUiScale(2160)).toBeCloseTo(2, 5);
  });
  it('keeps the tuned 960×540 size and grows monotonically', () => {
    expect(hudFontPx(540)).toBe(11.5);
    let prev = 0;
    for (let h = 400; h <= 3000; h += 40) {
      const px = hudFontPx(h);
      expect(px).toBeGreaterThanOrEqual(prev);
      prev = px;
    }
    expect(prev).toBeLessThanOrEqual(34);
  });
  it("applies the player's interface-size setting as a multiplier", () => {
    expect(hudFontPx(1080, 1.2)).toBeCloseTo(hudFontPx(1080) * 1.2, 0);
    expect(hudFontPx(1080, 0.75)).toBeLessThan(hudFontPx(1080));
  });
  it('a narrow window caps the automatic size', () => {
    expect(hudFontPx(1080, 1, 1920)).toBe(hudFontPx(1080));
    expect(hudFontPx(1080, 1, 1000)).toBe(12.5);
  });
});
