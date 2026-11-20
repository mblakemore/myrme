import { STUN_KEY, v3, v3clone, type Ant, type Mover, type NavEx, type Rng, type SimState, type SimSystem, type WeatherForecast, type WeatherKind, type WeatherPhase, type WeatherStateEx } from '../../core';
import { BALANCE } from '../data/balance';
import { alertB2, envState, type Biome, type EnvState } from './weatherEnv';

/**
 * Clock and weather (§7 adversities).
 *
 * CLOCK. On maps with `flags.dayNight` the day lasts `BALANCE.b2.dayLength` sim-seconds and the
 * game starts at 07:00; farm maps keep their fixed `timeOfDay`.
 *
 * WEATHER. A seeded state machine over phases (clear → cloudy → drizzle / rain → storm → clearing;
 * desert: heat waves and rare cloudbursts; forest: fog and frequent drizzle; farm maps: none —
 * "room" conditions, the keeper provides water and heat through `B2Env`). The NEXT phase is
 * always rolled in advance, so `weather.forecast` and the "Rain is coming" alert are truthful.
 * The phase sets targets; `rain`, `cloudiness`, `fog`, `wind` ease towards them and surface
 * `wetness` builds under rain and dries afterwards. `weather.kind` / `intensity` are the coarse
 * contract view (A2a's trail washout and the sky read those).
 *
 * RAIN. While it rains hard enough, raindrop impacts are generated as `rainImpact` events on the
 * sky-exposed surface (column tops): some uniformly over the map, some near ants that are out in
 * the open. At ant scale a drop is a bomb: a direct hit hurts and stuns, a near miss stuns, and an
 * ant clinging to a stem or wall is knocked off. Ants under leaves, logs or ground are never hit.
 * Storms add `lightning` events (and a short stun around the strike).
 *
 * Commands: `debugWeather {kind, intensity?}` holds that weather for `debugHoldSeconds`
 * (also `envOf(sim).forceWeather(kind, intensity, seconds)` / `clearForcedWeather()`).
 */

interface PhasePlan {
  phase: WeatherPhase;
  ticks: number;
  intensity: number;
}

interface WxCtx {
  rng: Rng;
  biome: Biome;
  enabled: boolean;
  plan: PhasePlan;
  next: PhasePlan;
  /** Ticks left in the current phase. */
  left: number;
  forcedUntil: number;
  alerted: boolean;
  windAngle: number;
  windTurn: number;
  lightningAt: number;
  dropAcc: number;
  nearAcc: number;
  exposed: Ant[];
}

const ctxs = new WeakMap<SimState, WxCtx>();
const _movers: Mover[] = [];
const _p = v3();

const KIND: Readonly<Record<WeatherPhase, WeatherKind>> = {
  clear: 'clear',
  cloudy: 'cloudy',
  fog: 'cloudy',
  drizzle: 'rain',
  rain: 'rain',
  storm: 'storm',
  cloudburst: 'storm',
  clearing: 'cloudy',
  heat: 'heat',
  cold: 'cold',
  wind: 'wind',
  room: 'clear',
};

const INTENSITY: Readonly<Record<WeatherPhase, readonly [number, number]>> = {
  clear: [0, 0],
  cloudy: [0.3, 0.9],
  fog: [0.4, 0.9],
  drizzle: [0.14, 0.27],
  rain: [0.5, 0.8],
  storm: [0.85, 1],
  cloudburst: [1, 1],
  clearing: [0.3, 0.5],
  heat: [0.6, 1],
  cold: [0.5, 1],
  wind: [0.6, 1],
  room: [0, 0],
};

export function isWet(phase: WeatherPhase): boolean {
  return phase === 'drizzle' || phase === 'rain' || phase === 'storm' || phase === 'cloudburst';
}

function makePlan(rng: Rng, phase: WeatherPhase): PhasePlan {
  const t = BALANCE.b2.phaseTime[phase];
  const i = INTENSITY[phase];
  return { phase, ticks: Math.round(rng.range(t[0], t[1]) * 30), intensity: i[0] + (i[1] - i[0]) * rng.next() };
}

