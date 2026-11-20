/**
 * Audio layer (B5) — fully procedural WebAudio, no asset files.
 *
 * ONE engine per page: `createAudio()` hands every Game the same `AudioLayerB5`. `init(app)` binds
 * it to a game, `update(frame)` reads sim / view state and the frame's events, `dispose()` unbinds
 * (world voices and beds stop, the AudioContext stays for the menu), `destroy()` closes the
 * context. The AudioContext is created lazily on the first user gesture (own one-shot listeners)
 * or an explicit `unlock()`; before that — and where WebAudio does not exist — everything is a
 * silent no-op, but the mix model (`stats().ambience`, `muffle`, `rain`…) is still computed so the
 * state logic is testable without sound.
 *
 * Pieces: `engine.ts` (graph, limiter, node accounting) · `mix.ts` (pure state → bed mix) ·
 * `ambience.ts` (looping beds) · `sfx.ts` + `voices.ts` (one-shots, allocator) · `music.ts`
 * (generative score) · `dsp.ts` (pure buffer synthesis).
 *
 * Debug hook (tests / tooling), `globalThis.__myrmeAudio`:
 *   weather      Partial<WeatherState> merged over `sim.weather` for the mix (fake rain, night…)
 *   underground  boolean | number 0..1 — force the roof check
 *   renderOffline(id, seconds)  render `<sfx id>` | `bed:<layer>` | `music:<mood>` |
 *                `stinger:victory|defeat` through the real graph in an OfflineAudioContext and
 *                return `{ peak, rms, nan, length }`
 *   ids()        every renderable id
 */
import {
  b3StateOf,
  type AlertCode,
  type AmbienceLayerId,
  type AnySimEvent,
  type AppContext,
  type AudioLayerB5,
  type AudioScene,
  type AudioStats,
  type AudioVolumes,
  type CreatureId,
  type FrameInfo,
  type MusicMood,
  type UiSound,
  type Vec3,
  type WeatherState,
} from '../core';
import { Ambience, BED_GAIN } from './ambience';
import { BED_RATE, analyze, renderBed, type BufferStats } from './dsp';
import { Engine, audioContextCtor } from './engine';
import { LAYER_IDS, computeMix, dayFactor, emptyLayers, volumeGain, type Biome, type MixInput, type MixOutput } from './mix';
import { Music } from './music';
import { SFX, SfxPlayer, setListener } from './sfx';

export interface AudioDebugHook {
  weather?: Partial<WeatherState> | null;
  underground?: boolean | number | null;
  renderOffline(id: string, seconds?: number): Promise<BufferStats & { buildMs: number; renderMs: number }>;
  ids(): string[];
  /** When an array, every sfx the event mapping asks for is appended (works without a context). */
  record?: RecordedSfx[] | null;
  /** Render a recorded scene (sfx at sim-tick times + beds + music) through the real graph offline. */
  renderMix(spec: MixSpec): Promise<MixRenderStats>;
}

export interface RecordedSfx {
  tick: number;
  id: string;
  pos: Vec3 | null;
  gain: number;
  delay: number;
  pitch: number;
  /** Listener snapshot (camera) at the time of the event. */
  lx: number;
  ly: number;
  lz: number;
  ref: number;
  maxDist: number;
}

export interface MixSpec {
  seconds: number;
  events?: readonly RecordedSfx[];
  /** Sim speed the ticks are replayed at (1 = 30 ticks/s, 4 = worst case). */
  speed?: number;
  layers?: Partial<Record<AmbienceLayerId, number>>;
  mood?: MusicMood;
  intensity?: number;
  volumes?: Partial<AudioVolumes>;
  muffle?: number;
  closeness?: number;
}

export interface MixRenderStats extends BufferStats {
  played: number;
  refused: number;
  maxVoices: number;
  maxNodes: number;
  /** Largest sample-to-sample jump (click detector). */
  maxStep: number;
  /** RMS of each whole second (left channel) — shows where the loud part is. */
  perSecond: number[];
  renderMs: number;
}

