import {
  DEFAULT_GAME_OPTIONS,
  DIFFICULTY_INTENSITY,
  SANDBOX_GOAL,
  TICK_DT,
  makeCameraState,
  type AppContext,
  type AudioLayerB5,
  type CameraPose,
  type CameraState,
  type Command,
  type DebugApiB5,
  type FrameInfo,
  type GameOptions,
  type InputLayer,
  type MapGenResult,
  type QualityPreset,
  type ShellDebug,
  type SimOptionsB1,
  type SimEvent,
  type UiLayer,
  type UrlParams,
  type ViewState,
} from '../core';
import { createAudio } from '../audio';
import { createInput } from '../input';
import { getInputApi } from '../input/api';
import { MODULES } from '../render/modules';
import { Renderer } from '../render/Renderer';
import { QUALITY_PRESETS } from '../render/shared';
import { Simulation } from '../sim/Simulation';
import { createUi } from '../ui';
import { installGameShell, type GameShell, type GameShellHost } from '../ui/gameShell';
import { getSettings, type Settings } from '../ui/settingsStore';
import { getMap } from '../world/maps';
import { createLookOverride, type LookToggles } from './lookOverride';

/** Max sim ticks per rendered frame (4× speed needs 2 at 60 fps; the cap absorbs hitches). */
const MAX_TICKS_PER_FRAME = 8;

/** What the app shell hands a Game (all optional: `new Game(root, params)` still works alone). */
export interface GameHooks {
  /** Menu-side actions for the pause menu / end screens (restart, quit to menu…). */
  host?: GameShellHost;
  /** Shell debug hooks surfaced as `__myrme.shell`. */
  shell?: ShellDebug | null;
  /** Run the onboarding hints (menu-started games; `?tutorial=1` on direct boots). */
  tutorial?: boolean;
  /** Play the opening camera move into the nest once the game is shown (`Game.playIntro`). */
  intro?: boolean;
  /** The URL fixed the quality preset: the saved graphics quality is ignored for this session. */
  qualityLocked?: boolean;
}

/**
 * Game orchestrator: map → world → sim → renderer → input / ui / audio, the main loop, and the
 * D21 debug API (`window.__myrme`).
 *
 * Loop (per animation frame): accumulate real time × speed, run whole 30 Hz ticks, then present
 * with `alpha` = leftover fraction of a tick (render interpolates poses, D13). Events buffered by
 * the sim are drained once per frame (D19) and handed to input/ui/audio/render via `FrameInfo`.
 *
 * B5: a Game is created and destroyed by the app shell (`./App.ts`). `options` carries the menu
 * choices (see `core/contracts/b5.ts`); `options.attract` makes it the menu backdrop — no input
 * layer and no HUD, the camera drifts on its own. `dispose()` releases everything it created,
 * including the WebGL context, so menu ↔ game can cycle indefinitely.
 */
export class Game {
  readonly sim: Simulation;
  readonly renderer: Renderer;
  readonly view: ViewState;
  readonly input: InputLayer | null;
  readonly ui: UiLayer | null;
  readonly audio: AudioLayerB5;
  readonly debug: DebugApiB5;
  readonly options: GameOptions;
  readonly shell: GameShell | null = null;

  private readonly app: AppContext;
  private readonly map: MapGenResult;
  private readonly toggles: LookToggles = { dof: true, bloom: true, grain: true };
  private readonly unsubSettings: (() => void) | null = null;
  private acc = 0;
  private last = 0;
  private renderTime = 0;
  private frameNo = 0;
  private frozen = false;
  private running = false;
  private disposed = false;
  private raf = 0;
  private pendingEvents: SimEvent[] = [];
  private attractAngle = 0;
  private qualityPreset: QualityPreset;

