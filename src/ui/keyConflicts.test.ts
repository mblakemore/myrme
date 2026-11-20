import { describe, expect, it } from 'vitest';
import { Keymap } from '../input/keybinds';
import { assignKey, clearKey, findConflicts, isRebindable, rebindableActions, resetKey, unboundActions } from './keyConflicts';

describe('key rebinding conflicts', () => {
  it('the default keymap has no conflicts for its own bindings', () => {
    const km = new Keymap();
    for (const def of rebindableActions()) for (const k of km.keysOf(def.id as never)) expect(findConflicts(km, def.id as never, k), `${def.id} ${k}`).toEqual([]);
  });

  it('digit-range actions are fixed', () => {
    const km = new Keymap();
    expect(isRebindable(km.def('group.recall'))).toBe(false);
    expect(isRebindable(km.def('group.assign'))).toBe(false);
    expect(isRebindable(km.def('cam.zoom'))).toBe(false); // mouse only
    expect(isRebindable(km.def('ui.colony'))).toBe(true);
  });

  it('detects a press/press collision in an overlapping context', () => {
    const km = new Keymap();
    // KeyB = dig brush (map); colony panel is `any`
    const c = findConflicts(km, 'ui.colony', 'KeyB');
    expect(c.map((x) => x.id)).toEqual(['tool.dig']);
  });

  it('map and possess contexts do not collide', () => {
    const km = new Keymap();
    // KeyV = first/third person (possess only): free in the map context
    expect(findConflicts(km, 'tool.dig', 'KeyV')).toEqual([]);
    // …but not for an `any` action
    expect(findConflicts(km, 'ui.colony', 'KeyV').map((x) => x.id)).toEqual(['p.view']);
  });

  it('hold actions collide on the bare key code, with press actions only without modifiers', () => {
    const km = new Keymap();
    // KeyW is held for cam.forward (map) and p.forward (possess)
    expect(findConflicts(km, 'tool.dig', 'KeyW').map((x) => x.id)).toEqual(['cam.forward']);
    expect(findConflicts(km, 'tool.dig', 'Ctrl+KeyW')).toEqual([]);
    // binding a hold action onto a press key
    expect(findConflicts(km, 'cam.forward', 'KeyB').map((x) => x.id)).toEqual(['tool.dig']);
    // hold vs hold ignores modifiers
    expect(findConflicts(km, 'cam.rotateLeft', 'Shift+KeyW').map((x) => x.id)).toEqual(['cam.forward']);
  });

  it('assign without steal leaves everything untouched on conflict', () => {
    const km = new Keymap();
    const before = JSON.stringify(km.toJSON());
    const c = assignKey(km, 'ui.colony', 0, 'KeyB', false);
    expect(c.length).toBe(1);
    expect(JSON.stringify(km.toJSON())).toBe(before);
  });

  it('assign with steal unbinds the other action and stays conflict free', () => {
    const km = new Keymap();
    assignKey(km, 'ui.colony', 0, 'KeyB', true);
    expect(km.keysOf('ui.colony')).toEqual(['KeyB']);
    expect(km.keysOf('tool.dig')).toEqual([]);
    expect(km.conflicts()).toEqual([]);
    expect(km.lookup('KeyB', 'map')).toBe('ui.colony');
    expect(unboundActions(km).map((d) => d.id)).toEqual(['tool.dig']);
  });

  it('assigns into a second slot and de-duplicates within the action', () => {
    const km = new Keymap();
    assignKey(km, 'ui.colony', 1, 'F6', false);
    expect(km.keysOf('ui.colony')).toEqual(['KeyL', 'F6']);
    assignKey(km, 'ui.colony', 0, 'F6', false);
    expect(km.keysOf('ui.colony')).toEqual(['F6']);
  });

  it('clear and reset', () => {
    const km = new Keymap();
    clearKey(km, 'ui.help', 0);
    expect(km.keysOf('ui.help')).toEqual(['Shift+Slash']);
    assignKey(km, 'ui.colony', 0, 'KeyB', true);
    // resetting dig brings KeyB back and reports the clash with the colony panel
    const c = resetKey(km, 'tool.dig');
    expect(c.map((x) => x.id)).toEqual(['ui.colony']);
    expect(km.toJSON()).toEqual({ 'ui.colony': ['KeyB'], 'ui.help': ['Shift+Slash'] });
  });

  it('round-trips through toJSON / load', () => {
    const km = new Keymap();
    assignKey(km, 'cam.home', 0, 'KeyM', false);
    const km2 = new Keymap(km.toJSON());
    expect(km2.keysOf('cam.home')).toEqual(['KeyM']);
    expect(km2.lookup('KeyM', 'map')).toBe('cam.home');
    expect(km2.lookup('KeyH', 'map')).toBeNull();
  });
});
