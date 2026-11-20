/**
 * Pure ambience mix math: listening state → target gain per ambience bed, world muffle and
 * closeness. No WebAudio (unit-tested in node); `ambience.ts` crossfades the real gains towards
 * these targets.
 */
import type { AmbienceLayerId, AudioScene, WeatherKind } from '../core';

export type Biome = 'meadow' | 'forest' | 'desert' | 'farm';

export interface MixInput {
  scene: AudioScene;
  biome: Biome;
  /** 0..1, 0 = midnight, 0.5 = noon. */
  timeOfDay: number;
  weather: WeatherKind;
  /** 0..1 strength of the weather kind. */
  intensity: number;
  /** Horizontal wind speed, units/s. */
  wind: number;
  /** 0 = listening in open air … 1 = under a roof (nest gallery). */
  underground: number;
  possess: boolean;
  firstPerson: boolean;
  /** Camera → focus distance (zoom). */
  focusDist: number;
  lampOn: boolean;
  /** 0..1 flooding near the listener. */
  flood: number;
  /** Ants within earshot of the listening point. */
  nearbyAnts: number;
}

export interface MixOutput {
  layers: Record<AmbienceLayerId, number>;
  muffle: number;
  closeness: number;
  rain: number;
}

export const LAYER_IDS: readonly AmbienceLayerId[] = ['breeze', 'birds', 'insects', 'crickets', 'nightWind', 'forest', 'desertWind', 'underground', 'skitter', 'roomTone', 'clockTick', 'lampHum', 'rain', 'rainClose', 'gusts', 'flood'];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** 1 in full daylight, 0 at night, soft dawn / dusk. */
export function dayFactor(timeOfDay: number): number {
  const t = ((timeOfDay % 1) + 1) % 1;
  return smooth(0.2, 0.3, t) * (1 - smooth(0.72, 0.82, t));
}

/** 0 = far overview … 1 = ant-scale. Possession is always close; first person is closest. */
export function closenessOf(focusDist: number, possess: boolean, firstPerson: boolean): number {
  const zoom = clamp01(1 - (focusDist - 4) / 44);
  if (possess) return firstPerson ? 1 : Math.max(0.8, zoom);
  return zoom * 0.85;
}

export function emptyLayers(): Record<AmbienceLayerId, number> {
  const out = {} as Record<AmbienceLayerId, number>;
  for (const id of LAYER_IDS) out[id] = 0;
  return out;
}

export function computeMix(s: MixInput, out: MixOutput = { layers: emptyLayers(), muffle: 0, closeness: 0, rain: 0 }): MixOutput {
  const L = out.layers;
  for (const id of LAYER_IDS) L[id] = 0;
  const sceneGain = s.scene === 'game' ? 1 : s.scene === 'menu' ? 0.45 : 0;
  const closeness = closenessOf(s.focusDist, s.possess, s.firstPerson);
  const under = clamp01(s.underground);
  const day = dayFactor(s.timeOfDay);
  const night = 1 - day;
  const farm = s.biome === 'farm';
  // how much of the open-air world still reaches the listener
  const open = farm ? 0 : 1 - under * 0.85;
  const I = clamp01(s.intensity);
  const wet = s.weather === 'storm' ? Math.max(0.75, I) : s.weather === 'rain' ? Math.max(0.15, I) : 0;
  // farms sit indoors: rain is something heard through the window
  const rain = wet * (farm ? 0.25 : 1);
  const dry = 1 - clamp01(rain * 1.4);
  const windy = clamp01(s.wind / 6 + (s.weather === 'wind' ? 0.3 + I * 0.6 : 0) + (s.weather === 'storm' ? 0.5 : 0));
  const hot = s.weather === 'heat' ? 1 + I * 0.5 : s.weather === 'cold' ? 0.4 : 1;

  if (s.biome === 'meadow') {
    L.breeze = (0.3 + 0.25 * day + 0.3 * windy) * open;
    L.birds = 0.45 * day * dry * open;
    L.insects = 0.28 * day * dry * hot * open;
    L.crickets = 0.5 * night * (1 - rain * 0.7) * open;
    L.nightWind = 0.35 * night * open;
  } else if (s.biome === 'forest') {
    L.forest = (0.5 + 0.2 * windy) * open;
    L.breeze = 0.2 * open;
    L.birds = 0.3 * day * dry * open;
    L.insects = 0.34 * (0.5 + 0.5 * day) * dry * hot * open;
    L.crickets = 0.4 * night * (1 - rain * 0.7) * open;
    L.nightWind = 0.2 * night * open;
  } else if (s.biome === 'desert') {
    L.desertWind = (0.4 + 0.4 * windy) * open;
    L.insects = 0.1 * day * hot * open;
    L.crickets = 0.2 * night * open;
    L.nightWind = 0.4 * night * open;
  } else {
    L.roomTone = 0.4;
    L.clockTick = 0.24 * (1 - closeness * 0.5);
    L.lampHum = s.lampOn ? 0.3 : 0;
  }
  L.gusts = farm ? 0 : clamp01(windy) * 0.6 * open;
  L.underground = farm ? 0.25 * closeness + 0.45 * under : 0.6 * under;
  L.skitter = clamp01(closeness * 1.2) * clamp01(s.nearbyAnts / 18) * (0.3 + 0.5 * under) * 0.9;
  L.rain = rain * (1 - under * 0.6) * (1 - closeness * 0.35) * 0.8;
  L.rainClose = farm ? 0 : rain * closeness * (1 - under) * 0.7;
  L.flood = clamp01(s.flood) * (0.3 + 0.7 * under) * 0.7;

  for (const id of LAYER_IDS) L[id] = clamp01(L[id] * sceneGain);
  out.closeness = closeness;
  // the menu backdrop is always heard "from outside"
  out.muffle = s.scene === 'game' ? under * 0.9 : 0;
  out.rain = clamp01(rain * (1 - under * 0.5) * sceneGain);
  return out;
}

/** World low-pass cutoff for a muffle amount: 18 kHz in the open → ~500 Hz deep underground. */
export function muffleCutoff(muffle: number): number {
  return 18000 * Math.pow(0.028, clamp01(muffle));
}

/** Perceptual volume curve for the 0..1 sliders. */
export function volumeGain(v: number): number {
  const c = clamp01(v);
  return c * c;
}
