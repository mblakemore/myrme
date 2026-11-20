import { describe, expect, it } from 'vitest';
import { SETTINGS_KEY, SETTINGS_VERSION, SettingsStore, defaultSettings, migrateSettings, type StorageLike } from './settingsStore';

class MemStorage implements StorageLike {
  readonly map = new Map<string, string>();
  fail = false;
  getItem(k: string): string | null {
    if (this.fail) throw new Error('blocked');
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.fail) throw new Error('quota');
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

describe('settings migration', () => {
  it('returns defaults for junk', () => {
    for (const raw of [null, undefined, 42, 'x', [], { version: 'nope' }]) expect(migrateSettings(raw)).toEqual(defaultSettings());
  });

  it('migrates the flat v1 blob', () => {
    const s = migrateSettings({ quality: 'low', volume: 0.3, music: 0.1, invertY: true, sensitivity: 2, keys: { 'cam.home': ['KeyM'] }, tutorialDone: true });
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.graphics.quality).toBe('low');
    expect(s.audio.master).toBe(0.3);
    expect(s.audio.music).toBe(0.1);
    expect(s.audio.sfx).toBe(defaultSettings().audio.sfx);
    expect(s.controls).toEqual({ mouseSensitivity: 2, invertY: true, edgeScroll: false });
    expect(s.keys).toEqual({ 'cam.home': ['KeyM'] });
    expect(s.tutorial.skipped).toBe(true);
    expect(s.tutorial.done.length).toBe(6);
  });

  it('migrates v2 (audio.volume, tutorial list)', () => {
    const s = migrateSettings({ version: 2, audio: { volume: 0.25, sfx: 0.5 }, tutorial: ['camera', 'select'], graphics: { quality: 'ultra', renderScale: 0.75 } });
    expect(s.audio.master).toBe(0.25);
    expect(s.audio.sfx).toBe(0.5);
    expect(s.tutorial).toEqual({ done: ['camera', 'select'], skipped: false, tips: [] });
    expect(s.graphics.quality).toBe('ultra');
    expect(s.graphics.renderScale).toBe(0.75);
  });

  it('clamps and validates every field', () => {
    const s = migrateSettings({
      version: SETTINGS_VERSION,
      graphics: { quality: 'insane', renderScale: 9, dof: 'yes', bloom: false },
      audio: { master: -3, music: 7, muted: 1 },
      controls: { mouseSensitivity: 100 },
      ui: { scale: 0.1 },
      keys: { a: ['KeyA'], b: 'KeyB', c: [1, 2] },
      tutorial: { done: ['x', 'x', 5], tips: 'no' },
      lastGame: { map: 'moon', faction: 'termite', difficulty: 'brutal', mode: 'sandbox', size: 'huge' },
    });
    expect(s.graphics).toEqual({ quality: 'high', renderScale: 1, dof: true, bloom: false, grain: true });
    expect(s.audio.master).toBe(0);
    expect(s.audio.music).toBe(1);
    expect(s.audio.muted).toBe(false);
    expect(s.controls.mouseSensitivity).toBe(3);
    expect(s.ui.scale).toBe(0.75);
    expect(s.keys).toEqual({ a: ['KeyA'] });
    expect(s.tutorial.done).toEqual(['x']);
    expect(s.tutorial.tips).toEqual([]);
    expect(s.lastGame).toEqual({ map: 'meadow', faction: 'termite', size: 'standard', difficulty: 'brutal', mode: 'sandbox' });
  });

  it('is idempotent', () => {
    const once = migrateSettings({ quality: 'medium', volume: 0.4 });
    expect(migrateSettings(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });
});

describe('SettingsStore', () => {
  it('persists patches and reloads them', () => {
    const mem = new MemStorage();
    const a = new SettingsStore(mem);
    a.patch('audio', { master: 0.2 });
    a.patch('graphics', { quality: 'low', renderScale: 0.6 });
    a.set('keys', { 'ui.colony': ['KeyB'] });
    expect(JSON.parse(mem.map.get(SETTINGS_KEY)!).audio.master).toBe(0.2);
    const b = new SettingsStore(mem);
    expect(b.value.audio.master).toBe(0.2);
    expect(b.value.graphics).toMatchObject({ quality: 'low', renderScale: 0.6 });
    expect(b.value.keys).toEqual({ 'ui.colony': ['KeyB'] });
  });

  it('keeps the same value object and notifies listeners with the changed section', () => {
    const s = new SettingsStore(new MemStorage());
    const ref = s.value;
    const seen: string[] = [];
    const off = s.subscribe((_v, c) => seen.push(c));
    s.patch('ui', { scale: 1.25 });
    s.patch('controls', { invertY: true });
    off();
    s.patch('ui', { scale: 1 });
    expect(s.value).toBe(ref);
    expect(ref.ui.scale).toBe(1);
    expect(seen).toEqual(['ui', 'controls']);
  });

  it('clamps patched values', () => {
    const s = new SettingsStore(new MemStorage());
    s.patch('audio', { master: 5 });
    s.patch('graphics', { renderScale: 0.1 });
    expect(s.value.audio.master).toBe(1);
    expect(s.value.graphics.renderScale).toBe(0.5);
  });

  it('survives a throwing or missing storage', () => {
    const mem = new MemStorage();
    mem.fail = true;
    const s = new SettingsStore(mem);
    expect(s.value).toEqual(defaultSettings());
    s.patch('audio', { master: 0.1 });
    expect(s.persisted).toBe(false);
    expect(s.value.audio.master).toBe(0.1);
    const none = new SettingsStore(null);
    none.patch('audio', { sfx: 0.3 });
    expect(none.value.audio.sfx).toBe(0.3);
    expect(none.persisted).toBe(false);
  });

  it('ignores a corrupt blob', () => {
    const mem = new MemStorage();
    mem.map.set(SETTINGS_KEY, '{not json');
    expect(new SettingsStore(mem).value).toEqual(defaultSettings());
  });

  it('reset keeps tutorial progress unless asked', () => {
    const s = new SettingsStore(new MemStorage());
    s.patch('tutorial', { done: ['camera'] });
    s.patch('audio', { master: 0 });
    s.reset();
    expect(s.value.audio.master).toBe(defaultSettings().audio.master);
    expect(s.value.tutorial.done).toEqual(['camera']);
    s.reset(false);
    expect(s.value.tutorial.done).toEqual([]);
  });
});
