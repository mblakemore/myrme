import type { EntityId } from '../core';
import type { SelectMode } from './api';

/**
 * Pure selection logic (no DOM, no sim): box math, pick resolution, selection set operations,
 * control groups. Unit-tested in `selection.test.ts`.
 */

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A pickable thing projected to the screen. */
export interface ScreenCandidate {
  id: EntityId;
  /** Screen position in CSS pixels. */
  x: number;
  y: number;
  /** Pick radius in pixels. */
  r: number;
  /** View depth (distance along the camera forward). */
  depth: number;
}

/** Sorted rectangle (x0 ≤ x1, y0 ≤ y1). */
export function normRect(r: Rect): Rect {
  return { x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1) };
}

/** A drag only counts as a box once it exceeds a few pixels (otherwise it is a click). */
export function isDrag(r: Rect, threshold = 5): boolean {
  return Math.hypot(r.x1 - r.x0, r.y1 - r.y0) > threshold;
}

/** Candidates whose centre lies inside the box (grown by `pad` px so edge-grazing ants count). */
export function boxPick(cands: readonly ScreenCandidate[], rect: Rect, pad = 2): ScreenCandidate[] {
  const r = normRect(rect);
  return cands.filter((c) => c.x >= r.x0 - pad && c.x <= r.x1 + pad && c.y >= r.y0 - pad && c.y <= r.y1 + pad);
}

/**
 * Candidates under a point, best first: inside their own pick radius, ordered by normalised
 * distance with a mild bias towards nearer depth (so the ant in front wins an overlap).
 */
export function pointPick(cands: readonly ScreenCandidate[], x: number, y: number): ScreenCandidate[] {
  const scored: { c: ScreenCandidate; s: number }[] = [];
  for (const c of cands) {
    const d = Math.hypot(c.x - x, c.y - y);
    if (d > c.r) continue;
    scored.push({ c, s: d / c.r + c.depth * 1e-4 });
  }
  scored.sort((a, b) => a.s - b.s);
  return scored.map((e) => e.c);
}

/**
 * Pick radius in pixels for a body of `length` world units at view `depth`:
 * about 60% of its projected length, never smaller than `minPx` (so distant ants stay clickable).
 */
export function pickRadiusPx(length: number, depth: number, fovDeg: number, viewportH: number, minPx = 12, maxPx = 90): number {
  const px = (length / (Math.max(1e-3, depth) * Math.tan((fovDeg * Math.PI) / 360))) * (viewportH / 2);
  return Math.min(maxPx, Math.max(minPx, px * 0.6));
}

/** Combine the current selection with newly picked ids (order preserved, no duplicates). */
export function combineSelection(current: readonly EntityId[], picked: readonly EntityId[], mode: SelectMode): EntityId[] {
  if (mode === 'replace') return [...new Set(picked)];
  const out = current.slice();
  if (mode === 'add') {
    for (const id of picked) if (!out.includes(id)) out.push(id);
    return out;
  }
  // toggle: a single click flips membership; a box that is entirely selected deselects, else adds
  const allIn = picked.length > 0 && picked.every((id) => out.includes(id));
  if (allIn) return out.filter((id) => !picked.includes(id));
  for (const id of picked) if (!out.includes(id)) out.push(id);
  return out;
}

export function selectMode(shift: boolean, ctrl: boolean): SelectMode {
  return ctrl ? 'toggle' : shift ? 'add' : 'replace';
}

/** Next / previous id in a list, wrapping; `current` not in the list → first (or last). */
export function cycleId(ids: readonly EntityId[], current: EntityId, dir: 1 | -1): EntityId {
  if (!ids.length) return 0;
  const i = ids.indexOf(current);
  if (i < 0) return dir > 0 ? ids[0] : ids[ids.length - 1];
  return ids[(i + dir + ids.length) % ids.length];
}

export const GROUP_COUNT = 9;
export const DOUBLE_TAP_MS = 350;

/**
 * Ctrl+1..9 control groups. Holds ids only; liveness is checked by the caller through the
 * `alive` predicate so dead ants silently drop out.
 */
export class ControlGroups {
  private readonly groups: EntityId[][] = Array.from({ length: GROUP_COUNT + 1 }, () => []);
  private lastTap = { group: 0, time: -1e9 };

  /**
   * Make `ids` group `n`. An ant belongs to one group at a time (mirrors `Ant.group`), so the ids
   * are removed from every other group. Returns the ids that left group `n`.
   */
  assign(n: number, ids: readonly EntityId[]): EntityId[] {
    if (n < 1 || n > GROUP_COUNT) return [];
    const next = [...new Set(ids)];
    const dropped = this.groups[n].filter((id) => !next.includes(id));
    for (let g = 1; g <= GROUP_COUNT; g++) if (g !== n) this.groups[g] = this.groups[g].filter((id) => !next.includes(id));
    this.groups[n] = next;
    return dropped;
  }

  /** Living members of group `n` (also prunes the dead from the stored list). */
  members(n: number, alive: (id: EntityId) => boolean): EntityId[] {
    if (n < 1 || n > GROUP_COUNT) return [];
    const live = this.groups[n].filter(alive);
    this.groups[n] = live;
    return live.slice();
  }

  /** Group an id belongs to (0 = none). */
  groupOf(id: EntityId): number {
    for (let g = 1; g <= GROUP_COUNT; g++) if (this.groups[g].includes(id)) return g;
    return 0;
  }

  /**
   * Register a recall key press at `timeMs`. Returns `'focus'` when it is the second tap of the
   * same group within `DOUBLE_TAP_MS` (select *and* move the camera), else `'recall'`.
   */
  tap(n: number, timeMs: number): 'recall' | 'focus' {
    const double = this.lastTap.group === n && timeMs - this.lastTap.time <= DOUBLE_TAP_MS;
    this.lastTap = double ? { group: 0, time: -1e9 } : { group: n, time: timeMs };
    return double ? 'focus' : 'recall';
  }

  clear(): void {
    for (let g = 0; g <= GROUP_COUNT; g++) this.groups[g] = [];
  }
}
