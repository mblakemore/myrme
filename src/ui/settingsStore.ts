/**
 * Persistent player settings (PLAN §5.4 "Menu: … quality", B5 item 6). Pure logic — no DOM: the
 * storage backend is injected (`localStorage` in the page, a Map-backed fake in unit tests) and
 * every access is wrapped in try/catch (private windows, blocked site data).
 *
 * The stored blob is versioned; `migrateSettings` accepts anything (older versions, partial or
 * corrupt data) and always returns a complete, clamped `Settings`.
 */
import { DIFFICULTIES, MAP_IDS, SPECIES_IDS, type AudioVolumes, type Difficulty, type GameMode, type MapId, type MapSize, type QualityPreset, type SpeciesId } from '../core';

export const SETTINGS_VERSION = 3;
export const SETTINGS_KEY = 'myrme.settings';

export interface GraphicsSettings {
  quality: QualityPreset;
  /** Render resolution multiplier 0.5..1 (applied on top of the preset's pixel-ratio cap). */
  renderScale: number;
  dof: boolean;
  bloom: boolean;
  grain: boolean;
}

export interface AudioSettings extends AudioVolumes {
  muted: boolean;
  musicEnabled: boolean;
}

export interface ControlSettings {
  mouseSensitivity: number;
  invertY: boolean;
  edgeScroll: boolean;
}

export interface TutorialProgress {
  /** Completed onboarding step ids. */
  done: string[];
  skipped: boolean;
  /** Contextual first-time tips already shown. */
  tips: string[];
}

export interface LastGame {
  map: MapId;
  faction: SpeciesId;
  size: MapSize;
  difficulty: Difficulty;
  mode: GameMode;
}

export interface Settings {
  version: number;
  graphics: GraphicsSettings;
  audio: AudioSettings;
  controls: ControlSettings;
  ui: { scale: number; reducedMotion: boolean; hints: boolean };
  /** Keymap overrides (`Keymap.toJSON()` — only bindings that differ from the defaults). */
  keys: Record<string, string[]>;
  tutorial: TutorialProgress;
  lastGame: LastGame;
}

export const QUALITY_IDS: readonly QualityPreset[] = ['low', 'medium', 'high', 'ultra'];

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    graphics: { quality: 'high', renderScale: 1, dof: true, bloom: true, grain: true },
    audio: { master: 0.6, ambience: 0.7, sfx: 0.7, music: 0.5, muted: false, musicEnabled: true },
    controls: { mouseSensitivity: 1, invertY: false, edgeScroll: false },
    ui: { scale: 1, reducedMotion: false, hints: true },
    keys: {},
    tutorial: { done: [], skipped: false, tips: [] },
    lastGame: { map: 'meadow', faction: 'gardenAnt', size: 'standard', difficulty: 'normal', mode: 'goal' },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, def: number, min: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def);
const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], def: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : def);
const strList = (v: unknown, max = 64): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))].slice(0, max) : []);

/**
 * Bring any stored value up to the current schema.
 *  v1 (flat): `{ quality, volume, music, sfx, invertY, edgeScroll, sensitivity, keys, tutorialDone }`
 *  v2: nested like v3 but `audio.volume` instead of `audio.master`, no `ui.hints`, no `lastGame`,
 *      `tutorial` was a plain list of done step ids.
 */
