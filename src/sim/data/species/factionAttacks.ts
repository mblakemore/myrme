import { registerAttackProfile, type AttackProfile, type StatusEffectDef } from '../../../core';
import { b3Balance } from '../balance/b3';

/**
 * Registers the B3 factions' special attacks with B1's combat (contracts/b1 `AttackProfile`):
 *  - fire-ant venom   → `poison` over time + a light `slow`
 *  - nasute glue      → ranged squirt, `glued` (rooted) then `slow`, hardly any direct damage
 *  - leafcutter major → slicing bite: bleed (`poison` damage) with a chance, part armour-piercing
 * Data lives in `b3Balance.specialAttacks`, keyed `'<species>:<caste>'` (= B1 `unitKey`).
 * Imported for its side effect by the three species files.
 */
let done = false;

export function registerFactionAttacks(): void {
  if (done) return;
  done = true;
  for (const [key, a] of Object.entries(b3Balance.specialAttacks)) {
    const effects: StatusEffectDef[] = [];
    if (a.effect === 'glue') {
      effects.push({ kind: 'glued', duration: a.stun, chance: a.chance });
      effects.push({ kind: 'slow', duration: a.duration, speedMul: a.slow, chance: a.chance });
    } else {
      effects.push({ kind: 'poison', duration: a.duration, dps: a.dps, chance: a.chance, maxStacks: a.effect === 'venom' ? 3 : 1 });
      if (a.slow < 1) effects.push({ kind: 'slow', duration: a.duration, speedMul: a.slow, chance: a.chance });
    }
    const profile: AttackProfile = { effects, range: a.effect === 'glue' ? a.range : 0, damageMul: a.effect === 'glue' ? 0.25 : 1, armourPierce: a.effect === 'bleed' ? 0.5 : a.effect === 'venom' ? 0.3 : 0 };
    registerAttackProfile(key, profile);
  }
}

registerFactionAttacks();
