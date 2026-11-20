import { describe, expect, it } from 'vitest';
import { ACTIONS, Keymap, chordCode, chordDigit, chordOf, formatChord, formatKeys } from './keybinds';

describe('keybind table', () => {
  it('has unique action ids and no chord bound twice in overlapping contexts', () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Keymap().conflicts()).toEqual([]);
  });

  it('never binds a press action to a bare key that is also held in the same context', () => {
    const km = new Keymap();
    for (const a of ACTIONS) {
      if ('hold' in a && a.hold) continue;
      for (const chord of a.keys) {
        if (chord.includes('+')) continue;
        if (a.ctx !== 'possess') expect(km.isHoldKey(chord, 'map'), `${a.id} ${chord} (map)`).toBe(false);
        if (a.ctx !== 'map') expect(km.isHoldKey(chord, 'possess'), `${a.id} ${chord} (possess)`).toBe(false);
      }
    }
  });

  it('covers every binding the design calls for', () => {
    const km = new Keymap();
    expect(km.lookup('KeyF', 'map')).toBe('possess.toggle');
    expect(km.lookup('KeyF', 'possess')).toBe('possess.toggle');
    expect(km.lookup('KeyV', 'possess')).toBe('p.view');
    expect(km.lookup('KeyV', 'map')).toBeNull();
    expect(km.lookup('KeyC', 'map')).toBe('view.cut');
    expect(km.lookup('BracketRight', 'map')).toBe('view.cutFwd');
    expect(km.lookup('KeyP', 'possess')).toBe('view.phero');
    expect(km.lookup('KeyH', 'map')).toBe('cam.home');
    expect(km.lookup('Period', 'map')).toBe('cam.focus');
    expect(km.lookup('Period', 'possess')).toBe('p.next');
    expect(km.lookup('Tab', 'map')).toBe('sel.cycle');
    expect(km.lookup('Tab', 'possess')).toBe('p.next');
    expect(km.lookup('KeyQ', 'possess')).toBe('p.recruit');
    expect(km.lookup('KeyE', 'possess')).toBe('p.pickup');
    expect(km.lookup('KeyR', 'possess')).toBe('p.trail');
    expect(km.lookup('KeyR', 'map')).toBe('tool.erase');
    expect(km.lookup('Digit4', 'map')).toBe('group.recall');
    expect(km.lookup('Ctrl+Digit4', 'map')).toBe('group.assign');
    expect(km.lookup('Space', 'map')).toBe('game.pause');
    expect(km.lookup('Escape', 'possess')).toBe('cancel');
    expect(km.lookup('Shift+Slash', 'map')).toBe('ui.help');
    expect(km.lookup('F1', 'possess')).toBe('ui.help');
  });

  it('polls hold actions by key code, ignoring modifiers', () => {
    const km = new Keymap();
    expect(km.held('cam.forward', new Set(['KeyW']))).toBe(true);
    expect(km.held('cam.forward', new Set(['ArrowUp', 'ShiftLeft']))).toBe(true);
    expect(km.held('cam.forward', new Set(['KeyS']))).toBe(false);
    expect(km.held('p.sprint', new Set(['ShiftRight']))).toBe(true);
    expect(km.isHoldKey('KeyW', 'map')).toBe(true);
    expect(km.isHoldKey('KeyQ', 'possess')).toBe(false);
  });

  it('builds chords from events and formats them for display', () => {
    expect(chordOf({ code: 'KeyA', ctrlKey: true })).toBe('Ctrl+KeyA');
    expect(chordOf({ code: 'Digit3', metaKey: true, shiftKey: true })).toBe('Ctrl+Shift+Digit3');
    expect(chordOf({ code: 'ShiftLeft', shiftKey: true })).toBe('ShiftLeft');
    expect(chordCode('Ctrl+Alt+BracketLeft')).toBe('BracketLeft');
    expect(chordDigit('Ctrl+Digit7')).toBe(7);
    expect(chordDigit('KeyA')).toBe(0);
    expect(formatChord('Ctrl+Digit1')).toBe('Ctrl+1');
    expect(formatChord('Shift+Slash')).toBe('?');
    expect(formatChord('KeyW')).toBe('W');
    expect(formatChord('BracketLeft')).toBe('[');
    expect(formatKeys(new Keymap().keysOf('group.recall'))).toEqual(['1–9']);
    expect(formatKeys(new Keymap().keysOf('group.assign'))).toEqual(['Ctrl+1–9', 'Shift+1–9']);
    expect(formatKeys(['ShiftLeft', 'ShiftRight'])).toEqual(['Shift']);
  });

  it('is rebindable and serialises only the differences', () => {
    const km = new Keymap();
    expect(km.toJSON()).toEqual({});
    km.rebind('cam.home', ['Home']);
    expect(km.lookup('KeyH', 'map')).toBeNull();
    expect(km.lookup('Home', 'map')).toBe('cam.home');
    expect(km.hint('cam.home')).toBe('Home');
    const saved = km.toJSON();
    expect(saved).toEqual({ 'cam.home': ['Home'] });
    const km2 = new Keymap(saved);
    expect(km2.lookup('Home', 'map')).toBe('cam.home');
    km2.rebind('cam.focus', ['Home']);
    expect(km2.conflicts().length).toBe(1);
    km2.reset();
    expect(km2.lookup('KeyH', 'map')).toBe('cam.home');
  });

  it('exposes grouped rows for the help overlay, including mouse bindings', () => {
    const rows = new Keymap().helpRows();
    const all = rows.flatMap((g) => g.rows);
    expect(all.length).toBe(ACTIONS.length);
    expect(all.find((r) => r.id === 'cam.orbit')!.keys).toEqual(['RMB drag']);
    expect(all.find((r) => r.id === 'p.bite')!.keys).toEqual(['LMB']);
    expect(all.every((r) => r.keys.length > 0)).toBe(true);
  });
});