export function migrateSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (!isObj(raw)) return d;
  let src = raw;
  const version = typeof raw.version === 'number' ? raw.version : 1;
  if (version <= 1) {
    // v1 → v3 shape
    src = {
      graphics: { quality: raw.quality },
      audio: { master: raw.volume, music: raw.music, sfx: raw.sfx },
      controls: { invertY: raw.invertY, edgeScroll: raw.edgeScroll, mouseSensitivity: raw.sensitivity },
      keys: raw.keys,
      tutorial: { done: raw.tutorialDone === true ? ['camera', 'select', 'order', 'dig', 'possess', 'colony'] : [], skipped: raw.tutorialDone === true },
    };
  } else if (version === 2) {
    const a = isObj(raw.audio) ? raw.audio : {};
    src = { ...raw, audio: { ...a, master: a.master ?? a.volume }, tutorial: Array.isArray(raw.tutorial) ? { done: raw.tutorial } : raw.tutorial };
  }

  const g = isObj(src.graphics) ? src.graphics : {};
  const a = isObj(src.audio) ? src.audio : {};
  const c = isObj(src.controls) ? src.controls : {};
  const u = isObj(src.ui) ? src.ui : {};
  const t = isObj(src.tutorial) ? src.tutorial : {};
  const l = isObj(src.lastGame) ? src.lastGame : {};

  const keys: Record<string, string[]> = {};
  if (isObj(src.keys)) {
    for (const [id, list] of Object.entries(src.keys)) {
      if (Array.isArray(list) && list.every((k) => typeof k === 'string') && list.length <= 24) keys[id] = list.map(String);
    }
  }

  return {
    version: SETTINGS_VERSION,
    graphics: {
      quality: oneOf(g.quality, QUALITY_IDS, d.graphics.quality),
      renderScale: num(g.renderScale, d.graphics.renderScale, 0.5, 1),
      dof: bool(g.dof, d.graphics.dof),
      bloom: bool(g.bloom, d.graphics.bloom),
      grain: bool(g.grain, d.graphics.grain),
    },
    audio: {
      master: num(a.master, d.audio.master, 0, 1),
      ambience: num(a.ambience, d.audio.ambience, 0, 1),
      sfx: num(a.sfx, d.audio.sfx, 0, 1),
      music: num(a.music, d.audio.music, 0, 1),
      muted: bool(a.muted, d.audio.muted),
      musicEnabled: bool(a.musicEnabled, d.audio.musicEnabled),
    },
    controls: {
      mouseSensitivity: num(c.mouseSensitivity, d.controls.mouseSensitivity, 0.2, 3),
      invertY: bool(c.invertY, d.controls.invertY),
      edgeScroll: bool(c.edgeScroll, d.controls.edgeScroll),
    },
    ui: { scale: num(u.scale, d.ui.scale, 0.75, 1.5), reducedMotion: bool(u.reducedMotion, d.ui.reducedMotion), hints: bool(u.hints, d.ui.hints) },
    keys,
    tutorial: { done: strList(t.done), skipped: bool(t.skipped, false), tips: strList(t.tips) },
    lastGame: {
      map: oneOf(l.map, MAP_IDS, d.lastGame.map),
      faction: oneOf(l.faction, SPECIES_IDS, d.lastGame.faction),
      size: oneOf(l.size, ['small', 'standard'] as const, d.lastGame.size),
      difficulty: oneOf(l.difficulty, DIFFICULTIES, d.lastGame.difficulty),
      mode: oneOf(l.mode, ['goal', 'sandbox'] as const, d.lastGame.mode),
    },
  };
}

/** The subset of the Web Storage API the store needs. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type SettingsListener = (settings: Settings, changed: keyof Settings | 'all') => void;

/**
 * Live settings + persistence. `value` is one mutable object for the lifetime of the store (so
 * panels can hold a reference); mutate it through `update` / `patch` so listeners run and the
 * blob is saved.
 */
export class SettingsStore {
  readonly value: Settings;
  private readonly listeners = new Set<SettingsListener>();
  /** False when the last save failed (storage blocked / full). */
  persisted = true;

  constructor(
    private readonly storage: StorageLike | null,
    private readonly key = SETTINGS_KEY,
  ) {
    this.value = migrateSettings(this.read());
  }

  private read(): unknown {
    try {
      const s = this.storage?.getItem(this.key);
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  }

  save(): void {
    try {
      this.storage?.setItem(this.key, JSON.stringify(this.value));
      this.persisted = !!this.storage;
    } catch {
      this.persisted = false;
    }
  }

  /** Shallow-merge into one section, re-validate, save, notify. */
  patch<K extends Exclude<keyof Settings, 'version'>>(section: K, partial: Partial<Settings[K]>): void {
    const next = migrateSettings({ ...this.value, [section]: { ...(this.value[section] as object), ...(partial as object) } });
    (this.value as unknown as Record<string, unknown>)[section] = next[section];
    this.save();
    this.emit(section);
  }

  /** Replace one section wholesale (keymap overrides). */
  set<K extends Exclude<keyof Settings, 'version'>>(section: K, value: Settings[K]): void {
    const next = migrateSettings({ ...this.value, [section]: value });
    (this.value as unknown as Record<string, unknown>)[section] = next[section];
    this.save();
    this.emit(section);
  }

  /** Back to defaults (optionally keeping tutorial progress). */
  reset(keepProgress = true): void {
    const d = defaultSettings();
    if (keepProgress) d.tutorial = this.value.tutorial;
    Object.assign(this.value, d);
    this.save();
    this.emit('all');
  }

  subscribe(fn: SettingsListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(changed: keyof Settings | 'all'): void {
    for (const fn of [...this.listeners]) fn(this.value, changed);
  }
}

/** `localStorage`, or null when it is unavailable / throws on access. */
export function browserStorage(): StorageLike | null {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const probe = '__myrme_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

let shared: SettingsStore | null = null;
/** The page-wide store (created on first use). */
export function getSettings(): SettingsStore {
  return (shared ??= new SettingsStore(browserStorage()));
}
