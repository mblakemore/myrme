/**
 * Contract extensions owned by stream B5 (PLAN §10.2, D22) — game shell, settings, audio.
 * Additive only — never redefines or widens a type from `core/contracts.ts`.
 *
 * WHAT THE SHELL PASSES INTO A GAME
 *   `GameOptions` (second argument of `new Game(root, params, options)`), derived from the menu's
 *   `NewGameConfig`:
 *     - `difficulty` → B1's `SimOptionsB1.director` (`{ enabled: difficulty !== 'peaceful',
 *       intensity: DIFFICULTY_INTENSITY[difficulty] }`) and `rivals` in the sim options. Omitted
 *       (plain `?map=…` boots) the sim keeps its defaults (director off).
 *     - `mode: 'sandbox'` → the generated map's `goal` is replaced by `SANDBOX_GOAL` before the
 *       sim is constructed (so `sim.goal.def.kind === 'sandbox'`: no win condition)
 *     - `size: 'small'` → `MapGenOptions.small`
 *     - `attract` → menu backdrop: no input / HUD, the Game drives a slow camera drift itself
 *
 * DEBUG API: `window.__myrme` is a `DebugApiB5` (a superset of the frozen D21 `DebugApi`).
 */
import type { AudioLayer, DebugApi, GoalDef, MapId, SimEvent, SpeciesId, UrlParams } from '../contracts';
import type { Difficulty } from './b1';

// =====================================================================================
// Game options (menu → Game → sim)
// =====================================================================================

/** `Difficulty` and `DIFFICULTY_INTENSITY` (director budget multiplier, PLAN §2) are B1's — see `./b1.ts`. */
export const DIFFICULTIES: readonly Difficulty[] = ['peaceful', 'easy', 'normal', 'hard', 'brutal'];

export type GameMode = 'goal' | 'sandbox';
export type MapSize = 'small' | 'standard';

export interface GameOptions {
  mode: GameMode;
  difficulty: Difficulty;
  size: MapSize;
  /** Menu backdrop game: no input layer, no HUD, self-driven camera, never ends. */
  attract: boolean;
}

export const DEFAULT_GAME_OPTIONS: Readonly<GameOptions> = { mode: 'goal', difficulty: 'normal', size: 'standard', attract: false };

/** Goal installed on the generated map in sandbox mode. */
export const SANDBOX_GOAL: Readonly<GoalDef> = { id: 'sandbox', kind: 'sandbox', target: 0, label: 'Sandbox — no goal, just the colony' };

/** What the New Game flow collects. */
export interface NewGameConfig {
  map: MapId;
  faction: SpeciesId;
  seed: number;
  size: MapSize;
  difficulty: Difficulty;
  mode: GameMode;
}

// =====================================================================================
// Audio (src/audio) — superset of the frozen `AudioLayer`
// =====================================================================================

export type AudioBus = 'ambience' | 'sfx' | 'music' | 'ui';
export const AUDIO_BUSES: readonly AudioBus[] = ['ambience', 'sfx', 'music', 'ui'];

/** Linear 0..1 volumes. The `ui` bus follows `sfx`. */
export interface AudioVolumes {
  master: number;
  ambience: number;
  sfx: number;
  music: number;
}

export type UiSound = 'hover' | 'click' | 'toggle' | 'confirm' | 'back' | 'error' | 'open' | 'close' | 'order' | 'alertInfo' | 'alertGood' | 'alertWarn' | 'alertDanger' | 'tick';

/** What the shell is showing: decides menu theme vs in-game ambience / adaptive music. */
export type AudioScene = 'silent' | 'menu' | 'loading' | 'game';

export type MusicMood = 'off' | 'menu' | 'calm' | 'night' | 'danger' | 'infection' | 'victory' | 'defeat';

/** Ambience bed ids (each is one layered generator with its own gain). */
export type AmbienceLayerId =
  | 'breeze'
  | 'birds'
  | 'insects'
  | 'crickets'
  | 'nightWind'
  | 'forest'
  | 'desertWind'
  | 'underground'
  | 'skitter'
  | 'roomTone'
  | 'clockTick'
  | 'lampHum'
  | 'rain'
  | 'rainClose'
  | 'gusts'
  | 'flood';

