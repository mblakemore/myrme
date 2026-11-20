import { describe, expect, it } from 'vitest';
import { VoiceAllocator, distanceGain, type VoiceRequest } from './voices';

const req = (over: Partial<VoiceRequest> = {}): VoiceRequest => ({ id: 'dig', bus: 'sfx', priority: 2, dist: 5, maxDist: 60, duration: 1, ...over });

describe('voice allocator', () => {
  it('culls by distance and counts it', () => {
    const a = new VoiceAllocator();
    const r = a.request(req({ dist: 80 }), 0);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('culled');
    expect(a.culled).toBe(1);
    expect(a.count()).toBe(0);
  });

  it('rate-limits a sound id but not other ids', () => {
    const a = new VoiceAllocator();
    expect(a.request(req(), 0, 0.1).ok).toBe(true);
    const again = a.request(req(), 0.05, 0.1);
    expect(!again.ok && again.reason).toBe('rate');
    expect(a.request(req({ id: 'bite' }), 0.05, 0.1).ok).toBe(true);
    expect(a.request(req(), 0.2, 0.1).ok).toBe(true);
    expect(a.rateLimited).toBe(1);
  });

  it('never exceeds the per-bus cap and keeps buses independent', () => {
    const a = new VoiceAllocator({ ambience: 2, sfx: 4, music: 2, ui: 2 });
    for (let i = 0; i < 50; i++) a.request(req({ id: `s${i}` }), i * 0.001);
    expect(a.count('sfx')).toBe(4);
    expect(a.stolen).toBeGreaterThan(0);
    expect(a.request(req({ bus: 'ui', id: 'ui.click', maxDist: Infinity, dist: 0 }), 0.1).ok).toBe(true);
    expect(a.count('ui')).toBe(1);
    expect(a.count()).toBe(5);
  });

  it('a high-priority sound steals the least valuable voice; a low one is refused', () => {
    const stolen: number[] = [];
    const a = new VoiceAllocator({ ambience: 1, sfx: 3, music: 1, ui: 1 }, (h) => stolen.push(h));
    const far = a.request(req({ id: 'a', priority: 2, dist: 55 }), 0);
    a.request(req({ id: 'b', priority: 2, dist: 3 }), 0);
    a.request(req({ id: 'c', priority: 6, dist: 3 }), 0);
    const low = a.request(req({ id: 'd', priority: 1, dist: 3 }), 0.01);
    expect(!low.ok && low.reason).toBe('full');
    const high = a.request(req({ id: 'e', priority: 9, dist: 20 }), 0.02);
    expect(high.ok).toBe(true);
    expect(stolen).toEqual([far.handle]); // lowest priority, farthest
    expect(a.count('sfx')).toBe(3);
  });

  it('expires finished voices and frees their slots', () => {
    const a = new VoiceAllocator({ ambience: 1, sfx: 2, music: 1, ui: 1 });
    const v1 = a.request(req({ id: 'a', duration: 0.5 }), 0);
    a.request(req({ id: 'b', duration: 2 }), 0);
    expect(a.expire(0.4)).toEqual([]);
    expect(a.expire(0.6)).toEqual([v1.handle]);
    expect(a.count('sfx')).toBe(1);
    expect(a.request(req({ id: 'c' }), 0.7).ok).toBe(true);
  });

  it('clear(bus) drops only that bus', () => {
    const a = new VoiceAllocator();
    a.request(req(), 0);
    a.request(req({ bus: 'ui', id: 'ui.click' }), 0);
    expect(a.clear('sfx').length).toBe(1);
    expect(a.count('ui')).toBe(1);
    expect(a.clear().length).toBe(1);
  });

  it('distanceGain falls with distance and reaches zero at the cull range', () => {
    expect(distanceGain(0, 8, 60)).toBe(1);
    expect(distanceGain(8, 8, 60)).toBeCloseTo(0.5, 5);
    expect(distanceGain(30, 8, 60)).toBeLessThan(distanceGain(10, 8, 60));
    expect(distanceGain(60, 8, 60)).toBe(0);
    expect(distanceGain(59.9, 8, 60)).toBeLessThan(0.01);
  });
});