/** Roll the phase that follows `from`, which will start at time of day `tod`. */
function rollNext(sim: SimState, c: WxCtx, from: WeatherPhase, tod: number): PhasePlan {
  const rng = c.rng;
  const rc = sim.map.environment.rainChance;
  const midday = tod > 0.38 && tod < 0.66;
  const morning = tod > 0.18 && tod < 0.36;
  const night = tod < 0.2 || tod > 0.82;
  let phase: WeatherPhase = 'clear';
  const r = rng.next();
  if (c.biome === 'desert') {
    switch (from) {
      case 'clear':
      case 'wind':
        if (r < rc * 1.5) phase = 'cloudburst';
        else if (midday && r < 0.7) phase = 'heat';
        else if (night && r < 0.25) phase = 'cold';
        else if (r > 0.82) phase = 'wind';
        break;
      case 'cloudburst':
        phase = 'clearing';
        break;
      default:
        phase = 'clear';
    }
  } else {
    const forest = c.biome === 'forest';
    switch (from) {
      case 'clear':
        // M3: fog is tested first on a forest morning — behind the cloudy roll (and with `morning`
        // a narrow window that a clear phase rarely ended in) it showed up 0 times in 5 seeds × 3 days
        if (forest && morning && r < 0.6) phase = 'fog';
        else if (r < 0.32 + rc) phase = 'cloudy';
        else if (!forest && r > 0.88) phase = 'wind';
        else if (!forest && midday && r > 0.8) phase = 'heat';
        else if (night && r > 0.9) phase = 'cold';
        break;
      case 'cloudy':
      case 'fog':
        if (r < 0.3 + rc) phase = forest && rng.next() < 0.6 ? 'drizzle' : 'rain';
        else if (r < 0.45 + rc) phase = 'drizzle';
        break;
      case 'drizzle':
        phase = r < 0.3 ? 'rain' : 'clearing';
        break;
      case 'rain':
        phase = r < 0.35 ? 'storm' : 'clearing';
        break;
      case 'storm':
      case 'cloudburst':
        phase = 'clearing';
        break;
      case 'wind':
        phase = r < 0.4 ? 'cloudy' : 'clear';
        break;
      default:
        phase = 'clear';
    }
  }
  return makePlan(rng, phase);
}

function planFor(kind: WeatherKind, intensity: number | undefined, seconds: number): PhasePlan {
  const phase: WeatherPhase = kind === 'rain' ? (intensity !== undefined && intensity < 0.3 ? 'drizzle' : 'rain') : kind;
  const def = kind === 'clear' ? 0 : kind === 'storm' ? 1 : 0.7;
  return { phase, ticks: Math.round(seconds * 30), intensity: Math.max(0, Math.min(1, intensity ?? def)) };
}

function setForecast(sim: SimState, c: WxCtx, w: WeatherStateEx): void {
  if (!c.enabled && !w.forced) {
    w.forecast = null;
    return;
  }
  const f: WeatherForecast = w.forecast ?? { kind: 'clear', phase: 'clear', intensity: 0, inTicks: 0 };
  f.kind = KIND[c.next.phase];
  f.phase = c.next.phase;
  f.intensity = c.next.intensity;
  f.inTicks = Math.max(0, c.left);
  w.forecast = f;
}

function begin(sim: SimState, c: WxCtx, w: WeatherStateEx, plan: PhasePlan): void {
  const from = w.kind;
  c.plan = plan;
  c.left = plan.ticks;
  c.alerted = false;
  w.phase = plan.phase;
  w.kind = KIND[plan.phase];
  if (w.kind !== from) sim.emit({ type: 'weatherChanged', tick: sim.tick, from, to: w.kind });
  if (plan.phase === 'storm' || plan.phase === 'cloudburst') c.lightningAt = sim.tick + Math.round(c.rng.range(2, 6) * 30);
}

function todAfter(sim: SimState, w: WeatherStateEx, ticks: number): number {
  const len = BALANCE.b2.dayLength;
  if (!sim.map.flags.dayNight) return w.timeOfDay;
  return (w.timeOfDay + ticks / 30 / len) % 1;
}

const ease = (cur: number, target: number, dt: number, seconds: number): number => cur + (target - cur) * Math.min(1, dt / seconds);

