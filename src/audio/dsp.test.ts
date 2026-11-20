import { describe, expect, it } from 'vitest';
import { BED_IDS, BED_RATE, analyze, brownNoise, makeLoopable, makeRand, normalize, pinkNoise, renderBed, renderChirp, renderClick, renderThud, svf, whiteNoise } from './dsp';

const healthy = (buf: Float32Array, minRms = 0.005): void => {
  const s = analyze(buf);
  expect(s.nan).toBe(0);
  expect(s.peak).toBeLessThanOrEqual(1.0001);
  expect(s.rms).toBeGreaterThan(minRms);
};

describe('audio dsp', () => {
  it('noise colours are non-silent, bounded and deterministic per seed', () => {
    for (const gen of [whiteNoise, pinkNoise, brownNoise]) {
      const a = gen(20000, makeRand(7));
      const b = gen(20000, makeRand(7));
      healthy(a, 0.02);
      expect(Array.from(a.subarray(0, 64))).toEqual(Array.from(b.subarray(0, 64)));
    }
  });

  it('brown noise is darker than white (more energy survives a low-pass)', () => {
    const lowShare = (buf: Float32Array): number => {
      const before = analyze(buf).rms;
      return analyze(svf(buf.slice(), 24000, 'lp', 300)).rms / before;
    };
    expect(lowShare(brownNoise(24000, makeRand(1)))).toBeGreaterThan(lowShare(whiteNoise(24000, makeRand(1))) * 2);
  });

  it('one-shot renderers produce clean buffers', () => {
    healthy(renderChirp(24000, 3000, 4200, 0.08), 0.1);
    healthy(renderClick(24000, 3000, 0.01, makeRand(3)), 0.05);
    healthy(renderThud(24000, 80, 0.25, makeRand(3)), 0.05);
    // envelopes end near silence (no click at the tail)
    const c = renderChirp(24000, 3000, 4200, 0.08);
    expect(Math.abs(c[c.length - 1])).toBeLessThan(0.02);
  });

  it('normalize hits the requested peak and leaves silence alone', () => {
    expect(analyze(normalize(whiteNoise(1000, makeRand(2)), 0.5)).peak).toBeCloseTo(0.5, 5);
    expect(analyze(normalize(new Float32Array(100), 0.5)).peak).toBe(0);
  });

  it('makeLoopable shortens by the fade and joins end to start smoothly', () => {
    const src = brownNoise(4000, makeRand(9));
    const loop = makeLoopable(src, 400);
    expect(loop.length).toBe(3600);
    // the first loop sample continues from the sample that used to precede the tail
    expect(Math.abs(loop[0] - src[3600])).toBeLessThan(1e-5);
  });

  it('every ambience bed is non-silent, non-clipping and NaN-free', () => {
    for (const id of BED_IDS) {
      const bed = renderBed(id, BED_RATE);
      const s = analyze(bed);
      expect(s.nan, id).toBe(0);
      expect(s.peak, id).toBeLessThanOrEqual(0.9001);
      expect(s.peak, id).toBeGreaterThan(0.3);
      expect(s.rms, id).toBeGreaterThan(0.004);
      expect(bed.length / BED_RATE, id).toBeGreaterThan(1.5);
    }
  });
});
