import type { CreatureDef, CreatureId } from '../../core';
import { b1Balance } from './balance/b1';

const T = b1Balance.creatures;
const def = (d: CreatureDef): CreatureDef => d;

/**
 * Creature registry (§5.1, §7). All numbers live in `data/balance/b1.ts` (`creatures.<id>.def`
 * for the contract fields, the rest of each entry for B1's AI — see `creatureTuning`).
 * Clearance > 1.5 cannot enter 3-voxel tunnels (D11: a feature — the nest is a refuge).
 *
 *  jumpingSpider  roaming ambush hunter from its lair: stalks, pounces, carries one ant off
 *  antlion        static in its sand pit: ants on the slope slide to the centre and are grabbed
 *  groundBeetle   armoured tank: raids food and food carriers at the nest entrance
 *  wasp           flyer: swoops on exposed workers, snatches or stings, avoids soldiers
 *  mantis         boss: huge, slow to turn, lethal strikes; a mountain of food when it falls
 *  caterpillar / worm  passive prey: big food reward, thrashes, needs a mob
 *  aphid          livestock (B3's `aphids` system owns its behaviour)
 */
export const CREATURES: Readonly<Record<CreatureId, CreatureDef>> = {
  jumpingSpider: def({ id: 'jumpingSpider', name: 'Jumping spider', role: 'hunter', locomotion: 'surface', attackKind: 'bite', ...T.jumpingSpider.def }),
  antlion: def({ id: 'antlion', name: 'Antlion', role: 'ambush', locomotion: 'static', attackKind: 'bite', ...T.antlion.def }),
  groundBeetle: def({ id: 'groundBeetle', name: 'Ground beetle', role: 'tank', locomotion: 'surface', attackKind: 'bite', ...T.groundBeetle.def }),
  wasp: def({ id: 'wasp', name: 'Parasitic wasp', role: 'flyer', locomotion: 'fly', attackKind: 'sting', ...T.wasp.def }),
  mantis: def({ id: 'mantis', name: 'Mantis', role: 'boss', locomotion: 'surface', attackKind: 'bite', ...T.mantis.def }),
  aphid: def({ id: 'aphid', name: 'Aphid', role: 'herd', locomotion: 'surface', attackKind: 'bite', ...T.aphid.def }),
  caterpillar: def({ id: 'caterpillar', name: 'Caterpillar', role: 'prey', locomotion: 'surface', attackKind: 'bite', ...T.caterpillar.def }),
  worm: def({ id: 'worm', name: 'Worm', role: 'prey', locomotion: 'surface', attackKind: 'bite', ...T.worm.def }),
};

export function getCreature(id: CreatureId): CreatureDef {
  return CREATURES[id];
}

/** B1 tuning shared by every creature (combat numbers); AI-specific fields are read per kind. */
export interface CreatureTuning {
  armour: number;
  hold: number;
  power: number;
  turn: number;
}

export function creatureTuning(id: CreatureId): CreatureTuning {
  return T[id];
}
