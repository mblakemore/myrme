import { STUN_KEY, clamp, smoothstep, v3clone, type Ant, type Mover, type NavEx, type ShelterReason, type SimState, type SimSystem, type WaterFieldEx, type WeatherStateEx } from '../../core';
import { BALANCE } from '../data/balance';
import { getSpecies } from '../data/species';
import { registerSpeedModifier } from './movement';
import { alertB2, envState, type EnvState } from './weatherEnv';

/**
 * Temperature and exposure (§7: heat / drought, cold nights).
 *
 * MODEL (all in `EnvState`, queried through `envOf(sim).temperatureAt(pos)`):
 *   air      = map base temperature + day/night swing (peak mid-afternoon, damped by cloud,
 *              colder on clear nights) − rain cooling ± heat wave / cold snap; eased, and
 *              published as `sim.weather.temperature`
 *   exposed  = air + sun heat × sun strength          (sun-beaten ground at midday is HOT)
 *   covered  = blends from shade (a little below air) to the stable deep-ground temperature
 *              with depth below the local surface      (the nest is cool by day, mild by night)
 *   + heat sources (`addHeatSource`, the keeper lamp `weather.lamp`)
 *
 * EFFECTS:
 *   - movement speed scales with the local temperature (`activityAt`): cold nights are sluggish,
 *     so the colony naturally forages by day. Applied through A2a's speed-modifier hook together
 *     with the other positional B2 factors: stun (raindrop / lightning), swimming / wading,
 *     rain-wet ground.
 *   - desiccation: above `dryTemp` an ant loses hydration; at 0 it takes damage and dies of
 *     'desiccation'. It recovers in the cool and quickly next to water (drinking).
 *   - weather shelter signal per colony (rain / heat / cold) — see `seekShade` and contracts/b2.ts.
 *   - brood develops faster in warm chambers, slower in cold ones.
 *   - drought: perishable food lying in the hot sun dries out.
 */

/** Fraction of full sunlight for a time of day (0 at night, 1 around noon). */
export function sunElevation(tod: number): number {
  return smoothstep(0, 0.45, Math.sin((tod - 0.25) * Math.PI * 2));
}

/** Target ambient air temperature for the current clock and weather. */
export function ambientTarget(sim: SimState, env: EnvState): number {
  const B = BALANCE.b2;
  const w = sim.weather as WeatherStateEx;
  const base = sim.map.environment.baseTemperature;
  const swing = sim.map.flags.dayNight ? B.swing[env.biome] : 0;
  const cloud = w.cloudiness ?? 0;
  const c = Math.cos((w.timeOfDay - B.hottestTime) * Math.PI * 2);
  let t = base + swing * c * (1 - B.cloudDamp * cloud);
  if (swing > 0 && c < 0) t += B.clearNightDrop * c * (1 - cloud);
  t -= B.rainCool * (w.rain ?? 0);
  if (w.phase === 'heat') t += B.heatWave * w.intensity;
  else if (w.phase === 'cold') t -= B.coldSnap * w.intensity;
  return t;
}

function shelterFor(sim: SimState, env: EnvState, prev: ShelterReason): ShelterReason {
  const B = BALANCE.b2;
  const w = sim.weather as WeatherStateEx;
  if (w.rain >= (prev === 'rain' ? B.shelterRainOff : B.shelterRainOn)) return 'rain';
  if (env.biome === 'farm') return 'none';
  const surface = env.air + env.sunHeat * env.sun;
  if (surface >= (prev === 'heat' ? B.shelterHeatOff : B.shelterHeatOn)) return 'heat';
  if (env.air <= (prev === 'cold' ? B.shelterColdOff : B.shelterColdOn)) return 'cold';
  return 'none';
}

const SHELTER_TEXT: Readonly<Record<ShelterReason, string>> = {
  none: '',
  rain: 'Foragers are sheltering from the rain',
  heat: 'Too hot outside — foragers wait for the evening',
  cold: 'Too cold outside — the colony stays in',
};