/** One raindrop hitting the surface of column (x, z). */
function impact(sim: SimState, x: number, z: number): void {
  const w = sim.world;
  if (x < 0 || z < 0 || x >= w.sx || z >= w.sz) return;
  const B = BALANCE.b2;
  const nav = sim.nav as NavEx;
  const h = nav.skyHeight(Math.floor(x), Math.floor(z));
  if (h >= w.sy) return;
  _p.x = x;
  _p.y = h + 0.15;
  _p.z = z;
  const R = B.dropRadius;
  sim.emit({ type: 'rainImpact', tick: sim.tick, pos: v3clone(_p), radius: R });
  sim.spatial.queryMovers(_p.x, _p.y, _p.z, R + 1, _movers);
  for (let i = 0; i < _movers.length; i++) {
    const m = _movers[i];
    if (!m.alive || m.falling || m.cell < 0 || m.locomotion === 'fly' || !nav.isExposed(m.cell)) continue;
    const d = Math.hypot(m.pos.x - _p.x, m.pos.y - _p.y, m.pos.z - _p.z);
    if (d > R + m.rideHeight) continue;
    hitByDrop(sim, m, d < R * B.dropCore);
  }
}

function hitByDrop(sim: SimState, m: Mover, direct: boolean): void {
  const B = BALANCE.b2;
  const e = m as Ant;
  const big = m.clearance > 1; // beetles and mantises shrug raindrops off
  if (e.kind === 'ant' && (e.infection.stage === 'gripped' || e.infection.stage === 'fruiting' || e.infection.stage === 'burst')) return;
  if (!big) {
    const until = sim.tick + Math.round((direct ? B.dropStunDirect : B.dropStunNear) * 30);
    if (!(e.mem[STUN_KEY] > until)) e.mem[STUN_KEY] = until;
    // knocked off a stem / wall: thrown clear of the surface, then D12 takes over
    if (m.locomotion === 'surface' && m.up.y < B.dropKnockUpY) {
      const k = 1.7;
      const nx = m.pos.x + m.up.x * k;
      const ny = m.pos.y + m.up.y * k;
      const nz = m.pos.z + m.up.z * k;
      if (sim.world.sample(nx, ny, nz) < -1.2 && nx > 1 && nz > 1 && nx < sim.world.sx - 1 && nz < sim.world.sz - 1) {
        m.pos.x = nx;
        m.pos.y = ny;
        m.pos.z = nz;
        m.falling = true;
        m.cell = -1;
        sim.emit({ type: 'fell', tick: sim.tick, id: m.id, pos: v3clone(m.pos) });
      }
    }
  }
  if (!direct || big) return;
  if (e.kind === 'ant') {
    if (e.caste === 'queen') return;
    e.health -= B.dropDamage;
    sim.emit({ type: 'damage', tick: sim.tick, target: e.id, amount: B.dropDamage, pos: v3clone(e.pos) });
    if (e.health <= 0) sim.killAnt(e, 'drowning');
  }
}

function rainImpacts(sim: SimState, c: WxCtx, w: WeatherStateEx, dt: number): void {
  const B = BALANCE.b2;
  const world = sim.world;
  const rng = c.rng;
  c.dropAcc += B.dropsAmbient * w.rain * dt;
  while (c.dropAcc >= 1) {
    c.dropAcc -= 1;
    impact(sim, rng.next() * world.sx, rng.next() * world.sz);
  }
  // ants out in the open (refreshed at 3 Hz)
  if (sim.tick % 10 === 0) {
    const nav = sim.nav as NavEx;
    c.exposed.length = 0;
    for (const a of sim.ants) if (a.alive && a.cell >= 0 && !a.falling && nav.isExposed(a.cell)) c.exposed.push(a);
  }
  const n = c.exposed.length;
  if (n === 0) return;
  c.nearAcc += B.dropsNearAnts * w.rain * Math.min(1, n / B.dropsAntsFull) * dt;
  while (c.nearAcc >= 1) {
    c.nearAcc -= 1;
    const a = c.exposed[rng.int(n)];
    const ang = rng.next() * Math.PI * 2;
    const r = B.dropScatter * Math.sqrt(rng.next());
    if (a.alive) impact(sim, a.pos.x + Math.cos(ang) * r, a.pos.z + Math.sin(ang) * r);
  }
}

