import { describe, expect, it } from 'vitest';
import { LAYER_IDS, closenessOf, computeMix, dayFactor, muffleCutoff, volumeGain, type MixInput } from './mix';

const base = (over: Partial<MixInput> = {}): MixInput => ({
  scene: 'game',
  biome: 'meadow',
  timeOfDay: 0.5,
  weather: 'clear',
  intensity: 0,
  wind: 1,
  underground: 0,
  possess: false,
  firstPerson: false,
  focusDist: 30,
  lampOn: false,
  flood: 0,
  nearbyAnts: 10,
  ...over,
});
const mix = (over: Partial<MixInput> = {}) => computeMix(base(over));

describe('ambience mix', () => {
  it('all layers stay within 0..1 across a sweep of states', () => {
    for (const biome of ['meadow', 'forest', 'desert', 'farm'] as const)
      for (const weather of ['clear', 'rain', 'storm', 'wind', 'heat', 'cold', 'cloudy'] as const)
        for (const tod of [0, 0.25, 0.5, 0.8])
          for (const underground of [0, 1]) {
            const m = mix({ biome, weather, intensity: 1, timeOfDay: tod, underground, possess: underground === 1, firstPerson: true, wind: 9, flood: 1, nearbyAnts: 200, lampOn: true });
            for (const id of LAYER_IDS) {
              expect(m.layers[id], `${biome}/${weather}/${id}`).toBeGreaterThanOrEqual(0);
              expect(m.layers[id], `${biome}/${weather}/${id}`).toBeLessThanOrEqual(1);
              expect(Number.isFinite(m.layers[id])).toBe(true);
            }
            expect(m.muffle).toBeLessThanOrEqual(1);
          }
  });

  it('meadow day: breeze, birds and insects; no crickets', () => {
    const m = mix();
    expect(m.layers.breeze).toBeGreaterThan(0.2);
    expect(m.layers.birds).toBeGreaterThan(0.2);
    expect(m.layers.insects).toBeGreaterThan(0.1);
    expect(m.layers.crickets).toBe(0);
    expect(m.layers.roomTone).toBe(0);
  });

  it('night: crickets up, birds down', () => {
    const day = mix();
    const night = mix({ timeOfDay: 0.02 });
    expect(night.layers.crickets).toBeGreaterThan(0.3);
    expect(night.layers.birds).toBeLessThan(0.01);
    expect(night.layers.nightWind).toBeGreaterThan(day.layers.nightWind);
    expect(dayFactor(0.5)).toBe(1);
    expect(dayFactor(0)).toBe(0);
  });

  it('rain layer follows intensity and silences birds', () => {
    const dry = mix();
    const light = mix({ weather: 'rain', intensity: 0.3 });
    const heavy = mix({ weather: 'rain', intensity: 1 });
    expect(dry.layers.rain).toBe(0);
    expect(dry.rain).toBe(0);
    expect(light.layers.rain).toBeGreaterThan(0.05);
    expect(heavy.layers.rain).toBeGreaterThan(light.layers.rain * 2);
    expect(heavy.rain).toBeGreaterThan(light.rain);
    expect(heavy.layers.birds).toBeLessThan(dry.layers.birds * 0.2);
    expect(mix({ weather: 'storm', intensity: 0.2 }).layers.rain).toBeGreaterThan(light.layers.rain);
  });

  it('close-up rain adds the giant-drop bed; underground muffles it away', () => {
    const far = mix({ weather: 'rain', intensity: 1, focusDist: 48 });
    const close = mix({ weather: 'rain', intensity: 1, possess: true, firstPerson: true, focusDist: 2 });
    const below = mix({ weather: 'rain', intensity: 1, possess: true, firstPerson: true, focusDist: 2, underground: 1 });
    expect(close.layers.rainClose).toBeGreaterThan(far.layers.rainClose + 0.3);
    expect(below.layers.rainClose).toBe(0);
    expect(below.layers.rain).toBeLessThan(close.layers.rain);
    expect(below.rain).toBeLessThan(close.rain);
  });

  it('underground: muffle up, outdoor beds down, rumble and skitter up', () => {
    const above = mix({ possess: true, focusDist: 3 });
    const below = mix({ possess: true, focusDist: 3, underground: 1 });
    expect(above.muffle).toBe(0);
    expect(below.muffle).toBeGreaterThan(0.7);
    expect(below.layers.underground).toBeGreaterThan(0.4);
    expect(below.layers.birds).toBeLessThan(above.layers.birds * 0.3);
    expect(below.layers.breeze).toBeLessThan(above.layers.breeze * 0.3);
    expect(below.layers.skitter).toBeGreaterThan(above.layers.skitter);
    expect(muffleCutoff(below.muffle)).toBeLessThan(1500);
    expect(muffleCutoff(0)).toBe(18000);
  });

  it('biomes pick their own beds', () => {
    expect(mix({ biome: 'forest' }).layers.forest).toBeGreaterThan(0.3);
    expect(mix({ biome: 'desert' }).layers.desertWind).toBeGreaterThan(0.3);
    expect(mix({ biome: 'desert' }).layers.birds).toBe(0);
    const farm = mix({ biome: 'farm', lampOn: true });
    expect(farm.layers.roomTone).toBeGreaterThan(0.3);
    expect(farm.layers.clockTick).toBeGreaterThan(0.1);
    expect(farm.layers.lampHum).toBeGreaterThan(0.2);
    expect(farm.layers.breeze + farm.layers.birds + farm.layers.gusts).toBe(0);
    expect(mix({ biome: 'farm' }).layers.lampHum).toBe(0);
    // rain on a farm is only heard through the window
    expect(mix({ biome: 'farm', weather: 'rain', intensity: 1 }).layers.rain).toBeLessThan(mix({ weather: 'rain', intensity: 1 }).layers.rain * 0.4);
  });

  it('wind raises gusts; flood bed follows the flood amount', () => {
    expect(mix({ wind: 8 }).layers.gusts).toBeGreaterThan(mix({ wind: 0 }).layers.gusts + 0.2);
    expect(mix({ weather: 'wind', intensity: 1, wind: 0 }).layers.gusts).toBeGreaterThan(0.3);
    expect(mix({ flood: 1, underground: 1, possess: true }).layers.flood).toBeGreaterThan(0.5);
    expect(mix().layers.flood).toBe(0);
  });

  it('scene gates the world: menu is quieter and never muffled, loading/silent are mute', () => {
    const game = mix({ underground: 1 });
    const menu = mix({ scene: 'menu', underground: 1 });
    expect(menu.muffle).toBe(0);
    expect(menu.layers.underground).toBeLessThan(game.layers.underground);
    expect(menu.layers.underground).toBeGreaterThan(0);
    for (const scene of ['loading', 'silent'] as const) {
      const m = mix({ scene, weather: 'storm', intensity: 1 });
      for (const id of LAYER_IDS) expect(m.layers[id]).toBe(0);
      expect(m.rain).toBe(0);
    }
  });

  it('closeness: zoom, possession, first person', () => {
    expect(closenessOf(60, false, false)).toBe(0);
    expect(closenessOf(4, false, false)).toBeGreaterThan(0.8);
    expect(closenessOf(30, true, false)).toBeGreaterThanOrEqual(0.8);
    expect(closenessOf(30, true, true)).toBe(1);
  });

  it('volume curve is monotonic and clamped', () => {
    expect(volumeGain(0)).toBe(0);
    expect(volumeGain(1)).toBe(1);
    expect(volumeGain(2)).toBe(1);
    expect(volumeGain(0.5)).toBeLessThan(0.5);
  });
});