  constructor(
    private readonly root: HTMLElement,
    readonly params: UrlParams,
    options: Partial<GameOptions> = {},
    private readonly hooks: GameHooks = {},
  ) {
    this.options = { ...DEFAULT_GAME_OPTIONS, ...options };
    const opts = this.options;
    const map = getMap(params.map).generate(params.seed, { faction: params.faction, small: opts.size === 'small' ? true : undefined });
    // sandbox: no win condition (the lose condition is still the queen)
    if (opts.mode === 'sandbox') map.goal = { ...SANDBOX_GOAL };
    this.map = map;
    const simOptions: SimOptionsB1 = { seed: params.seed, faction: params.faction, fixture: params.fixture, fixtureAnts: params.ants };
    // difficulty only when the caller chose one: a plain `?map=…` boot passes nothing extra
    // …except the rival a goal depends on: `?map=forest` must not sit at "0/1 rivals" forever (M3).
    // The director itself stays off on a plain direct boot (tests / shots want a quiet, repeatable
    // scene); `?difficulty=normal` turns the full game on.
    if (map.goal.kind === 'eliminateRival' && params.fixture === 'none') simOptions.rivals = true;
    if (options.difficulty) {
      const on = options.difficulty !== 'peaceful';
      simOptions.director = { enabled: on, intensity: DIFFICULTY_INTENSITY[options.difficulty] };
      simOptions.rivals = on || map.goal.kind === 'eliminateRival';
    }
    this.sim = new Simulation(params.map, map, simOptions);
    this.view = {
      mode: map.cameraMode,
      camera: makeCameraState(),
      selection: [],
      hoverId: 0,
      possessedId: 0,
      firstPerson: false,
      cut: { enabled: false, axis: 'z', pos: 0, sign: 1 },
      pheroVision: false,
      tool: null,
      dragBox: null,
      cursorWorld: null,
    };
    this.qualityPreset = params.quality;
    this.renderer = new Renderer(root, this.sim, this.view, params, [...MODULES, createLookOverride(this.toggles)]);
    const sim = this.sim;
    const renderer = this.renderer;
    this.app = {
      sim,
      view: this.view,
      params,
      root,
      canvas: renderer.canvas,
      command: (cmd: Command) => sim.command(cmd),
      renderStats: () => renderer.stats(),
      viewport: () => ({ width: root.clientWidth, height: root.clientHeight }),
    };
    this.audio = createAudio();
    if (opts.attract) {
      this.input = null;
      this.ui = null;
      this.driveAttractCamera(0);
    } else {
      this.input = createInput();
      this.ui = createUi();
      this.input.init(this.app);
      this.ui.init(this.app);
    }
    this.audio.init(this.app);

    // saved settings → renderer / input (shot mode stays deterministic: defaults only)
    if (!params.shot) {
      const store = getSettings();
      this.applySettings(store.value, 'all');
      this.unsubSettings = store.subscribe((s, changed) => this.applySettings(s, changed));
    }
    if (!opts.attract) {
      this.shell = installGameShell(this.app, { options: opts, audio: this.audio, host: hooks.host ?? null, tutorial: !!hooks.tutorial, qualityLocked: hooks.qualityLocked ? params.quality : null });
    }
    this.debug = this.createDebugApi(hooks.shell ?? null);
  }

  /** Live-apply settings: graphics toggles + render scale + quality preset, input options, keymap. */
  private applySettings(s: Settings, changed: keyof Settings | 'all'): void {
    if (changed === 'all' || changed === 'graphics') {
      const g = s.graphics;
      this.toggles.dof = g.dof;
      this.toggles.bloom = g.bloom;
      this.toggles.grain = g.grain;
      // the preset itself: live, unless the URL pinned it (initial value comes in via `params`)
      if (changed === 'graphics' && !this.hooks.qualityLocked && !this.params.shot) this.setQuality(g.quality);
      this.setRenderScale(g.renderScale);
    }
    const api = getInputApi(this.view);
    if (api && (changed === 'all' || changed === 'controls')) {
      api.settings.mouseSensitivity = s.controls.mouseSensitivity;
      api.settings.invertY = s.controls.invertY;
      api.settings.edgeScroll = s.controls.edgeScroll;
    }
    if (api && (changed === 'all' || changed === 'keys')) {
      api.keymap.reset();
      api.keymap.load(s.keys);
    }
  }