const ALERT_SOUND: Record<AlertCode, UiSound> = {
  underAttack: 'alertDanger',
  queenInDanger: 'alertDanger',
  queenDead: 'alertDanger',
  possessedDied: 'alertDanger',
  raidIncoming: 'alertDanger',
  starving: 'alertWarn',
  flooding: 'alertWarn',
  infectionSpotted: 'alertWarn',
  predatorNear: 'alertWarn',
  broodHungry: 'alertWarn',
  gardenSick: 'alertWarn',
  info: 'alertInfo',
};
const CREATURE_ATTACK: Partial<Record<CreatureId, string>> = { jumpingSpider: 'spiderPounce', wasp: 'waspSting', groundBeetle: 'beetleThump', mantis: 'mantisStrike', antlion: 'antlionSnap' };
const ATTACK_SOUND: Record<string, string> = { bite: 'bite', sting: 'sting', acid: 'acid', glue: 'glue' };
const MAX_EVENTS_PER_FRAME = 300;
const UP: Vec3 = { x: 0, y: 1, z: 0 };

let shared: AudioLayerB5 | null = null;

export function createAudio(): AudioLayerB5 {
  return (shared ??= makeAudio());
}

/** The page-wide audio engine (same object `createAudio` returns). */
export function getAudio(): AudioLayerB5 {
  return createAudio();
}

function hook(): AudioDebugHook | undefined {
  return (globalThis as { __myrmeAudio?: AudioDebugHook }).__myrmeAudio;
}

