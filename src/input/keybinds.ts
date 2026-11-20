/**
 * Central keybind table (§5.4). Used by the input layer (dispatch) and the HUD (hotkey labels,
 * help overlay). Rebindable-ready: `Keymap` holds the live bindings, `rebind` / `toJSON` /
 * `load` are what a settings screen needs.
 *
 * A binding is a *chord* string: optional `Ctrl+`, `Alt+`, `Shift+` (in that order) followed by a
 * `KeyboardEvent.code` (`KeyW`, `Digit1`, `BracketLeft`, `F2`…), so bindings are layout-stable.
 * `hold` actions are polled while the key is down and ignore modifiers; all other actions fire
 * once on key-down and need an exact chord match.
 */

export type KeyContext = 'any' | 'map' | 'possess';
export type KeyGroup = 'Camera' | 'View' | 'Selection' | 'Orders' | 'Tools' | 'Possession' | 'Game';

export interface ActionDef {
  readonly id: string;
  readonly label: string;
  readonly group: KeyGroup;
  /** `map` = RTS / slab view, `possess` = while controlling an ant, `any` = both. */
  readonly ctx: KeyContext;
  readonly keys: readonly string[];
  /** Polled while held (movement) instead of fired on press. */
  readonly hold?: boolean;
  /** Fixed mouse binding shown in the help overlay (not rebindable). */
  readonly mouse?: string;
}

const digits = (prefix: string, from: number, to: number): string[] => {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`${prefix}Digit${i}`);
  return out;
};

const def = <const T extends readonly ActionDef[]>(t: T): T => t;

