import { describe, expect, it } from 'vitest';
import { contextOrder, contextOrderKind, orderVerb, type OrderTarget } from './orders';

const P = 1; // player colony
const pos = { x: 4, y: 5, z: 6 };
const t = (over: Partial<OrderTarget>): OrderTarget => ({ kind: 'terrain', id: 0, pos, cell: -1, colony: 0, ...over });
const none = { shift: false, alt: false };

describe('contextual RMB order mapping', () => {
  it('terrain → move with position and cell', () => {
    expect(contextOrder([1, 2], t({ cell: 77 }), none, P)).toEqual({ type: 'order', ids: [1, 2], order: 'move', pos, cell: 77 });
  });
  it('edible terrain (wood, for a wood-eating colony) → gather at the point', () => {
    expect(contextOrder([1, 2], t({ cell: 77, edible: true }), none, P)).toEqual({ type: 'order', ids: [1, 2], order: 'gather', pos, cell: 77 });
    expect(contextOrder([1], t({ cell: 77, edible: true }), { shift: false, alt: true }, P)!.order).toBe('guard');
  });
  it('copies the position (the hit object may be reused)', () => {
    const cmd = contextOrder([1], t({}), none, P)!;
    expect(cmd.pos).not.toBe(pos);
    expect(cmd.cell).toBeUndefined();
  });
  it('food source → gather with the target id', () => {
    expect(contextOrder([1], t({ kind: 'food', id: 9 }), none, P)).toEqual({ type: 'order', ids: [1], order: 'gather', pos, targetId: 9 });
  });
  it('food-like items → gather, debris → plain move', () => {
    expect(contextOrderKind(t({ kind: 'item', id: 3, itemKind: 'seed' }), P)).toBe('gather');
    expect(contextOrderKind(t({ kind: 'item', id: 3, itemKind: 'corpse' }), P)).toBe('gather');
    const cmd = contextOrder([1], t({ kind: 'item', id: 3, itemKind: 'debris', cell: 5 }), none, P)!;
    expect(cmd.order).toBe('move');
    expect(cmd.targetId).toBeUndefined();
  });
  it('enemy ant and creatures → attack; own aphids → follow', () => {
    expect(contextOrderKind(t({ kind: 'ant', id: 8, colony: 2 }), P)).toBe('attack');
    expect(contextOrderKind(t({ kind: 'creature', id: 8, creatureRole: 'hunter' }), P)).toBe('attack');
    expect(contextOrderKind(t({ kind: 'creature', id: 8, creatureRole: 'prey' }), P)).toBe('attack');
    expect(contextOrderKind(t({ kind: 'creature', id: 8, creatureRole: 'herd', colony: P }), P)).toBe('follow');
    expect(contextOrder([1], t({ kind: 'ant', id: 8, colony: 2 }), none, P)).toMatchObject({ order: 'attack', targetId: 8 });
  });
  it('friendly ant → follow, never following itself', () => {
    expect(contextOrder([1, 2, 3], t({ kind: 'ant', id: 2, colony: P }), none, P)).toMatchObject({ order: 'follow', targetId: 2, ids: [1, 3] });
    expect(contextOrder([2], t({ kind: 'ant', id: 2, colony: P }), none, P)).toBeNull();
  });
  it('brood is a place to walk to', () => {
    expect(contextOrder([1], t({ kind: 'brood', id: 5, cell: 12 }), none, P)).toMatchObject({ order: 'move', cell: 12 });
  });
  it('Alt → guard (position or target), Shift → queue', () => {
    expect(contextOrder([1], t({ cell: 3 }), { shift: false, alt: true }, P)).toMatchObject({ order: 'guard', cell: 3 });
    expect(contextOrder([1], t({ kind: 'ant', id: 4, colony: P }), { shift: true, alt: true }, P)).toMatchObject({ order: 'guard', targetId: 4, queue: true });
    expect(contextOrder([1], t({}), { shift: true, alt: false }, P)!.queue).toBe(true);
    expect(contextOrder([1], t({}), none, P)!.queue).toBeUndefined();
  });
  it('no selection → no command', () => {
    expect(contextOrder([], t({}), none, P)).toBeNull();
  });
  it('has a verb for every order kind', () => {
    for (const k of ['move', 'gather', 'attack', 'guard', 'follow', 'exile', 'stop'] as const) expect(orderVerb(k)).toMatch(/^[A-Z]/);
  });
});