function makeAudio(): AudioLayerB5 {
  // conservative defaults: nobody has mixed this by ear yet (gain = v²)
  const volumes: AudioVolumes = { master: 0.6, ambience: 0.7, sfx: 0.7, music: 0.5 };
  let muted = false;
  let musicEnabled = true;
  let scene: AudioScene = 'silent';
  let app: AppContext | null = null;
  let silentShot = false;

  let engine: Engine | null = null;
  let ambience: Ambience | null = null;
  let player: SfxPlayer | null = null;
  let music: Music | null = null;
  let gestureOff: (() => void) | null = null;

  // ---- listening model (computed with or without a context) ----
  const mixIn: MixInput = { scene, biome: 'meadow', timeOfDay: 0.45, weather: 'clear', intensity: 0, wind: 0, underground: 0, possess: false, firstPerson: false, focusDist: 30, lampOn: false, flood: 0, nearbyAnts: 0 };
  const mix: MixOutput = { layers: emptyLayers(), muffle: 0, closeness: 0, rain: 0 };
  let underTarget = 0;
  let under = 0;
  let nextRoofCheck = 0;
  let nextCount = 0;
  let nextBuzz = 0;
  let lastUpdate = 0;
  const listenPos: Vec3 = { x: 0, y: 0, z: 0 };

  // ---- music state ----
  let danger = 0;
  let infectUntil = 0;
  let latched: MusicMood | null = null;
  let ended = false;
  let mood: MusicMood = 'off';
  let moodIntensity = 0;

  const seconds = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

  function applyVolumes(): void {
    if (!engine) return;
    const t = engine.now;
    engine.master.gain.setTargetAtTime(muted ? 0 : volumeGain(volumes.master), t, 0.04);
    engine.buses.ambience.gain.setTargetAtTime(volumeGain(volumes.ambience), t, 0.05);
    engine.buses.sfx.gain.setTargetAtTime(volumeGain(volumes.sfx), t, 0.05);
    engine.buses.ui.gain.setTargetAtTime(volumeGain(volumes.sfx), t, 0.05);
    engine.buses.music.gain.setTargetAtTime(volumeGain(volumes.music), t, 0.05);
  }

  function ensureContext(): void {
    if (engine) {
      const ctx = engine.ctx as AudioContext;
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      return;
    }
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    try {
      const ctx = new Ctor();
      engine = new Engine(ctx);
      ambience = new Ambience(engine);
      player = new SfxPlayer(engine);
      music = new Music(engine);
      music.enabled = musicEnabled;
      // start silent, then fade the master in (no click on the first gesture)
      engine.master.gain.value = 0;
      applyVolumes();
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    } catch {
      engine = null;
      ambience = null;
      player = null;
      music = null;
    }
  }

  function installGesture(): void {
    if (gestureOff || typeof window === 'undefined' || !audioContextCtor()) return;
    const onGesture = (): void => {
      ensureContext();
      if (engine && (engine.ctx as AudioContext).state === 'running') removeGesture();
    };
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener('pointerdown', onGesture, opts);
    window.addEventListener('keydown', onGesture, opts);
    gestureOff = () => {
      window.removeEventListener('pointerdown', onGesture, opts);
      window.removeEventListener('keydown', onGesture, opts);
    };
  }
  function removeGesture(): void {
    gestureOff?.();
    gestureOff = null;
  }

  let eventTick = 0;
  const sfx = (id: string, pos?: Vec3 | null, gain?: number, delay?: number, pitch?: number): void => {
    const rec = hook()?.record;
    if (rec && app) {
      const cam = app.view.camera;
      rec.push({ tick: eventTick, id, pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : null, gain: gain ?? 1, delay: delay ?? 0, pitch: pitch ?? 1, lx: cam.pos.x, ly: cam.pos.y, lz: cam.pos.z, ref: 3 + cam.focusDist * 0.4, maxDist: 40 + cam.focusDist * 2.2 });
    }
    player?.play(id, { pos, gain, delay, pitch });
  };

  // ---- state → mix ---------------------------------------------------------------------------

  function gather(a: AppContext, now: number, dt: number): void {
    const sim = a.sim;
    const view = a.view;
    const dbg = hook();
    const w = dbg?.weather ? { ...sim.weather, ...dbg.weather } : sim.weather;
    const farm = sim.map.flags.slab || sim.map.environment.backdrop === 'room';
    const biome: Biome = farm ? 'farm' : sim.mapId === 'forest' ? 'forest' : sim.mapId === 'desert' ? 'desert' : 'meadow';
    const possessed = view.mode === 'possess' && view.possessedId ? sim.getAnt(view.possessedId) : undefined;
    const lp = possessed ? possessed.pos : view.camera.focus;
    listenPos.x = lp.x;
    listenPos.y = lp.y;
    listenPos.z = lp.z;

    if (now >= nextRoofCheck) {
      nextRoofCheck = now + 0.2;
      const forced = dbg?.underground;
      if (forced !== undefined && forced !== null) underTarget = typeof forced === 'number' ? forced : forced ? 1 : 0;
      else if (possessed || (view.cut.enabled && !farm)) {
        let roof = false;
        try {
          roof = sim.world.raycast({ x: lp.x, y: lp.y + 0.4, z: lp.z }, UP, 80) !== null;
        } catch {
          roof = false;
        }
        underTarget = roof ? 1 : possessed ? 0 : 0.4;
      } else underTarget = 0;
    }
    under += (underTarget - under) * Math.min(1, dt * 5 + (dt === 0 ? 1 : 0));

    if (now >= nextCount) {
      nextCount = now + 0.5;
      const r = Math.max(6, view.camera.focusDist * 0.6);
      const r2 = r * r;
      let n = 0;
      const ants = sim.ants;
      for (let i = 0; i < ants.length; i++) {
        const p = ants[i].pos;
        const dx = p.x - lp.x;
        const dy = p.y - lp.y;
        const dz = p.z - lp.z;
        if (dx * dx + dy * dy + dz * dz < r2) n++;
      }
      mixIn.nearbyAnts = n;
      let flooded = 0;
      try {
        flooded = sim.water.floodedCount;
      } catch {
        flooded = 0;
      }
      mixIn.flood = Math.min(1, flooded / 150);
      let lamp = !!w.lamp;
      try {
        lamp = lamp || b3StateOf(sim).keeper.lampOn;
      } catch {
        /* B3 state unavailable */
      }
      mixIn.lampOn = lamp;
    }

    mixIn.scene = scene;
    mixIn.biome = biome;
    mixIn.timeOfDay = w.timeOfDay;
    mixIn.weather = w.kind;
    mixIn.intensity = w.intensity;
    mixIn.wind = w.wind ? Math.hypot(w.wind.x, w.wind.z) : 0;
    mixIn.underground = under;
    mixIn.possess = !!possessed;
    mixIn.firstPerson = !!possessed && view.firstPerson;
    mixIn.focusDist = view.camera.focusDist;
    computeMix(mixIn, mix);
  }

  function updateMood(dt: number, now: number): void {
    danger = Math.max(0, danger - dt * 0.07);
    if (scene === 'silent') mood = 'off';
    else if (latched) mood = latched;
    else if (scene !== 'game' || !app) mood = 'menu';
    else if (danger > 0.25) mood = 'danger';
    else if (now < infectUntil) mood = 'infection';
    else if (mixIn.biome !== 'farm' && dayFactor(mixIn.timeOfDay) < 0.3) mood = 'night';
    else mood = 'calm';
    moodIntensity = mood === 'danger' ? Math.min(1, danger) : mood === 'calm' || mood === 'night' ? Math.min(1, mixIn.nearbyAnts / 40) : 0.5;
  }

  // ---- events → sound ----------------------------------------------------------------------------

  function onEvent(a: AppContext, e: AnySimEvent, now: number): void {
    const sim = a.sim;
    const pc = sim.playerColony;
    switch (e.type) {
      case 'dig':
        sfx('dig', e.pos);
        sfx('pellet', e.pos, 1, 0.12);
        break;
      case 'build':
        sfx('build', e.pos);
        break;
      case 'attack': {
        const who = sim.getEntity(e.attacker);
        if (who && who.kind === 'creature') sfx(CREATURE_ATTACK[who.def] ?? 'creatureAttack', e.pos);
        else sfx(ATTACK_SOUND[e.kind] ?? 'bite', e.pos);
        const target = sim.getEntity(e.target);
        const mine = (who && who.kind === 'ant' && who.colony === pc) || (target && target.kind === 'ant' && target.colony === pc);
        if (mine) danger = Math.min(1, danger + 0.12);
        break;
      }
      case 'damage':
        sfx('hit', e.pos, Math.min(1, 0.5 + e.amount * 0.05));
        break;
      case 'antDied':
        if (e.caste === 'queen' && e.colony === pc) sfx('queenDeath');
        else sfx('death', e.pos);
        break;
      case 'creatureSpawned':
        if (e.def === 'wasp') sfx('waspBuzz', e.pos);
        else if (e.def === 'mantis' || e.def === 'groundBeetle' || e.def === 'jumpingSpider') sfx('creatureArrive', e.pos);
        break;
      case 'creatureDied':
        sfx('creatureDeath', e.pos);
        break;
      case 'broodStage':
        if (e.stage === 'adult') sfx('hatch', e.pos);
        else if (e.stage === 'egg') sfx('egg', e.pos);
        break;
      case 'foodFound':
        if (e.colony === pc) sfx('foodFound', e.pos);
        break;
      case 'foodDelivered':
        sfx('deliver', e.pos);
        break;
      case 'itemPicked':
        sfx('pickup', e.pos);
        break;
      case 'itemDropped':
      case 'fell':
        sfx('drop', e.pos);
        break;
      case 'rainImpact':
        if (mix.closeness > 0.45) sfx('rainDrop', e.pos, mix.closeness * Math.min(1.3, 0.6 + e.radius * 0.3));
        else sfx('rainTick', e.pos, 0.6);
        break;
      case 'lightning': {
        const d = Math.hypot(e.pos.x - listenPos.x, e.pos.y - listenPos.y, e.pos.z - listenPos.z);
        sfx('thunder', null, 1 / (1 + d / 160), Math.min(5, d / 45), 0.9 + Math.min(0.2, 20 / (d + 20)));
        break;
      }
      case 'flood':
        sfx(e.rising ? 'floodRush' : 'drip', e.pos);
        break;
      case 'infectionStage':
        if (e.stage !== 'none' && e.stage !== 'exposed' && e.stage !== 'incubating') {
          sfx('infect', e.pos);
          infectUntil = now + 40;
        }
        break;
      case 'sporeBurst':
        sfx('sporeBurst', e.pos);
        infectUntil = now + 40;
        break;
      case 'pheromoneBurst':
        if (e.channel === 1) sfx('stridulate', e.pos);
        break;
      case 'alert':
        if (e.colony !== pc && e.colony !== 0) break;
        sfx(`ui.${ALERT_SOUND[e.code] ?? 'alertInfo'}`);
        if (e.code === 'underAttack' || e.code === 'queenInDanger') {
          if (e.pos) sfx('stridulate', e.pos);
          danger = Math.min(1, danger + 0.5);
        } else if (e.code === 'raidIncoming' || e.code === 'predatorNear') danger = Math.min(1, danger + 0.4);
        else if (e.code === 'infectionSpotted') infectUntil = now + 40;
        break;
      case 'directorWave':
        danger = Math.min(1, danger + 0.3);
        break;
      case 'orderIssued':
        sfx('ui.order');
        break;
      case 'possession':
        sfx(e.op === 'start' ? 'possessIn' : 'possessOut');
        engine?.sweepWorld(e.op === 'start' ? 320 : 700, e.op === 'start' ? 0.7 : 0.5, mix.muffle);
        break;
      case 'keeper':
        if (e.action === 'dropFood') sfx('keeperDrop', e.pos);
        else if (e.action === 'dropWater') sfx('keeperWater', e.pos);
        else if (e.action === 'lamp') sfx('lampSwitch');
        else if (e.action === 'tapGlass') sfx('glassTap', e.pos);
        else if (e.action === 'openTube') sfx('tubeOpen', e.pos);
        break;
      case 'keeperEvent':
        if (e.action === 'shake') sfx('shake');
        break;
      case 'nuptialFlight':
        if (e.phase === 'takeoff') sfx('wings', e.pos, 1.3);
        break;
      case 'alateTakeoff':
        sfx('wings', e.pos);
        break;
      case 'raft':
        if (e.op === 'formed') sfx('floodRush', e.pos, 0.6);
        break;
      case 'garden':
        if (e.op === 'mould' || e.op === 'collapsed') sfx('infect', e.pos);
        break;
      case 'leafCut':
        sfx('snip', e.pos);
        break;
      case 'aphid':
        if (e.op === 'milked') sfx('drip', e.pos, 0.5);
        break;
      case 'sunburn':
        sfx('sizzle', e.pos);
        break;
      case 'win':
        end('victory');
        break;
      case 'lose':
        end('defeat');
        break;
      case 'gameEnd':
        end(e.result === 'won' ? 'victory' : 'defeat');
        break;
      case 'gameContinue':
        latched = null;
        ended = false;
        break;
      default:
        break;
    }
  }

  function end(kind: 'victory' | 'defeat'): void {
    if (ended) return;
    ended = true;
    api.stinger(kind);
  }

  /** A flying wasp near the listener buzzes past, pitched by its approach speed (doppler-ish). */
  function waspFlyby(a: AppContext, now: number): void {
    if (now < nextBuzz || !player) return;
    nextBuzz = now + 1.3;
    const L = player.listener;
    let best: Vec3 | null = null;
    let bd = L.maxDist;
    let pitch = 1;
    for (const c of a.sim.creatures) {
      if (c.def !== 'wasp' || !c.alive) continue;
      const dx = c.pos.x - L.x;
      const dy = c.pos.y - L.y;
      const dz = c.pos.z - L.z;
      const d = Math.hypot(dx, dy, dz);
      if (d >= bd) continue;
      bd = d;
      best = c.pos;
      // radial speed towards the listener in units/s (one tick of motion × 30)
      const approach = d > 0.01 ? (-((c.pos.x - c.prevPos.x) * dx + (c.pos.y - c.prevPos.y) * dy + (c.pos.z - c.prevPos.z) * dz) / d) * 30 : 0;
      pitch = 1 + Math.max(-0.15, Math.min(0.15, approach * 0.03));
    }
    if (best) sfx('waspBuzz', best, 1, 0, pitch);
  }

  const api: AudioLayerB5 = {
    init(a: AppContext) {
      if (app && app !== a) api.dispose();
      app = a;
      silentShot = !!a.params.shot;
      if (!silentShot) installGesture();
      // a Game bound without the app shell (direct boot) is simply "the game"
      if (scene === 'silent') scene = 'game';
      under = underTarget = 0;
      nextRoofCheck = nextCount = nextBuzz = 0;
      danger = 0;
      infectUntil = 0;
      ended = false;
      latched = null;
    },

    update(frame: FrameInfo) {
      const a = app;
      if (!a || silentShot) return;
      try {
        const now = seconds();
        const dt = lastUpdate > 0 ? Math.min(0.25, now - lastUpdate) : 0;
        lastUpdate = now;
        gather(a, now, dt);
        const live = !!(engine && player && ambience && music);
        if (live) {
          if (!ambience!.ready) ambience!.buildNext();
          const cam = a.view.camera;
          setListener(engine!.ctx, cam.pos, cam.forward, cam.up);
          const L = player!.listener;
          L.x = cam.pos.x;
          L.y = cam.pos.y;
          L.z = cam.pos.z;
          L.ref = 3 + cam.focusDist * 0.4;
          L.maxDist = 40 + cam.focusDist * 2.2;
        }
        // events also drive the music mood, so they are mapped even before the context exists
        // (every `sfx()` is then a no-op)
        if (scene === 'game') {
          const events = frame.events as readonly AnySimEvent[];
          const n = Math.min(events.length, MAX_EVENTS_PER_FRAME);
          for (let i = 0; i < n; i++) {
            eventTick = events[i].tick;
            onEvent(a, events[i], now);
          }
          eventTick = frame.tick;
          waspFlyby(a, now);
        }
        updateMood(dt, now);
        if (!engine || !player || !ambience || !music) return;
        engine.setWorldTone(mix.muffle, scene === 'game' ? mix.closeness : 0);
        const gust = 0.5 + 0.5 * Math.sin(now * 0.9 + 2 * Math.sin(now * 0.23));
        ambience.apply(mix.layers, gust, mix.rain);
        player.update();
        music.mood = mood;
        music.intensity = moodIntensity;
        music.schedule(engine.now + 0.35);
      } catch {
        /* audio must never take the frame down */
      }
    },

    setMasterVolume(v: number) {
      api.setVolumes({ master: v });
    },
    setMuted(m: boolean) {
      muted = m;
      applyVolumes();
    },
    unlock() {
      if (silentShot) return;
      ensureContext();
      if (engine && (engine.ctx as AudioContext).state === 'running') removeGesture();
    },
    dispose() {
      app = null;
      silentShot = false;
      for (const id of LAYER_IDS) mix.layers[id] = 0;
      mix.muffle = mix.closeness = mix.rain = 0;
      under = underTarget = 0;
      danger = 0;
      infectUntil = 0;
      ended = false;
      latched = null;
      try {
        player?.stop(false);
        ambience?.silence();
        engine?.setWorldTone(0, 0);
      } catch {
        /* ignore */
      }
    },

    setVolumes(v) {
      for (const k of ['master', 'ambience', 'sfx', 'music'] as const) {
        const x = v[k];
        if (typeof x === 'number' && Number.isFinite(x)) volumes[k] = Math.max(0, Math.min(1, x));
      }
      applyVolumes();
    },
    setMusicEnabled(on) {
      musicEnabled = on;
      if (music) music.enabled = on;
    },
    setScene(s) {
      if (s === scene) return;
      scene = s;
      latched = null;
      ended = false;
      if (s !== 'game') {
        try {
          player?.stop(false);
        } catch {
          /* ignore */
        }
      }
      // keep the menu score running without a bound game (no update() calls then)
      pumpMenu();
    },
    ui(sound) {
      if (silentShot) return;
      try {
        player?.play(`ui.${sound}`);
      } catch {
        /* ignore */
      }
    },
    stinger(kind) {
      latched = kind;
      try {
        music?.stinger(kind);
      } catch {
        /* ignore */
      }
    },
    stats(): AudioStats {
      const ctx = engine?.ctx as AudioContext | undefined;
      const alloc = player?.allocator;
      const sfxN = alloc?.count('sfx') ?? 0;
      const uiN = alloc?.count('ui') ?? 0;
      return {
        state: ctx ? (ctx.state as AudioStats['state']) : 'none',
        unlocked: !!ctx && ctx.state === 'running',
        scene,
        muted,
        volumes: { ...volumes },
        voices: sfxN + uiN,
        voicesByBus: { ambience: ambience?.active() ?? 0, sfx: sfxN, music: music?.activeNotes ?? 0, ui: uiN },
        voicesStolen: alloc?.stolen ?? 0,
        culled: alloc?.culled ?? 0,
        ambience: { ...mix.layers } as Record<AmbienceLayerId, number>,
        muffle: mix.muffle,
        closeness: mix.closeness,
        rain: mix.rain,
        music: { enabled: musicEnabled, mood: musicEnabled ? mood : 'off', intensity: moodIntensity, notes: music?.notes ?? 0 },
        played: { ...(player?.played ?? {}) },
        nodes: engine?.nodes ?? 0,
        time: ctx ? ctx.currentTime : 0,
      };
    },
    destroy() {
      api.dispose();
      stopPump();
      try {
        music?.dispose();
        player?.stop(true);
        ambience?.dispose();
        engine?.close();
      } catch {
        /* ignore */
      }
      engine = null;
      ambience = null;
      player = null;
      music = null;
      scene = 'silent';
      mood = 'off';
      removeGesture();
    },
  };

  // ---- menu pump: music + UI voice clean-up while no game drives update() ------------------------
  let pump = 0;
  function stopPump(): void {
    if (pump) clearInterval(pump);
    pump = 0;
  }
  function pumpMenu(): void {
    if (pump || typeof setInterval === 'undefined') return;
    pump = setInterval(() => {
      if (app && !silentShot) return; // a game's frame loop is driving us
      if (!engine || !music || !player) return;
      try {
        const now = seconds();
        updateMood(0.1, now);
        player.update();
        ambience?.apply(mix.layers, 0, 0);
        music.mood = mood;
        music.intensity = moodIntensity;
        music.schedule(engine.now + 0.35);
      } catch {
        /* ignore */
      }
    }, 100) as unknown as number;
  }

  installDebugHook(() => volumes);
  return api;
}

