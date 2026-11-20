/**
 * Pure helpers for the key-rebinding screen: which actions can be rebound, and what a new chord
 * would collide with. No DOM.
 *
 * Collision rules mirror how the input layer dispatches (`input/keybinds.ts`):
 *  - press actions match the exact chord (`Ctrl+KeyA`); hold actions match the bare key code and
 *    ignore modifiers
 *  - two actions only collide when their contexts overlap (`map` vs `possess` never do, `any`
 *    overlaps both)
 *  - a hold action and a press action collide when the press chord is the bare key itself
 */
import { ACTIONS, chordCode, type ActionDef, type ActionId, type KeyContext, type Keymap } from '../input/keybinds';

const DEFS: readonly ActionDef[] = ACTIONS;

/** Actions with more default bindings than this are fixed digit ranges (groups 1–9). */
const MAX_REBINDABLE_KEYS = 4;
/** Slots shown per action in the rebinding UI. */
export const KEY_SLOTS = 2;

export function isRebindable(def: ActionDef): boolean {
  return def.keys.length > 0 && def.keys.length <= MAX_REBINDABLE_KEYS;
}

export function rebindableActions(): ActionDef[] {
  return DEFS.filter(isRebindable);
}

const overlaps = (a: KeyContext, b: KeyContext): boolean => a === 'any' || b === 'any' || a === b;

export interface BindingConflict {
  /** The other action already using the key. */
  id: ActionId;
  label: string;
  /** Its binding that collides. */
  chord: string;
}

/** Would `chord` on action `id` collide with `otherDef` bound to `otherChord`? */
function collides(def: ActionDef, chord: string, other: ActionDef, otherChord: string): boolean {
  if (!overlaps(def.ctx, other.ctx)) return false;
  if (def.hold && other.hold) return chordCode(chord) === chordCode(otherChord);
  if (!def.hold && !other.hold) return chord === otherChord;
  // one hold, one press: the hold key fires regardless of modifiers, the press needs the exact chord
  const press = def.hold ? otherChord : chord;
  const hold = def.hold ? chord : otherChord;
  return press === chordCode(hold);
}

/** Every other action that `chord` would collide with if bound to `id`. */
export function findConflicts(keymap: Keymap, id: ActionId, chord: string): BindingConflict[] {
  const def = keymap.def(id);
  const out: BindingConflict[] = [];
  for (const other of DEFS) {
    if (other.id === id) continue;
    for (const oc of keymap.keysOf(other.id as ActionId)) {
      if (collides(def, chord, other, oc)) {
        out.push({ id: other.id as ActionId, label: other.label, chord: oc });
        break;
      }
    }
  }
  return out;
}

/**
 * Bind `chord` into `slot` of action `id`. With `steal`, colliding bindings are removed from the
 * other actions; without it nothing changes when there is a conflict. Returns the conflicts found.
 */
export function assignKey(keymap: Keymap, id: ActionId, slot: number, chord: string, steal: boolean): BindingConflict[] {
  const conflicts = findConflicts(keymap, id, chord);
  if (conflicts.length && !steal) return conflicts;
  for (const c of conflicts) {
    keymap.rebind(
      c.id,
      keymap.keysOf(c.id).filter((k) => !collides(keymap.def(id), chord, keymap.def(c.id), k)),
    );
  }
  const keys = [...keymap.keysOf(id)];
  // the same chord in another slot of this action would be a duplicate
  const dup = keys.indexOf(chord);
  if (dup >= 0 && dup !== slot) keys.splice(dup, 1);
  const at = Math.min(slot, keys.length);
  keys[at] = chord;
  keymap.rebind(id, keys);
  return conflicts;
}

/** Remove the binding in `slot` (if any). */
export function clearKey(keymap: Keymap, id: ActionId, slot: number): void {
  const keys = [...keymap.keysOf(id)];
  if (slot >= keys.length) return;
  keys.splice(slot, 1);
  keymap.rebind(id, keys);
}

/** Restore one action's default keys (stealing nothing: defaults may now collide — reported). */
export function resetKey(keymap: Keymap, id: ActionId): BindingConflict[] {
  const def = keymap.def(id);
  keymap.rebind(id, [...def.keys]);
  const out: BindingConflict[] = [];
  for (const k of def.keys) out.push(...findConflicts(keymap, id, k));
  return out;
}

/** Actions that currently have no key at all although they have one by default. */
export function unboundActions(keymap: Keymap): ActionDef[] {
  return rebindableActions().filter((d) => keymap.keysOf(d.id as ActionId).length === 0);
}