export const ACTIONS = def([
  // ---- camera (map view) ----
  { id: 'cam.forward', label: 'Pan forward / up', group: 'Camera', ctx: 'map', keys: ['KeyW', 'ArrowUp'], hold: true },
  { id: 'cam.back', label: 'Pan back / down', group: 'Camera', ctx: 'map', keys: ['KeyS', 'ArrowDown'], hold: true },
  { id: 'cam.left', label: 'Pan left', group: 'Camera', ctx: 'map', keys: ['KeyA', 'ArrowLeft'], hold: true },
  { id: 'cam.right', label: 'Pan right', group: 'Camera', ctx: 'map', keys: ['KeyD', 'ArrowRight'], hold: true },
  { id: 'cam.rotateLeft', label: 'Rotate left', group: 'Camera', ctx: 'map', keys: ['KeyQ'], hold: true },
  { id: 'cam.rotateRight', label: 'Rotate right', group: 'Camera', ctx: 'map', keys: ['KeyE'], hold: true },
  { id: 'cam.zoom', label: 'Zoom towards cursor', group: 'Camera', ctx: 'map', keys: [], mouse: 'Wheel' },
  { id: 'cam.orbit', label: 'Orbit', group: 'Camera', ctx: 'map', keys: [], mouse: 'RMB drag' },
  { id: 'cam.drag', label: 'Drag pan', group: 'Camera', ctx: 'map', keys: [], mouse: 'MMB drag' },
  { id: 'cam.focus', label: 'Focus selection', group: 'Camera', ctx: 'map', keys: ['Period'] },
  { id: 'cam.home', label: 'Jump to nest', group: 'Camera', ctx: 'map', keys: ['KeyH'] },
  { id: 'cam.follow', label: 'Follow selected ant', group: 'Camera', ctx: 'map', keys: ['KeyY'] },
  { id: 'cam.flip', label: 'Flip to other pane (farms)', group: 'Camera', ctx: 'map', keys: ['KeyG'] },
  // ---- view ----
  { id: 'view.cut', label: 'Cutaway on / off', group: 'View', ctx: 'map', keys: ['KeyC'] },
  { id: 'view.cutBack', label: 'Cut plane towards camera', group: 'View', ctx: 'map', keys: ['BracketLeft'], mouse: 'Ctrl+Wheel' },
  { id: 'view.cutFwd', label: 'Cut plane away from camera', group: 'View', ctx: 'map', keys: ['BracketRight'] },
  { id: 'view.cutSnap', label: 'Snap cut to selection / nest', group: 'View', ctx: 'map', keys: ['Backslash'] },
  { id: 'view.phero', label: 'Pheromone vision', group: 'View', ctx: 'any', keys: ['KeyP'] },
  // ---- selection ----
  { id: 'sel.click', label: 'Select · add · toggle', group: 'Selection', ctx: 'map', keys: [], mouse: 'LMB · Shift+LMB · Ctrl+LMB' },
  { id: 'sel.box', label: 'Box select', group: 'Selection', ctx: 'map', keys: [], mouse: 'LMB drag' },
  { id: 'sel.caste', label: 'Same caste on screen', group: 'Selection', ctx: 'map', keys: [], mouse: 'Double-click' },
  { id: 'sel.all', label: 'Select all on screen', group: 'Selection', ctx: 'map', keys: ['Ctrl+KeyA'] },
  { id: 'sel.soldiers', label: 'Select all soldiers', group: 'Selection', ctx: 'map', keys: ['F2'] },
  { id: 'sel.idle', label: 'Next idle worker (Shift: all)', group: 'Selection', ctx: 'map', keys: ['F3', 'Backquote', 'Shift+F3', 'Shift+Backquote'] },
  { id: 'sel.cycle', label: 'Cycle through selection', group: 'Selection', ctx: 'map', keys: ['Tab', 'Shift+Tab'] },
  { id: 'group.recall', label: 'Recall group (double-tap: focus)', group: 'Selection', ctx: 'map', keys: digits('', 1, 9) },
  { id: 'group.assign', label: 'Assign group', group: 'Selection', ctx: 'map', keys: [...digits('Ctrl+', 1, 9), ...digits('Shift+', 1, 9)] },
  // ---- orders ----
  { id: 'order.context', label: 'Move · gather · attack · follow', group: 'Orders', ctx: 'map', keys: [], mouse: 'RMB' },
  { id: 'order.queue', label: 'Queue order', group: 'Orders', ctx: 'map', keys: [], mouse: 'Shift+RMB' },
  { id: 'order.guard', label: 'Guard position / target', group: 'Orders', ctx: 'map', keys: [], mouse: 'Alt+RMB' },
  { id: 'order.stop', label: 'Stop (clear orders)', group: 'Orders', ctx: 'map', keys: ['Backspace'] },
  // ---- tools & beacons ----
  { id: 'tool.dig', label: 'Dig brush', group: 'Tools', ctx: 'map', keys: ['KeyB'] },
  { id: 'tool.build', label: 'Build brush', group: 'Tools', ctx: 'map', keys: ['KeyN'] },
  { id: 'tool.brushDown', label: 'Smaller brush', group: 'Tools', ctx: 'map', keys: ['KeyZ'] },
  { id: 'tool.brushUp', label: 'Larger brush', group: 'Tools', ctx: 'map', keys: ['KeyX'], mouse: 'Alt+Wheel' },
  { id: 'tool.erase', label: 'Erase mode', group: 'Tools', ctx: 'map', keys: ['KeyR'] },
  { id: 'beacon.gather', label: 'Gather beacon', group: 'Tools', ctx: 'map', keys: ['KeyU'] },
  { id: 'beacon.dig', label: 'Dig beacon', group: 'Tools', ctx: 'map', keys: ['KeyI'] },
  { id: 'beacon.rally', label: 'Rally beacon', group: 'Tools', ctx: 'map', keys: ['KeyO'] },
  { id: 'beacon.attack', label: 'Attack beacon', group: 'Tools', ctx: 'map', keys: ['KeyJ'] },
  { id: 'beacon.avoid', label: 'Avoid beacon', group: 'Tools', ctx: 'map', keys: ['KeyK'] },
  // ---- possession ----
  { id: 'possess.toggle', label: 'Possess ant / release', group: 'Possession', ctx: 'any', keys: ['KeyF'] },
  { id: 'p.forward', label: 'Crawl forward', group: 'Possession', ctx: 'possess', keys: ['KeyW'], hold: true },
  { id: 'p.back', label: 'Crawl back', group: 'Possession', ctx: 'possess', keys: ['KeyS'], hold: true },
  { id: 'p.left', label: 'Strafe left', group: 'Possession', ctx: 'possess', keys: ['KeyA'], hold: true },
  { id: 'p.right', label: 'Strafe right', group: 'Possession', ctx: 'possess', keys: ['KeyD'], hold: true },
  { id: 'p.sprint', label: 'Sprint', group: 'Possession', ctx: 'possess', keys: ['ShiftLeft', 'ShiftRight'], hold: true },
  { id: 'p.look', label: 'Look', group: 'Possession', ctx: 'possess', keys: [], mouse: 'Mouse' },
  { id: 'p.turnLeft', label: 'Turn left', group: 'Possession', ctx: 'possess', keys: ['ArrowLeft'], hold: true },
  { id: 'p.turnRight', label: 'Turn right', group: 'Possession', ctx: 'possess', keys: ['ArrowRight'], hold: true },
  { id: 'p.lookUp', label: 'Look up', group: 'Possession', ctx: 'possess', keys: ['ArrowUp'], hold: true },
  { id: 'p.lookDown', label: 'Look down', group: 'Possession', ctx: 'possess', keys: ['ArrowDown'], hold: true },
  { id: 'p.bite', label: 'Bite', group: 'Possession', ctx: 'possess', keys: [], mouse: 'LMB' },
  { id: 'p.dig', label: 'Dig', group: 'Possession', ctx: 'possess', keys: [], mouse: 'RMB' },
  { id: 'p.pickup', label: 'Pick up / drop', group: 'Possession', ctx: 'possess', keys: ['KeyE'] },
  { id: 'p.trail', label: 'Lay trail on / off', group: 'Possession', ctx: 'possess', keys: ['KeyR'] },
  { id: 'p.recruit', label: 'Recruit followers', group: 'Possession', ctx: 'possess', keys: ['KeyQ'] },
  { id: 'p.view', label: 'First / third person', group: 'Possession', ctx: 'possess', keys: ['KeyV'] },
  { id: 'p.next', label: 'Hop to next nestmate', group: 'Possession', ctx: 'possess', keys: ['Tab', 'Period'] },
  { id: 'p.prev', label: 'Hop to previous nestmate', group: 'Possession', ctx: 'possess', keys: ['Comma', 'Shift+Tab'] },
  // ---- game ----
  { id: 'game.pause', label: 'Pause', group: 'Game', ctx: 'any', keys: ['Space'] },
  { id: 'game.faster', label: 'Faster', group: 'Game', ctx: 'any', keys: ['Equal', 'NumpadAdd'] },
  { id: 'game.slower', label: 'Slower', group: 'Game', ctx: 'any', keys: ['Minus', 'NumpadSubtract'] },
  { id: 'ui.colony', label: 'Colony panel', group: 'Game', ctx: 'any', keys: ['KeyL'] },
  { id: 'ui.help', label: 'Keys & help', group: 'Game', ctx: 'any', keys: ['F1', 'Shift+Slash'] },
  { id: 'ui.debug', label: 'Debug overlay', group: 'Game', ctx: 'any', keys: ['F9'] },
  { id: 'cancel', label: 'Cancel tool · clear selection · release', group: 'Game', ctx: 'any', keys: ['Escape'] },
] as const satisfies readonly ActionDef[]);

