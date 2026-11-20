import { DIFFICULTIES, MAP_IDS, SPECIES_IDS, type Difficulty, type FixtureMode, type GameOptions, type MapId, type QualityPreset, type SpeciesId, type UrlParams } from '../core';

const QUALITIES: readonly QualityPreset[] = ['low', 'medium', 'high', 'ultra'];

/** D21 URL params: map, faction, seed, quality, autostart, shot (+ fixture, ants for the wander fixture). */
export function parseParams(search: string): UrlParams {
  const q = new URLSearchParams(search);
  const pick = <T extends string>(key: string, allowed: readonly T[], def: T): T => {
    const v = q.get(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : def;
  };
  const flag = (key: string, def: boolean): boolean => {
    const v = q.get(key);
    return v === null ? def : v !== '0' && v !== 'false';
  };
  const num = (key: string, def: number): number => {
    const v = Number(q.get(key));
    return q.has(key) && Number.isFinite(v) ? v : def;
  };
  return {
    map: pick<MapId>('map', MAP_IDS, 'meadow'),
    faction: pick<SpeciesId>('faction', SPECIES_IDS, 'gardenAnt'),
    seed: Math.floor(num('seed', 1)),
    quality: pick<QualityPreset>('quality', QUALITIES, 'high'),
    autostart: flag('autostart', true),
    shot: flag('shot', false),
    fixture: pick<FixtureMode>('fixture', ['none', 'wander'], 'none'),
    ants: Math.max(1, Math.min(5000, Math.floor(num('ants', 200)))),
  };
}

/** URL params that mean "boot straight into a map" (tests, `tools/shots.mjs`, deep links). */
const DIRECT_BOOT_KEYS = ['map', 'faction', 'seed', 'autostart', 'shot', 'fixture', 'ants', 'frozen'] as const;

/**
 * App-flow decision (B5): the title menu is shown only when the URL names nothing to start —
 * i.e. none of the D21 params is present — or when `autostart=0` / `menu=1` ask for it explicitly.
 * Any of `map`, `faction`, `seed`, `autostart`, `shot`, `fixture`, `ants`, `frozen` boots directly
 * into the map exactly as before the menu existed.
 */
export function wantsMenu(search: string): boolean {
  const q = new URLSearchParams(search);
  const off = (v: string | null): boolean => v === '0' || v === 'false';
  if (q.has('menu')) return !off(q.get('menu'));
  if (q.has('autostart') && off(q.get('autostart'))) return true;
  return !DIRECT_BOOT_KEYS.some((k) => q.has(k));
}

/** True when the URL fixes the quality preset (it then overrides the saved graphics setting). */
export function urlHasQuality(search: string): boolean {
  return new URLSearchParams(search).has('quality');
}

/**
 * Optional B5 URL params for direct boots: `difficulty`, `mode=sandbox`, `size=small`. Absent keys
 * stay undefined so a plain `?map=…` boot sends nothing extra to the sim.
 */
export function parseGameOptions(search: string): Partial<GameOptions> {
  const q = new URLSearchParams(search);
  const out: Partial<GameOptions> = {};
  const d = q.get('difficulty');
  if (d && (DIFFICULTIES as readonly string[]).includes(d)) out.difficulty = d as Difficulty;
  const m = q.get('mode');
  if (m === 'sandbox' || m === 'goal') out.mode = m;
  const s = q.get('size');
  if (s === 'small' || s === 'standard') out.size = s;
  return out;
}

/** Misc B5 switches: `tutorial=1` forces the onboarding on a direct boot, `attract=0` disables the menu backdrop game. */
export function urlFlag(search: string, key: string): boolean | null {
  const q = new URLSearchParams(search);
  if (!q.has(key)) return null;
  const v = q.get(key);
  return v !== '0' && v !== 'false';
}