function lightning(sim: SimState, c: WxCtx, w: WeatherStateEx): void {
  const B = BALANCE.b2;
  const rng = c.rng;
  const nav = sim.nav as NavEx;
  // lightning likes high points: best of a few random columns
  let bx = 0;
  let bz = 0;
  let bh = -1;
  for (let i = 0; i < 4; i++) {
    const x = rng.int(sim.world.sx);
    const z = rng.int(sim.world.sz);
    const h = nav.skyHeight(x, z);
    if (h > bh && h < sim.world.sy) {
      bh = h;
      bx = x;
      bz = z;
    }
  }
  c.lightningAt = sim.tick + Math.round(rng.range(B.lightningEvery[0], B.lightningEvery[1]) * 30);
  if (bh < 0) return;
  _p.x = bx + 0.5;
  _p.y = bh;
  _p.z = bz + 0.5;
  w.lastLightningTick = sim.tick;
  sim.emit({ type: 'lightning', tick: sim.tick, pos: v3clone(_p) });
  sim.spatial.queryMovers(_p.x, _p.y, _p.z, B.lightningStunRadius, _movers);
  const until = sim.tick + Math.round(B.lightningStun * 30);
  for (const m of _movers) {
    const mem = (m as Ant).mem;
    if (m.alive && mem && m.cell >= 0 && nav.isExposed(m.cell) && !(mem[STUN_KEY] > until)) mem[STUN_KEY] = until;
  }
}

function force(sim: SimState, kind: WeatherKind, intensity?: number, seconds?: number): void {
  const c = ctxs.get(sim);
  if (!c) return;
  const w = sim.weather as WeatherStateEx;
  const hold = seconds ?? BALANCE.b2.debugHoldSeconds;
  w.forced = true;
  c.forcedUntil = sim.tick + Math.round(hold * 30);
  begin(sim, c, w, planFor(kind, intensity, hold));
  // what follows a forced phase: the machine's natural successor (or calm room air)
  c.next = c.enabled ? rollNext(sim, c, c.plan.phase, todAfter(sim, w, c.left)) : { phase: 'room', ticks: 18000, intensity: 0 };
  setForecast(sim, c, w);
}

function unforce(sim: SimState): void {
  const c = ctxs.get(sim);
  const w = sim.weather as WeatherStateEx;
  if (!c || !w.forced) return;
  w.forced = false;
  c.left = 0; // move on to `next` at the next update
}