export type ActionId = (typeof ACTIONS)[number]['id'];

/** The table with the general row type (optional fields visible). */
const DEFS: readonly ActionDef[] = ACTIONS;

export const KEY_GROUPS: readonly KeyGroup[] = ['Camera', 'View', 'Selection', 'Orders', 'Tools', 'Possession', 'Game'];

const MODIFIER_CODES = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

export interface ChordSource {
  code: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/** Chord string of a keyboard event (`Ctrl+Shift+KeyA`). Cmd counts as Ctrl. */
export function chordOf(e: ChordSource): string {
  if (MODIFIER_CODES.has(e.code)) return e.code;
  return `${e.ctrlKey || e.metaKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.code}`;
}

/** The bare key code of a chord (`Ctrl+Digit3` → `Digit3`). */
export function chordCode(chord: string): string {
  const i = chord.lastIndexOf('+');
  return i < 0 || i === chord.length - 1 ? chord : chord.slice(i + 1);
}

/** 1..9 for `Digit1`..`Digit9` / `Numpad1`.. chords, else 0. */
export function chordDigit(chord: string): number {
  const m = /(?:Digit|Numpad)(\d)$/.exec(chord);
  return m ? Number(m[1]) : 0;
}

const CODE_NAMES: Record<string, string> = {
  Period: '.',
  Comma: ',',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Minus: '−',
  Equal: '+',
  NumpadAdd: 'Num+',
  NumpadSubtract: 'Num−',
  Escape: 'Esc',
  Backspace: 'Bksp',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  Space: 'Space',
};

/** Human-readable chord (`Ctrl+Digit1` → `Ctrl+1`, `Shift+Slash` → `?`). */
export function formatChord(chord: string): string {
  if (chord === 'Shift+Slash') return '?';
  const code = chordCode(chord);
  const mods = chord.slice(0, chord.length - code.length);
  let name = CODE_NAMES[code];
  if (!name) {
    if (code.startsWith('Key')) name = code.slice(3);
    else if (code.startsWith('Digit')) name = code.slice(5);
    else name = code;
  }
  return mods + name;
}

/** Display strings for a list of chords; runs of digit chords collapse to `1–9`, duplicates drop. */
export function formatKeys(keys: readonly string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < keys.length) {
    const d = chordDigit(keys[i]);
    if (d) {
      const prefix = keys[i].slice(0, keys[i].length - chordCode(keys[i]).length);
      let j = i;
      while (j + 1 < keys.length && chordDigit(keys[j + 1]) === chordDigit(keys[j]) + 1 && keys[j + 1].startsWith(prefix + 'Digit')) j++;
      if (j - i >= 2) {
        out.push(`${prefix}${d}–${chordDigit(keys[j])}`);
        i = j + 1;
        continue;
      }
    }
    const s = formatChord(keys[i]);
    if (!out.includes(s)) out.push(s);
    i++;
  }
  return out;
}

