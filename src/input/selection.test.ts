import { describe, expect, it } from 'vitest';
import { ControlGroups, DOUBLE_TAP_MS, boxPick, combineSelection, cycleId, isDrag, normRect, pickRadiusPx, pointPick, selectMode, type ScreenCandidate } from './selection';

const c = (id: number, x: number, y: number, r = 12, depth = 10): ScreenCandidate => ({ id, x, y, r, depth });

describe('selection box math', () => {
  it('normalises rectangles dragged in any direction', () => {
    expect(normRect({ x0: 50, y0: 40, x1: 10, y1: 20 })).toEqual({ x0: 10, y0: 20, x1: 50, y1: 40 });
  });
  it('distinguishes a click from a drag', () => {
    expect(isDrag({ x0: 0, y0: 0, x1: 3, y1: 3 })).toBe(false);
    expect(isDrag({ x0: 0, y0: 0, x1: 6, y1: 0 })).toBe(true);
  });
  it('picks candidates inside the box regardless of drag direction', () => {
    const cands = [c(1, 10, 10), c(2, 50, 50), c(3, 100, 100), c(4, 51, 9)];
    expect(boxPick(cands, { x0: 60, y0: 60, x1: 0, y1: 0 }).map((k) => k.id)).toEqual([1, 2, 4]);
    expect(boxPick(cands, { x0: 90, y0: 90, x1: 120, y1: 120 }).map((k) => k.id)).toEqual([3]);
    expect(boxPick(cands, { x0: 200, y0: 200, x1: 220, y1: 220 })).toEqual([]);
  });
});

describe('point picking', () => {
  it('returns only candidates within their own radius, nearest first', () => {
    const cands = [c(1, 100, 100, 10), c(2, 106, 100, 10), c(3, 300, 300, 10)];
    expect(pointPick(cands, 105, 100).map((k) => k.id)).toEqual([2, 1]);
    expect(pointPick(cands, 150, 150)).toEqual([]);
  });
  it('prefers the nearer ant when two overlap exactly', () => {
    expect(pointPick([c(1, 100, 100, 10, 30), c(2, 100, 100, 10, 5)], 100, 100)[0].id).toBe(2);
  });
  it('scales the pick radius with apparent size but keeps a minimum', () => {
    const far = pickRadiusPx(0.7, 150, 45, 540);
    const near = pickRadiusPx(0.7, 2, 45, 540);
    expect(far).toBe(12);
    expect(near).toBeGreaterThan(40);
    expect(pickRadiusPx(0.7, 0.01, 45, 540)).toBe(90);
  });
});

describe('selection set operations', () => {
  it('replace / add / toggle', () => {
    expect(combineSelection([1, 2], [3, 3], 'replace')).toEqual([3]);
    expect(combineSelection([1, 2], [2, 3], 'add')).toEqual([1, 2, 3]);
    expect(combineSelection([1, 2, 3], [2], 'toggle')).toEqual([1, 3]);
    expect(combineSelection([1], [2], 'toggle')).toEqual([1, 2]);
    expect(combineSelection([1, 2], [2, 3], 'toggle')).toEqual([1, 2, 3]);
    expect(combineSelection([1, 2, 3], [2, 3], 'toggle')).toEqual([1]);
    expect(combineSelection([1, 2], [], 'replace')).toEqual([]);
  });
  it('maps modifiers to a mode (Ctrl wins)', () => {
    expect(selectMode(false, false)).toBe('replace');
    expect(selectMode(true, false)).toBe('add');
    expect(selectMode(true, true)).toBe('toggle');
  });
  it('cycles ids with wrap-around', () => {
    expect(cycleId([5, 7, 9], 7, 1)).toBe(9);
    expect(cycleId([5, 7, 9], 9, 1)).toBe(5);
    expect(cycleId([5, 7, 9], 5, -1)).toBe(9);
    expect(cycleId([5, 7, 9], 42, 1)).toBe(5);
    expect(cycleId([], 1, 1)).toBe(0);
  });
});

describe('control groups', () => {
  const alive = () => true;
  it('assigns and recalls', () => {
    const g = new ControlGroups();
    g.assign(1, [10, 11, 12]);
    g.assign(2, [20]);
    expect(g.members(1, alive)).toEqual([10, 11, 12]);
    expect(g.members(2, alive)).toEqual([20]);
    expect(g.members(3, alive)).toEqual([]);
    expect(g.groupOf(11)).toBe(1);
  });
  it('reports ants dropped from a reassigned group', () => {
    const g = new ControlGroups();
    g.assign(1, [10, 11, 12]);
    expect(g.assign(1, [12, 13])).toEqual([10, 11]);
    expect(g.members(1, alive)).toEqual([12, 13]);
  });
  it('keeps an ant in one group only (mirrors Ant.group)', () => {
    const g = new ControlGroups();
    g.assign(1, [10, 11]);
    g.assign(2, [11, 12]);
    expect(g.members(1, alive)).toEqual([10]);
    expect(g.members(2, alive)).toEqual([11, 12]);
  });
  it('prunes dead members on recall', () => {
    const g = new ControlGroups();
    g.assign(4, [1, 2, 3]);
    expect(g.members(4, (id) => id !== 2)).toEqual([1, 3]);
    expect(g.members(4, alive)).toEqual([1, 3]);
  });
  it('ignores out-of-range groups', () => {
    const g = new ControlGroups();
    expect(g.assign(0, [1])).toEqual([]);
    expect(g.assign(10, [1])).toEqual([]);
    expect(g.members(0, alive)).toEqual([]);
  });
  it('detects a double tap of the same group only', () => {
    const g = new ControlGroups();
    expect(g.tap(1, 1000)).toBe('recall');
    expect(g.tap(1, 1000 + DOUBLE_TAP_MS - 1)).toBe('focus');
    expect(g.tap(1, 1000 + DOUBLE_TAP_MS)).toBe('recall'); // third tap starts over
    expect(g.tap(2, 2000)).toBe('recall');
    expect(g.tap(1, 2100)).toBe('recall');
    expect(g.tap(1, 2100 + DOUBLE_TAP_MS + 1)).toBe('recall');
  });
});