export const weatherSystem: SimSystem = {
  id: 'weather',
  commands: ['debugWeather'],
  init(sim) {
    const env = envState(sim);
    const w = sim.weather as WeatherStateEx;
    const B = BALANCE.b2;
    const rng = sim.rng.fork('b2.weather');
    const enabled = sim.map.flags.weather;
    if (sim.map.flags.dayNight && sim.map.environment.dayLength > 0) w.timeOfDay = B.startTimeOfDay;
    const first: PhasePlan = enabled ? { phase: 'clear', ticks: Math.round((B.graceSeconds + rng.range(0, 90)) * 30), intensity: 0 } : { phase: 'room', ticks: 18000, intensity: 0 };
    const c: WxCtx = {
      rng,
      biome: env.biome,
      enabled,
      plan: first,
      next: first,
      left: first.ticks,
      forcedUntil: 0,
      alerted: false,
      windAngle: rng.next() * Math.PI * 2,
      windTurn: rng.range(-0.02, 0.02),
      lightningAt: 0,
      dropAcc: 0,
      nearAcc: 0,
      exposed: [],
    };
    ctxs.set(sim, c);
    w.phase = first.phase;
    w.kind = 'clear';
    w.intensity = 0;
    w.cloudiness = enabled ? 0.2 : 0;
    if (!enabled) {
      w.wind.x = 0;
      w.wind.y = 0;
      w.wind.z = 0;
    }
    c.next = enabled ? rollNext(sim, c, 'clear', todAfter(sim, w, c.left)) : first;
    setForecast(sim, c, w);
    env.hooks.forceWeather = (kind, intensity, seconds) => force(sim, kind, intensity, seconds);
    env.hooks.clearForcedWeather = () => unforce(sim);
  },
  onCommand(sim, cmd) {
    if (cmd.type === 'debugWeather') force(sim, cmd.kind, cmd.intensity);
  },
  update(sim, dt) {
    const c = ctxs.get(sim);
    if (!c) return;
    const B = BALANCE.b2;
    const w = sim.weather as WeatherStateEx;
    const map = sim.map;

    // ---- clock ----
    if (map.flags.dayNight && map.environment.dayLength > 0) {
      w.timeOfDay += dt / B.dayLength;
      if (w.timeOfDay >= 1) {
        w.timeOfDay -= 1;
        w.day++;
      }
    }

    // ---- state machine ----
    const running = c.enabled || w.forced;
    if (running) {
      if (w.forced && sim.tick >= c.forcedUntil) w.forced = false;
      c.left--;
      if (c.left <= 0) {
        w.forced = false;
        if (c.enabled) {
          begin(sim, c, w, c.next);
          c.next = rollNext(sim, c, c.plan.phase, todAfter(sim, w, c.left));
        } else begin(sim, c, w, { phase: 'room', ticks: 18000, intensity: 0 });
      }
      // forecast hint a little ahead
      const np = c.next.phase;
      if (!c.alerted && c.left <= B.forecastLead * 30 && np !== c.plan.phase) {
        const player = sim.playerColony;
        if (np === 'rain' || np === 'cloudburst' || (np === 'storm' && !isWet(c.plan.phase))) {
          c.alerted = true;
          alertB2(sim, 'wx.rain', 'info', player, 'Rain is coming', null, 0, 20);
        } else if (np === 'storm') {
          c.alerted = true;
          alertB2(sim, 'wx.storm', 'info', player, 'The rain is turning into a storm', null, 0, 20);
        } else if (np === 'heat') {
          c.alerted = true;
          alertB2(sim, 'wx.heat', 'info', player, 'A heat wave is building', null, 0, 20);
        } else if (np === 'cold') {
          c.alerted = true;
          alertB2(sim, 'wx.cold', 'info', player, 'A cold snap is coming', null, 0, 20);
        }
      }
    }
    w.nextChange = Math.max(0, c.left);
    setForecast(sim, c, w);

    // ---- smooth intensities ----
    const ph = w.phase;
    const pi = c.plan.intensity;
    let cloud = 0.2;
    let rain = 0;
    let fog = 0;
    let wind: number = B.windCalm;
    switch (ph) {
      case 'cloudy':
        cloud = 0.5 + 0.4 * pi;
        break;
      case 'fog':
        cloud = 0.6;
        fog = 0.45 + 0.45 * pi;
        wind = B.windCalm * 0.4;
        break;
      case 'drizzle':
        cloud = 0.75;
        rain = pi;
        fog = 0.15;
        break;
      case 'rain':
        cloud = 0.85;
        rain = pi;
        wind = B.windRain;
        break;
      case 'storm':
      case 'cloudburst':
        cloud = 0.97;
        rain = pi;
        wind = B.windStorm;
        break;
      case 'clearing':
        cloud = 0.55;
        break;
      case 'heat':
        cloud = 0.05;
        break;
      case 'cold':
        cloud = 0.3;
        break;
      case 'wind':
        cloud = 0.35;
        wind = B.windGale * (0.6 + 0.4 * pi);
        break;
      case 'room':
        cloud = 0;
        wind = 0;
        break;
      default:
        break;
    }
    w.rain = ease(w.rain, rain, dt, B.rainEase);
    if (w.rain < 0.004 && rain === 0) w.rain = 0;
    w.cloudiness = ease(w.cloudiness, cloud, dt, B.cloudEase);
    w.fog = ease(w.fog, fog, dt, B.fogEase);
    if (w.fog < 0.004 && fog === 0) w.fog = 0;
    // contract view: for wet kinds the intensity IS the smoothed rain rate (trail washout follows it)
    w.intensity = isWet(ph) ? w.rain : ease(w.intensity, pi, dt, B.rainEase);

    // wind: slowly veering direction, gusts from two incommensurate sines (deterministic)
    c.windAngle += c.windTurn * dt;
    const t = sim.time;
    w.gust = wind > 0 ? 0.5 + 0.3 * Math.sin(t * 0.37 + c.windAngle) + 0.2 * Math.sin(t * 1.13) : 0;
    const speed = wind * (0.7 + 0.6 * w.gust);
    w.wind.x = ease(w.wind.x, Math.cos(c.windAngle) * speed, dt, B.windEase);
    w.wind.z = ease(w.wind.z, Math.sin(c.windAngle) * speed, dt, B.windEase);
    w.wind.y = 0;

    // ---- wetness ----
    if (w.rain > 0.02) w.wetness = Math.min(1, w.wetness + B.wetGain * w.rain * dt);
    else if (w.wetness > 0) {
      const env = w.env as EnvState;
      const warm = Math.max(0.4, 1 + (env.air - 20) * 0.05 + env.sun * 0.8 + Math.hypot(w.wind.x, w.wind.z) * 0.3);
      w.wetness = Math.max(0, w.wetness - B.wetDry * warm * dt);
    }

    // ---- rain impacts & lightning ----
    if (w.rain >= B.dropMinRain) rainImpacts(sim, c, w, dt);
    if ((ph === 'storm' || ph === 'cloudburst') && w.rain > 0.5 && sim.tick >= c.lightningAt) lightning(sim, c, w);
  },
};