  /** Switch the quality preset live (rebuilds the effect chain; world content adapts where modules read `ctx.quality`). */
  setQuality(preset: QualityPreset): void {
    if (this.disposed || preset === this.qualityPreset) return;
    this.qualityPreset = preset;
    this.renderer.setQuality(preset);
  }

  get quality(): QualityPreset {
    return this.qualityPreset;
  }

  /** Render resolution multiplier (≤ 1) on top of the preset's pixel-ratio cap. */
  private setRenderScale(scale: number): void {
    const q = this.renderer.ctx.quality;
    const base = Math.min(window.devicePixelRatio || 1, QUALITY_PRESETS[q.preset].maxPixelRatio);
    const want = base * Math.min(1, Math.max(0.5, scale));
    if (Math.abs(q.maxPixelRatio - want) < 1e-4) return;
    (q as { maxPixelRatio: number }).maxPixelRatio = want;
    this.renderer.resize();
  }

  /** Renders the first frame synchronously (all chunks meshed), then starts the loop. */
  /**
   * Opening camera move: entrance → cutaway → queen's chamber (outdoor maps; skippable). Only when
   * the shell asked for it (`hooks.intro`), never in shot / attract games or with time frozen.
   */
  playIntro(): boolean {
    if (!this.hooks.intro || this.params.shot || this.frozen || !this.input) return false;
    return getInputApi(this.view)?.playIntro() ?? false;
  }

  start(): void {
    this.present(0, true);
    this.debug.ready = true;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number): void => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      // rAF timestamps are frame-start times and can lie before `last` (set after a long blocking
      // first render / debug step): never let time run backwards
      const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
      this.last = now;
      this.advance(dt);
      this.present(dt, false);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private tick(): void {
    const t0 = performance.now();
    this.sim.step();
    this.sim.recordTickMs(performance.now() - t0);
  }

  private advance(dt: number): void {
    const sim = this.sim;
    if (this.frozen || sim.paused || sim.speed === 0) return;
    this.acc += dt * sim.speed;
    let n = 0;
    while (this.acc >= TICK_DT && n < MAX_TICKS_PER_FRAME) {
      this.tick();
      this.acc -= TICK_DT;
      n++;
    }
    if (this.acc > TICK_DT) this.acc = TICK_DT; // dropped time after a hitch
  }

  private present(dt: number, sync: boolean): void {
    if (this.disposed) return;
    const sim = this.sim;
    const stopped = this.frozen || sim.paused;
    if (!this.frozen) this.renderTime += dt;
    const drained = sim.drainEvents();
    const events = this.pendingEvents.length ? this.pendingEvents.concat(drained) : drained;
    this.pendingEvents = [];
    const frame: FrameInfo = {
      dt: this.frozen ? 0 : dt,
      time: this.renderTime,
      alpha: stopped ? 1 : Math.min(1, this.acc / TICK_DT),
      tick: sim.tick,
      events,
      frozen: this.frozen,
      frame: this.frameNo++,
    };
    if (this.input) this.input.update(frame);
    else this.driveAttractCamera(frame.dt);
    this.ui?.update(frame);
    this.shell?.update(frame);
    this.audio.update(frame);
    if (sync) this.renderer.renderSync(frame);
    else this.renderer.render(frame);
  }

  // ---- attract mode (menu backdrop) -------------------------------------------------------

