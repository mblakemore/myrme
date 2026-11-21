import type { CellIndex, ColonyId, Command, CreatureRole, EntityId, EntityKind, ItemKind, OrderKind, Vec3 } from '../core';

/**
 * Pure mapping from "what is under the cursor" to the contextual RMB order (§5.4):
 *   terrain → move (edible wood, for a wood-eating colony → gather) · food source / food item → gather · enemy ant / hostile creature → attack ·
 *   friendly ant → follow · Alt → guard (position or target) · Shift → queue.
 */

export interface OrderTarget {
  /** `terrain` = a raycast hit on voxels; otherwise the hovered entity. */
  kind: 'terrain' | EntityKind;
  id: EntityId;
  /** World position of the target (terrain hit, or the entity position). */
  pos: Vec3;
  /** Walkable cell at the target if known (terrain: the air cell in front of the hit), else -1. */
  cell: CellIndex;
  /** Colony of the entity (ants, herd creatures, corpses); 0 = neutral. */
  colony: ColonyId;
  creatureRole?: CreatureRole;
  itemKind?: ItemKind;
  /** Terrain only: the hit voxel is wood/litter the player's species eats in place (termites). */
  edible?: boolean;
}

export interface OrderMods {
  shift: boolean;
  alt: boolean;
}

export type OrderCommand = Extract<Command, { type: 'order' }>;

const GATHERABLE_ITEMS: readonly ItemKind[] = ['food', 'seed', 'leaf', 'wood', 'honeydew', 'fungus', 'corpse'];

/** The order kind a plain RMB would issue on a target (no modifiers). */
export function contextOrderKind(target: OrderTarget, playerColony: ColonyId): OrderKind {
  switch (target.kind) {
    case 'ant':
      return target.colony === playerColony ? 'follow' : 'attack';
    case 'creature':
      // our own aphid herd is tended, not attacked; everything else (prey included) is fair game
      return target.colony === playerColony && target.creatureRole === 'herd' ? 'follow' : 'attack';
    case 'food':
      return 'gather';
    case 'item':
      return target.itemKind && GATHERABLE_ITEMS.includes(target.itemKind) ? 'gather' : 'move';
    default:
      // termites: RMB on wood (or litter) chews it there
      return target.kind === 'terrain' && target.edible ? 'gather' : 'move';
  }
}

/**
 * Build the order command for the selection, or null when there is nothing to order. An ant
 * never receives an order targeting itself (following yourself is dropped from `ids`).
 */
export function contextOrder(selection: readonly EntityId[], target: OrderTarget, mods: OrderMods, playerColony: ColonyId): OrderCommand | null {
  let order = contextOrderKind(target, playerColony);
  if (mods.alt) order = 'guard';
  const isEntity = target.kind !== 'terrain';
  // brood and non-gatherable items are just a place to walk to
  const withTarget = isEntity && order !== 'move';
  const ids = withTarget ? selection.filter((id) => id !== target.id) : selection.slice();
  if (!ids.length) return null;
  const cmd: OrderCommand = { type: 'order', ids, order, pos: { x: target.pos.x, y: target.pos.y, z: target.pos.z } };
  if (withTarget) cmd.targetId = target.id;
  if (target.cell >= 0 && !withTarget) cmd.cell = target.cell;
  if (mods.shift) cmd.queue = true;
  return cmd;
}

/** Cursor / marker hint for the HUD: the verb a click would perform. */
export function orderVerb(order: OrderKind): string {
  switch (order) {
    case 'move':
      return 'Move';
    case 'gather':
      return 'Gather';
    case 'attack':
      return 'Attack';
    case 'guard':
      return 'Guard';
    case 'follow':
      return 'Follow';
    case 'exile':
      return 'Exile';
    default:
      return 'Stop';
  }
}