// ---- debug / offline rendering -------------------------------------------------------------------

function installDebugHook(currentVolumes: () => AudioVolumes): void {
  const g = globalThis as { __myrmeAudio?: AudioDebugHook; OfflineAudioContext?: typeof OfflineAudioContext };
  if (g.__myrmeAudio) return;
  const moods: MusicMood[] = ['menu', 'calm', 'night', 'danger', 'infection', 'victory', 'defeat'];
  g.__myrmeAudio = {
    weather: null,
    underground: null,
    ids: () => [...Object.keys(SFX), ...LAYER_IDS.map((l) => `bed:${l}`), ...moods.map((m) => `music:${m}`), 'stinger:victory', 'stinger:defeat'],
    async renderOffline(id: string, seconds = 1.5): Promise<BufferStats & { buildMs: number; renderMs: number }> {
      const t0 = performance.now();
      const Off = g.OfflineAudioContext;
      if (!Off) throw new Error('OfflineAudioContext unavailable');
      const sr = 44100;
      const ctx = new Off(1, Math.floor(sr * seconds), sr);
      const e = new Engine(ctx);
      if (id.startsWith('bed:')) {
        const src = e.source(e.buffer(renderBed(id.slice(4) as AmbienceLayerId, BED_RATE), BED_RATE), true);
        const gain = e.gain(0.8 * BED_GAIN);
        src.connect(gain);
        gain.connect(e.buses.ambience);
        src.start(0);
      } else if (id.startsWith('music:') || id.startsWith('stinger:')) {
        const m = new Music(e);
        m.intensity = 0.8;
        if (id.startsWith('stinger:')) m.stinger(id.slice(8) as 'victory' | 'defeat');
        else {
          m.mood = id.slice(6) as MusicMood;
          m.schedule(seconds);
        }
      } else if (SFX[id]) new SfxPlayer(e).play(id);
      else throw new Error(`unknown audio id: ${id}`);
      const t1 = performance.now();
      const buf = await ctx.startRendering();
      return { ...analyze(buf.getChannelData(0)), buildMs: t1 - t0, renderMs: performance.now() - t1 };
    },
    record: null,
    async renderMix(spec: MixSpec): Promise<MixRenderStats> {
      const t0 = performance.now();
      const Off = g.OfflineAudioContext;
      if (!Off) throw new Error('OfflineAudioContext unavailable');
      const sr = 44100;
      const seconds = Math.max(0.5, spec.seconds);
      const ctx = new Off(2, Math.floor(sr * seconds), sr);
      const e = new Engine(ctx);
      const vol = { ...currentVolumes(), ...(spec.volumes ?? {}) };
      e.master.gain.value = volumeGain(vol.master);
      e.buses.ambience.gain.value = volumeGain(vol.ambience);
      e.buses.sfx.gain.value = volumeGain(vol.sfx);
      e.buses.ui.gain.value = volumeGain(vol.sfx);
      e.buses.music.gain.value = volumeGain(vol.music);
      e.setWorldTone(spec.muffle ?? 0, spec.closeness ?? 0);
      for (const id of LAYER_IDS) {
        const v = spec.layers?.[id] ?? 0;
        if (v <= 0.01) continue;
        const src = e.source(e.buffer(renderBed(id, BED_RATE), BED_RATE), true);
        const gain = e.gain(v * BED_GAIN);
        src.connect(gain);
        gain.connect(e.buses.ambience);
        src.start(0);
      }
      if (spec.mood && spec.mood !== 'off') {
        const m = new Music(e);
        m.intensity = spec.intensity ?? 0.8;
        if (spec.mood === 'victory' || spec.mood === 'defeat') m.stinger(spec.mood);
        else {
          m.mood = spec.mood;
          m.schedule(seconds);
        }
      }
      const player = new SfxPlayer(e);
      const events = [...(spec.events ?? [])].sort((a, b) => a.tick - b.tick);
      const tick0 = events.length ? events[0].tick : 0;
      const rate = 30 * (spec.speed ?? 1);
      const SLOT = 1 / 30;
      const slots = Math.floor(seconds / SLOT);
      let cursor = 0;
      let played = 0;
      let refused = 0;
      let maxVoices = 0;
      let maxNodes = 0;
      const fire = (until: number): void => {
        player.update();
        while (cursor < events.length && (events[cursor].tick - tick0) / rate <= until) {
          const ev = events[cursor++];
          const L = player.listener;
          L.x = ev.lx;
          L.y = ev.ly;
          L.z = ev.lz;
          L.ref = ev.ref;
          L.maxDist = ev.maxDist;
          setListener(ctx, { x: ev.lx, y: ev.ly, z: ev.lz }, { x: 0, y: 0, z: -1 }, UP);
          if (player.play(ev.id, { pos: ev.pos, gain: ev.gain, delay: ev.delay, pitch: ev.pitch })) played++;
          else refused++;
        }
        maxVoices = Math.max(maxVoices, player.allocator.count());
        maxNodes = Math.max(maxNodes, e.nodes);
      };
      fire(0);
      for (let i = 1; i < slots; i++) {
        const t = i * SLOT;
        void ctx.suspend(t).then(() => {
          fire(t);
          void ctx.resume();
        });
      }
      const buf = await ctx.startRendering();
      const a = analyze(buf.getChannelData(0));
      const b = analyze(buf.getChannelData(1));
      let maxStep = 0;
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 1; i < d.length; i++) {
          const st = Math.abs(d[i] - d[i - 1]);
          if (st > maxStep) maxStep = st;
        }
      }
      const perSecond: number[] = [];
      const left = buf.getChannelData(0);
      for (let s0 = 0; s0 + sr <= left.length; s0 += sr) perSecond.push(Math.round(analyze(left.subarray(s0, s0 + sr)).rms * 1000) / 1000);
      return { peak: Math.max(a.peak, b.peak), rms: Math.max(a.rms, b.rms), nan: a.nan + b.nan, length: a.length, played, refused, maxVoices, maxNodes, maxStep, perSecond, renderMs: performance.now() - t0 };
    },
  };
}
