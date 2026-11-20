/**
 * Settings screen (B5 item 6): graphics, audio, controls, key rebinding, interface. One builder
 * used both inside the main menu and in the in-game pause flow (as a HUD modal). Everything goes
 * through the `SettingsStore` — the Game / app shell subscribe to it and apply changes live
 * (quality preset, render scale, DoF / bloom / grain, UI scale, volumes, input options, keymap).
 */
import type { AudioLayerB5, QualityPreset } from '../core';
import { KEY_GROUPS, Keymap, chordOf, formatChord, type ActionDef, type ActionId } from '../input/keybinds';
import { Disposer, h, setClass, setText } from './dom';
import { icon } from './icons';
import { KEY_SLOTS, assignKey, clearKey, findConflicts, rebindableActions, resetKey, unboundActions, type BindingConflict } from './keyConflicts';
import { QUALITY_IDS, type SettingsStore } from './settingsStore';

export type SettingsTab = 'graphics' | 'audio' | 'controls' | 'keys' | 'game';
const TABS: readonly { id: SettingsTab; label: string }[] = [
  { id: 'graphics', label: 'Graphics' },
  { id: 'audio', label: 'Audio' },
  { id: 'controls', label: 'Controls' },
  { id: 'keys', label: 'Keys' },
  { id: 'game', label: 'Interface' },
];

const QUALITY_NOTE: Record<QualityPreset, string> = {
  low: 'No shadows or post effects. For integrated graphics.',
  medium: 'Shadows and ambient occlusion, lighter effects.',
  high: 'Full pipeline: depth of field, bloom, light shafts.',
  ultra: 'Sharper shadows and effects at full resolution.',
};

const MODIFIERS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

export interface SettingsPanelDeps {
  store: SettingsStore;
  audio: AudioLayerB5 | null;
  close(): void;
  initialTab?: string;
  /** The URL fixed the quality preset for this session (`?quality=`): show it, do not offer it. */
  qualityLocked?: QualityPreset | null;
  /** Restart the onboarding hints (in game). */
  onReplayTutorial?: (() => void) | null;
}

export interface SettingsPanel {
  readonly el: HTMLElement;
  /** True while a key slot waits for a key press (the host must not treat Esc as "close"). */
  isCapturing(): boolean;
  setTab(tab: SettingsTab): void;
  dispose(): void;
}