/** `__myrme.audio.stats()` — lets tests assert audio behaviour without listening. */
export interface AudioStats {
  /** AudioContext state; `'none'` before the context exists (no user gesture yet). */
  state: 'none' | 'suspended' | 'running' | 'closed';
  unlocked: boolean;
  scene: AudioScene;
  muted: boolean;
  volumes: AudioVolumes;
  /** Currently sounding one-shot / looped voices (sfx + ui), total and per bus. */
  voices: number;
  voicesByBus: Record<AudioBus, number>;
  /** Voices refused or stolen by the allocator since the context started. */
  voicesStolen: number;
  /** Events skipped for distance. */
  culled: number;
  /** Target mix 0..1 per ambience layer (what the engine is crossfading towards). */
  ambience: Record<AmbienceLayerId, number>;
  /** 0 = open air … 1 = deep underground / muffled (drives the world low-pass). */
  muffle: number;
  /** 0 = far overview … 1 = ant-scale close-up / first person (closer, bassier world). */
  closeness: number;
  /** Rain bed strength 0..1 after intensity, muffling and scene. */
  rain: number;
  music: { enabled: boolean; mood: MusicMood; intensity: number; notes: number };
  /** One-shots triggered so far, by sfx id (e.g. `dig`, `bite`, `thunder`, `ui.click`). */
  played: Record<string, number>;
  /** AudioNodes created by the engine that are still alive (leak check: returns to the idle baseline). */
  nodes: number;
  /** Seconds of context time. */
  time: number;
}

/**
 * The audio layer B5 implements. One engine per page: `createAudio()` hands every Game the same
 * instance; `init(app)` binds it to that game, `dispose()` unbinds (kills world voices, keeps the
 * AudioContext for the menu). `destroy()` closes the context and frees every node.
 */
export interface AudioLayerB5 extends AudioLayer {
  setVolumes(v: Partial<AudioVolumes>): void;
  setMusicEnabled(on: boolean): void;
  setScene(scene: AudioScene): void;
  /** UI feedback blip (no-op until unlocked). */
  ui(sound: UiSound): void;
  /** One-off musical stinger; also latches the music mood until the scene changes. */
  stinger(kind: 'victory' | 'defeat'): void;
  stats(): AudioStats;
  destroy(): void;
}

// =====================================================================================
// Debug API (D21 superset)
// =====================================================================================

export type ShellScreen = 'boot' | 'title' | 'newGame' | 'settings' | 'loading' | 'playing' | 'paused' | 'won' | 'lost';

/** Shell hooks for tests and `tools/shots.mjs --eval`. All screens can be forced over a running game. */
export interface ShellDebug {
  readonly screen: ShellScreen;
  /** Number of Game instances created / currently alive (leak checks). */
  readonly gamesCreated: number;
  readonly gamesAlive: number;
  /** Show the title screen (`step` picks a New Game step: 'map' | 'faction' | 'setup'). */
  showMenu(step?: 'title' | 'map' | 'faction' | 'setup' | 'settings'): void;
  showLoading(tip?: number): void;
  openPause(): void;
  openSettings(tab?: 'graphics' | 'audio' | 'controls' | 'keys' | 'game'): void;
  openColony(tab?: string): void;
  openCodex(entry?: string): void;
  /** Close every shell overlay and return to the running game. */
  closeAll(): void;
  /** Start a game from the menu flow (resolves when it is running). */
  startGame(cfg?: Partial<NewGameConfig>): Promise<void>;
  toMenu(): Promise<void>;
  restart(): Promise<void>;
  /** Tutorial: restart from step 0 / jump to a step / read the state. */
  tutorial(op: 'reset' | 'skip' | 'state' | number): unknown;
  /** Current settings object (live). */
  settings(): unknown;
}

export interface DebugApiB5 extends DebugApi {
  audio: AudioLayerB5;
  /**
   * Inject fabricated sim events into the next frame's `FrameInfo.events` (D19 path), exactly as
   * if the sim had emitted them — ui / audio / render react normally. Sim state is not touched.
   */
  emit(events: SimEvent | SimEvent[] | { type: string; [k: string]: unknown } | { type: string; [k: string]: unknown }[]): void;
  /** Options this game was started with. */
  options: GameOptions;
  /** The boot parameters of this game (map, faction, seed, quality, …) as resolved from the URL or the menu. */
  params: UrlParams;
  /** Null when the game was constructed without the app shell (never in the real page). */
  shell: ShellDebug | null;
}