const overlaps = (a: KeyContext, b: KeyContext): boolean => a === 'any' || b === 'any' || a === b;

export interface KeyConflict {
  chord: string;
  a: string;
  b: string;
}

/** Live keybindings: defaults from `ACTIONS`, overridable per action. */
export class Keymap {
  private readonly keys = new Map<string, string[]>();
  private readonly defs = new Map<string, ActionDef>();
  /** chord → action ids (rebuilt on change). */
  private index = new Map<string, ActionDef[]>();
  /** bare code → hold actions. */
  private holdIndex = new Map<string, ActionDef[]>();

  constructor(overrides?: Record<string, string[]>) {
    for (const a of DEFS) {
      this.defs.set(a.id, a);
      this.keys.set(a.id, [...a.keys]);
    }
    if (overrides) this.load(overrides);
    else this.rebuild();
  }

  private rebuild(): void {
    this.index = new Map();
    this.holdIndex = new Map();
    for (const a of DEFS) {
      for (const chord of this.keys.get(a.id)!) {
        const idx = a.hold ? this.holdIndex : this.index;
        const k = a.hold ? chordCode(chord) : chord;
        const list = idx.get(k);
        if (list) list.push(a);
        else idx.set(k, [a]);
      }
    }
  }

  def(id: ActionId): ActionDef {
    return this.defs.get(id)!;
  }

  keysOf(id: ActionId): readonly string[] {
    return this.keys.get(id) ?? [];
  }

  /** First binding formatted for a button caption (`''` if unbound). */
  hint(id: ActionId): string {
    const k = this.keys.get(id);
    return k && k.length ? formatKeys(k)[0] : '';
  }

  /** The press action bound to `chord` in a context (context-specific bindings win over `any`). */
  lookup(chord: string, ctx: Exclude<KeyContext, 'any'>): ActionId | null {
    const list = this.index.get(chord);
    if (!list) return null;
    let any: ActionDef | null = null;
    for (const a of list) {
      if (a.ctx === ctx) return a.id as ActionId;
      if (a.ctx === 'any') any = any ?? a;
    }
    return any ? (any.id as ActionId) : null;
  }

  /** Whether a hold action is active given the set of currently pressed key codes. */
  held(id: ActionId, down: ReadonlySet<string>): boolean {
    for (const chord of this.keys.get(id)!) if (down.has(chordCode(chord))) return true;
    return false;
  }

  /** True if `code` is bound to any hold action in the context (used to swallow browser defaults). */
  isHoldKey(code: string, ctx: Exclude<KeyContext, 'any'>): boolean {
    const list = this.holdIndex.get(code);
    return !!list && list.some((a) => a.ctx === ctx || a.ctx === 'any');
  }

  rebind(id: ActionId, keys: string[]): void {
    if (!this.defs.has(id)) throw new Error(`unknown action: ${id}`);
    this.keys.set(id, [...keys]);
    this.rebuild();
  }

  reset(): void {
    for (const a of DEFS) this.keys.set(a.id, [...a.keys]);
    this.rebuild();
  }

  /** Only the bindings that differ from the defaults. */
  toJSON(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const a of DEFS) {
      const k = this.keys.get(a.id)!;
      if (k.length !== a.keys.length || k.some((c, i) => c !== a.keys[i])) out[a.id] = [...k];
    }
    return out;
  }

  load(overrides: Record<string, string[]>): void {
    for (const [id, keys] of Object.entries(overrides)) if (this.defs.has(id) && Array.isArray(keys)) this.keys.set(id, keys.map(String));
    this.rebuild();
  }

  /** Chords bound to two actions whose contexts overlap (must be empty for a sane keymap). */
  conflicts(): KeyConflict[] {
    const out: KeyConflict[] = [];
    const scan = (idx: Map<string, ActionDef[]>): void => {
      for (const [chord, list] of idx) {
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            if (overlaps(list[i].ctx, list[j].ctx)) out.push({ chord, a: list[i].id, b: list[j].id });
          }
        }
      }
    };
    scan(this.index);
    scan(this.holdIndex);
    return out;
  }

  /** Rows for the help overlay, grouped. `keys` are display strings (keyboard, then mouse). */
  helpRows(): { group: KeyGroup; rows: { id: ActionId; label: string; keys: string[] }[] }[] {
    return KEY_GROUPS.map((group) => ({
      group,
      rows: DEFS.filter((a) => a.group === group).map((a) => {
        const keys = formatKeys(this.keys.get(a.id)!);
        const mouse = a.mouse;
        if (mouse) keys.push(mouse);
        return { id: a.id as ActionId, label: a.label, keys };
      }),
    }));
  }
}