  /** Slow orbit (outdoor) / sideways sway (farm) around the map's start pose. No input layer exists. */
  private driveAttractCamera(dt: number): void {
    this.attractAngle += dt;
    const t = this.attractAngle;
    const pose: CameraPose = this.map.shotPoses.overview ?? this.map.cameraStart;
    const [tx, ty, tz] = pose.target;
    let dx = pose.pos[0] - tx;
    let dy = pose.pos[1] - ty;
    let dz = pose.pos[2] - tz;
    const cam = this.view.camera;
    if (this.map.flags.slab) {
      // sway along the pane and breathe in/out a little
      const along = Math.sin(t * 0.05) * 9;
      const zoom = 0.62 + 0.06 * Math.sin(t * 0.031);
      const ax = this.map.flags.slabAxis === 'z' ? 1 : 0;
      setCamera(cam, tx + dx * zoom + along * ax, ty + dy * zoom + 1.5 * Math.sin(t * 0.04), tz + dz * zoom + along * (1 - ax), tx + along * ax * 0.8, ty, tz + along * (1 - ax) * 0.8, pose.fov);
    } else {
      // closer and lower than the overview, orbiting slowly
      const a = t * 0.035;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const rx = dx * c - dz * s;
      const rz = dx * s + dz * c;
      dx = rx * 0.5;
      dz = rz * 0.5;
      dy = dy * (0.34 + 0.04 * Math.sin(t * 0.05));
      setCamera(cam, tx + dx, ty + dy, tz + dz, tx, ty + 2, tz, pose.fov);
    }
  }

  // ---- debug API (D21 + B5) ------------------------------------------------------------------

  private createDebugApi(shell: ShellDebug | null): DebugApiB5 {
    const game = this;
    const sim = this.sim;
    const api: DebugApiB5 = {
      ready: false,
      step(n: number): number {
        for (let i = 0; i < n; i++) game.tick();
        game.acc = 0;
        game.input?.snapCamera();
        game.present(0, true);
        return sim.tick;
      },
      setCamera(pose) {
        game.input?.setCameraPose(pose);
        game.present(0, true);
      },
      freezeTime(frozen: boolean) {
        game.frozen = frozen;
        game.acc = 0;
        game.last = performance.now();
      },
      stateHash: () => sim.stateHash(),
      stats: () => ({ ...sim.stats(), ...game.renderer.stats(), map: sim.mapId, seed: sim.options.seed, quality: game.renderer.ctx.quality.preset, gpu: game.renderer.gpu }),
      sim,
      command: (cmd: Command) => sim.command(cmd),
      select: (ids) => game.input?.select(ids),
      possess(id) {
        game.input?.select([id]);
        sim.command({ type: 'possessStart', id });
      },
      release() {
        sim.command({ type: 'possessStop' });
      },
      view: this.view,
      renderNow() {
        game.input?.snapCamera();
        game.present(0, true);
      },
      audio: this.audio,
      emit(events) {
        const list = (Array.isArray(events) ? events : [events]) as SimEvent[];
        for (const e of list) game.pendingEvents.push({ ...e, tick: (e as { tick?: number }).tick ?? sim.tick } as SimEvent);
      },
      options: this.options,
      params: this.params,
      shell,
    };
    return api;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.unsubSettings?.();
    this.shell?.dispose();
    this.input?.dispose();
    this.ui?.dispose();
    this.audio.dispose();
    const gl = this.renderer.ctx.renderer;
    this.renderer.dispose();
    // three's dispose() keeps the GL context alive until GC — browsers cap live contexts (~16),
    // so cycling menu ↔ game must release it explicitly
    try {
      gl.forceContextLoss();
    } catch {
      /* already lost */
    }
    this.pendingEvents = [];
    this.debug.ready = false;
  }
}

/** Fill a `CameraState` from eye / target points (attract mode — the input layer normally does this). */
function setCamera(cam: CameraState, px: number, py: number, pz: number, tx: number, ty: number, tz: number, fov?: number): void {
  let fx = tx - px;
  let fy = ty - py;
  let fz = tz - pz;
  const dist = Math.hypot(fx, fy, fz) || 1;
  fx /= dist;
  fy /= dist;
  fz /= dist;
  // right = forward × worldUp ; up = right × forward
  let rx = -fz;
  let rz = fx;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl;
  rz /= rl;
  cam.pos.x = px;
  cam.pos.y = py;
  cam.pos.z = pz;
  cam.forward.x = fx;
  cam.forward.y = fy;
  cam.forward.z = fz;
  cam.up.x = -rz * fy;
  cam.up.y = rz * fx - rx * fz;
  cam.up.z = rx * fy;
  cam.focus.x = tx;
  cam.focus.y = ty;
  cam.focus.z = tz;
  cam.focusDist = dist;
  if (fov) cam.fov = fov;
}