export const temperatureSystem: SimSystem = {
  id: 'temperature',
  init(sim) {
    const env = envState(sim);
    const B = BALANCE.b2;
    const water = sim.water as WaterFieldEx;
    const nav = sim.nav as NavEx;
    env.sun = sim.map.flags.weather ? sunElevation(sim.weather.timeOfDay) * 0.8 : 0;
    env.air = ambientTarget(sim, env);
    sim.weather.temperature = env.air;
    // one positional speed modifier for all B2 effects (called per moving mover per tick)
    registerSpeedModifier(sim, (m: Mover) => {
      const mem = (m as Ant).mem;
      if (mem !== undefined) {
        const stun = mem[STUN_KEY];
        if (stun !== undefined && sim.tick < stun) return 0;
      }
      const cell = m.cell;
      if (cell < 0) return 1;
      let k = env.activityAt(env.temperatureAtCell(cell));
      if (water.floodedCount > 0) {
        const d = water.depthAt(cell);
        if (d > B.floodDepth) k *= B.swimSpeed;
        else if (d > 0.15) k *= B.wadeSpeed;
      }
      const wet = sim.weather.wetness;
      if (wet > 0.25 && nav.isExposed(cell)) k *= 1 - B.wetSlow * wet;
      return k;
    });
  },
  update(sim, dt) {
    const env = envState(sim);
    const B = BALANCE.b2;
    const w = sim.weather as WeatherStateEx;
    const nav = sim.nav as NavEx;
    const water = sim.water as WaterFieldEx;

    // ---- ambient ----
    const outdoors = sim.map.environment.backdrop !== 'room';
    env.sun = outdoors && sim.map.flags.dayNight ? sunElevation(w.timeOfDay) * (1 - 0.85 * w.cloudiness) : outdoors ? 0.6 * (1 - 0.85 * w.cloudiness) : 0;
    env.air += (ambientTarget(sim, env) - env.air) * Math.min(1, dt / B.tempEase);
    w.temperature = env.air;

    // ---- shelter signal (1 Hz) ----
    if (sim.tick % 30 === 7) {
      for (const colony of sim.colonies) {
        if (!colony.alive) continue;
        const st = env.colonyState(colony.id);
        const next = shelterFor(sim, env, st.shelter);
        if (next !== st.shelter) {
          st.shelter = next;
          if (next !== 'none' && colony.id === sim.playerColony) alertB2(sim, 'shelter.' + next, 'info', colony.id, SHELTER_TEXT[next], null, 0, 90);
        }
      }
    }

    // ---- desiccation / hydration (each ant at 2 Hz, staggered) ----
    const slot = sim.tick % 15;
    const step = dt * 15;
    const ants = sim.ants;
    for (let i = 0; i < ants.length; i++) {
      const a = ants[i];
      if (!a.alive || a.id % 15 !== slot || a.cell < 0) continue;
      const st = a.infection.stage;
      if (st === 'gripped' || st === 'fruiting' || st === 'burst') continue;
      const t = env.temperatureAtCell(a.cell);
      if (t > B.dryTemp) {
        a.hydration -= B.dryRate * (t - B.dryTemp) * step;
        if (a.hydration <= 0) {
          a.hydration = 0;
          const dmg = B.dryDamage * step;
          a.health -= dmg;
          sim.emit({ type: 'damage', tick: sim.tick, target: a.id, amount: dmg, pos: v3clone(a.pos) });
          if (a.health <= 0) {
            sim.killAnt(a, 'desiccation');
            continue;
          }
        }
      } else if (a.hydration < 1) {
        let gain = B.rehydrate * clamp((B.dryTemp - t) / 8, 0.2, 1);
        if (water.floodedCount > 0 && water.depthAt(a.cell) > 0.05) gain = B.drinkRate;
        a.hydration = Math.min(1, a.hydration + gain * step);
      }
    }

    // ---- brood development by chamber temperature (every 10 ticks) ----
    if (sim.tick % 10 === 3) {
      for (const b of sim.brood) {
        if (!b.alive) continue;
        const cell = b.cell >= 0 ? b.cell : sim.world.cellAt(b.pos.x, b.pos.y, b.pos.z);
        const f = clamp(1 + B.broodPerDegree * (env.temperatureAtCell(cell) - B.broodIdeal), B.broodDevMin, B.broodDevMax);
        // the brood system adds 1 per tick; add the difference for these 10 ticks (fraction dithered by id)
        const extra = (f - 1) * 10;
        let whole = Math.trunc(extra);
        const frac = extra - whole;
        const phase = ((b.id * 7 + Math.floor(sim.tick / 10)) % 10) / 10;
        if (frac > 0 && phase < frac) whole++;
        else if (frac < 0 && phase < -frac) whole--;
        if (whole !== 0) b.age = Math.max(0, b.age + whole);
      }
    }

    // ---- drought: perishable food in the hot sun dries out (1 Hz) ----
    if (sim.tick % 30 === 11 && env.air + env.sunHeat * env.sun > B.dryTemp) {
      for (const f of sim.foodSources) {
        if (!f.alive || f.amount <= 0 || f.regen > 0) continue;
        if (f.foodKind === 'seeds' || f.foodKind === 'sugar' || f.foodKind === 'gel') continue;
        if (f.cell < 0 || !nav.isExposed(f.cell)) continue;
        f.amount = Math.max(0, f.amount * (1 - B.foodDryRate));
      }
    }
  },
};

/** True for species whose workers must stay out of direct sun (termites). */
export function sunSensitive(ant: Ant): boolean {
  return getSpecies(ant.species).caps.sunSensitive;
}