export function buildSettingsPanel(deps: SettingsPanelDeps): SettingsPanel {
  const { store } = deps;
  const d = new Disposer();
  const s = store.value;
  const blip = (kind: 'tick' | 'toggle' | 'click' | 'error' | 'confirm' = 'tick'): void => deps.audio?.ui(kind);

  // ---- row builders ----------------------------------------------------------------------
  const row = (label: string, control: Node, note?: string): HTMLElement =>
    h('div', 'ms-set-row', null, [h('div', 'ms-set-label', null, [h('span', undefined, null, label), note ? h('small', undefined, null, note) : null]), h('div', 'ms-set-control', null, [control])]);

  function slider(testid: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, onInput: (v: number) => void): HTMLElement {
    const input = h('input', undefined, { type: 'range', min, max, step, value, testid });
    const out = h('output', undefined, null, fmt(value));
    const paint = (): void => {
      const v = Number(input.value);
      input.style.setProperty('--fill', `${(((v - min) / (max - min)) * 100).toFixed(1)}%`);
      setText(out, fmt(v));
    };
    paint();
    d.on(input, 'input', () => {
      paint();
      onInput(Number(input.value));
    });
    d.on(input, 'change', () => input.blur());
    d.on(input, 'keydown', (e: KeyboardEvent) => e.stopPropagation());
    return h('div', 'ms-slider', null, [input, out]);
  }

  function toggle(testid: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
    const input = h('input', undefined, { type: 'checkbox', testid, role: 'switch' });
    input.checked = value;
    d.on(input, 'change', () => {
      blip('toggle');
      onChange(input.checked);
      input.blur();
    });
    return h('label', 'ms-switch', null, [input, h('i')]);
  }

  function segmented<T extends string>(prefix: string, options: readonly { id: T; label: string }[], value: T, onPick: (v: T) => void, disabled = false): { el: HTMLElement; set(v: T): void } {
    const btns = new Map<T, HTMLButtonElement>();
    const el = h('div', 'ms-seg', { role: 'radiogroup' });
    const set = (v: T): void => {
      for (const [id, b] of btns) {
        setClass(b, 'mh-on', id === v);
        b.setAttribute('aria-checked', String(id === v));
      }
    };
    for (const o of options) {
      const b = h('button', 'mh-btn', { type: 'button', role: 'radio', testid: `${prefix}-${o.id}` }, o.label);
      b.disabled = disabled;
      d.on(b, 'click', () => {
        blip('click');
        set(o.id);
        onPick(o.id);
        b.blur();
      });
      btns.set(o.id, b);
      el.append(b);
    }
    set(value);
    return { el, set };
  }

  const pct = (v: number): string => `${Math.round(v * 100)}%`;

  // ---- graphics --------------------------------------------------------------------------------
  const locked = deps.qualityLocked ?? null;
  const qNote = h('small', 'ms-set-note', null, QUALITY_NOTE[locked ?? s.graphics.quality]);
  const quality = segmented(
    'set-quality',
    QUALITY_IDS.map((id) => ({ id, label: id === 'medium' ? 'Medium' : id[0].toUpperCase() + id.slice(1) })),
    locked ?? s.graphics.quality,
    (v) => {
      setText(qNote, QUALITY_NOTE[v]);
      store.patch('graphics', { quality: v });
    },
    !!locked,
  );
  const graphics = h('div', 'ms-set-page', null, [
    row('Quality', h('div', 'ms-col', null, [quality.el, qNote]), locked ? 'Fixed by the page address for this session.' : 'Applies immediately. Scenery density updates on the next map.'),
    row(
      'Render scale',
      slider('set-render-scale', 0.5, 1, 0.05, s.graphics.renderScale, pct, (v) => store.patch('graphics', { renderScale: v })),
      'Lower it for more speed.',
    ),
    row(
      'Depth of field',
      toggle('set-dof', s.graphics.dof, (v) => store.patch('graphics', { dof: v })),
      'Macro-lens blur. Medium quality and up.',
    ),
    row(
      'Bloom',
      toggle('set-bloom', s.graphics.bloom, (v) => store.patch('graphics', { bloom: v })),
    ),
    row(
      'Film grain',
      toggle('set-grain', s.graphics.grain, (v) => store.patch('graphics', { grain: v })),
    ),
  ]);

  // ---- audio ----------------------------------------------------------------------------------
  let lastBlip = 0;
  const vol = (key: 'master' | 'ambience' | 'sfx' | 'music', label: string, note?: string): HTMLElement =>
    row(
      label,
      slider(`set-vol-${key}`, 0, 1, 0.01, s.audio[key], pct, (v) => {
        store.patch('audio', { [key]: v });
        const now = performance.now();
        if (key !== 'music' && key !== 'ambience' && now - lastBlip > 120) {
          lastBlip = now;
          blip('tick');
        }
      }),
      note,
    );
  const audio = h('div', 'ms-set-page', null, [
    vol('master', 'Master volume'),
    vol('ambience', 'Ambience', 'Wind, rain, crickets, the room around the farm.'),
    vol('sfx', 'Effects', 'Footsteps, digging, bites, alerts.'),
    vol('music', 'Music'),
    row(
      'Adaptive music',
      toggle('set-music-on', s.audio.musicEnabled, (v) => store.patch('audio', { musicEnabled: v })),
      'A quiet generative score that follows the colony.',
    ),
    row(
      'Mute everything',
      toggle('set-muted', s.audio.muted, (v) => store.patch('audio', { muted: v })),
    ),
  ]);

  // ---- controls ---------------------------------------------------------------------------------
  const controls = h('div', 'ms-set-page', null, [
    row(
      'Mouse sensitivity',
      slider('set-sensitivity', 0.2, 3, 0.05, s.controls.mouseSensitivity, (v) => `${v.toFixed(2)}×`, (v) => store.patch('controls', { mouseSensitivity: v })),
      'Looking around while possessing an ant.',
    ),
    row(
      'Invert mouse Y',
      toggle('set-invert-y', s.controls.invertY, (v) => store.patch('controls', { invertY: v })),
    ),
    row(
      'Edge scrolling',
      toggle('set-edge-scroll', s.controls.edgeScroll, (v) => store.patch('controls', { edgeScroll: v })),
      'Pan the camera when the cursor touches the screen edge.',
    ),
  ]);

  // ---- interface ----------------------------------------------------------------------------------
  const replay = h('button', 'mh-btn', { type: 'button', testid: 'set-replay-tutorial' }, 'Replay the tutorial');
  d.on(replay, 'click', () => {
    blip('confirm');
    store.patch('tutorial', { done: [], skipped: false });
    deps.onReplayTutorial?.();
    setText(replay, 'Tutorial restarted');
    replay.blur();
  });
  const resetAll = h('button', 'mh-btn ms-danger', { type: 'button', testid: 'set-reset-all' }, 'Reset all settings');
  let armed = false;
  d.on(resetAll, 'click', () => {
    if (!armed) {
      armed = true;
      setText(resetAll, 'Click again to reset');
      return;
    }
    store.reset(true);
    blip('confirm');
    deps.close();
  });
  const game = h('div', 'ms-set-page', null, [
    row(
      'Interface size',
      slider('set-ui-scale', 0.75, 1.5, 0.05, s.ui.scale, pct, (v) => store.patch('ui', { scale: v })),
      '100% follows your screen height automatically.',
    ),
    row(
      'Hints and tips',
      toggle('set-hints', s.ui.hints, (v) => store.patch('ui', { hints: v })),
      'Onboarding steps and first-time tips.',
    ),
    row(
      'Reduce motion',
      toggle('set-reduced-motion', s.ui.reducedMotion, (v) => store.patch('ui', { reducedMotion: v })),
      'Calms menu and interface animation. Your system preference is always respected.',
    ),
    row('Tutorial', replay),
    row('Defaults', resetAll, 'Keeps your tutorial progress.'),
  ]);

  // ---- keys ----------------------------------------------------------------------------------------
  const keymap = new Keymap(s.keys);
  const slotBtns = new Map<string, HTMLButtonElement>();
  const rowEls = new Map<string, HTMLElement>();
  const keysNote = h('div', 'ms-keys-note', { testid: 'keys-note' });
  const conflictBox = h('div', 'ms-key-conflict mh-hidden', { testid: 'key-conflict', role: 'alert' });
  let capture: { id: ActionId; slot: number; mod: string | null } | null = null;
  let pending: { id: ActionId; slot: number; chord: string; conflicts: BindingConflict[] } | null = null;

  const commitKeys = (): void => {
    store.set('keys', keymap.toJSON());
  };

  function paintKeys(): void {
    for (const def of rebindableActions()) {
      const keys = keymap.keysOf(def.id as ActionId);
      for (let i = 0; i < KEY_SLOTS; i++) {
        const b = slotBtns.get(`${def.id}:${i}`)!;
        const capturing = capture?.id === def.id && capture.slot === i;
        setText(b, capturing ? 'Press a key…' : keys[i] ? formatChord(keys[i]) : i === 0 ? 'Unbound' : '+');
        setClass(b, 'ms-capturing', capturing);
        setClass(b, 'ms-empty', !keys[i] && !capturing);
        setClass(b, 'ms-unbound', i === 0 && !keys[i] && !capturing);
      }
      const custom = keys.length !== def.keys.length || keys.some((k, i) => k !== def.keys[i]);
      setClass(rowEls.get(def.id)!, 'ms-custom', custom);
    }
    const missing = unboundActions(keymap);
    setText(keysNote, missing.length ? `No key: ${missing.map((m) => m.label).join(' · ')}` : 'Click a key to change it. Esc cancels, Delete clears. Mouse buttons and group numbers are fixed.');
    setClass(keysNote, 'ms-warn', missing.length > 0);
  }

  function showConflict(): void {
    setClass(conflictBox, 'mh-hidden', !pending);
    if (!pending) return;
    const p = pending;
    const replace = h('button', 'mh-btn mh-on', { type: 'button', testid: 'key-conflict-replace' }, 'Replace');
    const cancel = h('button', 'mh-btn', { type: 'button', testid: 'key-conflict-cancel' }, 'Keep both as they were');
    replace.addEventListener('click', () => {
      assignKey(keymap, p.id, p.slot, p.chord, true);
      pending = null;
      blip('confirm');
      commitKeys();
      showConflict();
      paintKeys();
    });
    cancel.addEventListener('click', () => {
      pending = null;
      showConflict();
      paintKeys();
    });
    conflictBox.replaceChildren(
      icon('warn'),
      h('span', 'mh-grow', null, [h('span', 'mh-kbd', null, formatChord(p.chord)), ` is already used by ${p.conflicts.map((c) => `“${c.label}”`).join(' and ')}.`]),
      replace,
      cancel,
    );
  }

  function tryAssign(id: ActionId, slot: number, chord: string): void {
    const conflicts = findConflicts(keymap, id, chord);
    if (conflicts.length) {
      pending = { id, slot, chord, conflicts };
      blip('error');
      showConflict();
      paintKeys();
      return;
    }
    assignKey(keymap, id, slot, chord, false);
    blip('confirm');
    commitKeys();
    paintKeys();
  }

  function stopCapture(): void {
    capture = null;
    paintKeys();
  }

  // capture phase on window: runs before the game's own key handlers and swallows the event
  d.on(
    window,
    'keydown',
    (e: KeyboardEvent) => {
      if (!capture) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      const def = keymap.def(capture.id);
      if (e.code === 'Escape') {
        stopCapture();
        return;
      }
      if (e.code === 'Delete') {
        clearKey(keymap, capture.id, capture.slot);
        commitKeys();
        stopCapture();
        return;
      }
      if (MODIFIERS.has(e.code)) {
        capture.mod = e.code; // a lone modifier binds on release (hold actions such as Sprint)
        return;
      }
      const { id, slot } = capture;
      capture = null;
      tryAssign(id, slot, def.hold ? e.code : chordOf(e));
    },
    { capture: true },
  );
  d.on(
    window,
    'keyup',
    (e: KeyboardEvent) => {
      if (!capture || capture.mod !== e.code) return;
      e.stopImmediatePropagation();
      const def = keymap.def(capture.id);
      const { id, slot } = capture;
      if (!def.hold) {
        capture.mod = null; // press actions cannot be a lone modifier: keep waiting
        return;
      }
      capture = null;
      tryAssign(id, slot, e.code);
    },
    { capture: true },
  );

  const keyGroups: HTMLElement[] = [];
  for (const group of KEY_GROUPS) {
    const defs = rebindableActions().filter((a: ActionDef) => a.group === group);
    if (!defs.length) continue;
    const rows = defs.map((def) => {
      const slots: HTMLElement[] = [];
      for (let i = 0; i < KEY_SLOTS; i++) {
        const b = h('button', 'mh-btn ms-key', { type: 'button', testid: `key-${def.id}-${i}`, 'aria-label': `${def.label}, key ${i + 1}` });
        d.on(b, 'click', () => {
          pending = null;
          showConflict();
          capture = capture?.id === def.id && capture.slot === i ? null : { id: def.id as ActionId, slot: Math.min(i, keymap.keysOf(def.id as ActionId).length), mod: null };
          blip('click');
          paintKeys();
          b.blur();
        });
        slotBtns.set(`${def.id}:${i}`, b);
        slots.push(b);
      }
      const reset = h('button', 'mh-btn ms-key-reset', { type: 'button', testid: `key-reset-${def.id}`, 'aria-label': `Reset ${def.label}`, title: 'Reset to default' }, '↺');
      d.on(reset, 'click', () => {
        capture = null;
        pending = null;
        const clashes = resetKey(keymap, def.id as ActionId);
        // defaults win: whatever took this action's default key in the meantime loses it
        for (const k of def.keys) if (clashes.length) assignKey(keymap, def.id as ActionId, def.keys.indexOf(k), k, true);
        commitKeys();
        showConflict();
        paintKeys();
        reset.blur();
      });
      const el = h('div', 'ms-key-row', null, [h('span', 'ms-key-label', null, [def.label, def.ctx === 'possess' ? h('small', undefined, null, ' possessing') : null]), ...slots, reset]);
      rowEls.set(def.id, el);
      return el;
    });
    keyGroups.push(h('section', 'ms-key-group', null, [h('h4', undefined, null, group), ...rows]));
  }
  const resetKeys = h('button', 'mh-btn', { type: 'button', testid: 'keys-reset-all' }, 'Reset all keys');
  d.on(resetKeys, 'click', () => {
    capture = null;
    pending = null;
    keymap.reset();
    blip('confirm');
    commitKeys();
    showConflict();
    paintKeys();
    resetKeys.blur();
  });
  const keys = h('div', 'ms-set-page ms-keys', null, [h('div', 'ms-keys-head', null, [keysNote, resetKeys]), conflictBox, h('div', 'ms-key-groups', null, keyGroups)]);
  paintKeys();

  // ---- shell -----------------------------------------------------------------------------------------
  const pages: Record<SettingsTab, HTMLElement> = { graphics, audio, controls, keys, game };
  const tabBtns = new Map<SettingsTab, HTMLButtonElement>();
  let current: SettingsTab = 'graphics';
  const body = h('div', 'ms-set-body');
  const setTab = (tab: SettingsTab): void => {
    if (capture) stopCapture();
    current = tab;
    for (const [id, b] of tabBtns) {
      setClass(b, 'mh-on', id === tab);
      b.setAttribute('aria-selected', String(id === tab));
    }
    body.replaceChildren(pages[tab]);
    body.scrollTop = 0;
  };
  const tabs = h('div', 'ms-tabs', { role: 'tablist' });
  for (const t of TABS) {
    const b = h('button', 'mh-btn', { type: 'button', role: 'tab', testid: `settings-tab-${t.id}` }, t.label);
    d.on(b, 'click', () => {
      blip('click');
      setTab(t.id);
      b.blur();
    });
    tabBtns.set(t.id, b);
    tabs.append(b);
  }
  const x = h('button', 'mh-btn mh-x', { type: 'button', 'aria-label': 'Close', testid: 'settings-close' }, [icon('close')]);
  d.on(x, 'click', () => deps.close());
  const saved = h('span', 'mh-dim ms-set-saved', null, store.persisted ? 'Saved automatically' : 'Storage unavailable — settings last until you close the page');
  const done = h('button', 'mh-btn mh-on', { type: 'button', testid: 'settings-done' }, 'Done');
  d.on(done, 'click', () => deps.close());
  const el = h('div', 'mh-panel mh-dialog ms-settings', { testid: 'settings', role: 'dialog', 'aria-label': 'Settings' }, [
    h('div', 'mh-panel-head', null, [h('span', undefined, null, 'Settings'), x]),
    tabs,
    body,
    h('div', 'ms-set-foot', null, [saved, h('span', 'mh-grow'), done]),
  ]);
  const initial = TABS.find((t) => t.id === deps.initialTab)?.id ?? 'graphics';
  setTab(initial);

  return {
    el,
    isCapturing: () => capture !== null,
    setTab,
    dispose() {
      capture = null;
      d.dispose();
      void current;
    },
  };
}
