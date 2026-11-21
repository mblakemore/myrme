/**
 * App shell (B5): owns the page flow — title menu ⇄ new-game flow → loading → game ⇄ pause →
 * end screens — and creates / destroys `Game` instances.
 *
 * BOOT
 *   - Direct boot (any D21 URL param: `map`, `faction`, `seed`, `autostart`, `shot`, `fixture`,
 *     `ants`, `frozen`): the Game is constructed and started synchronously in `boot()`, with
 *     `window.__myrme` set before `start()`, exactly as before the menu existed. No menu DOM is
 *     ever shown.
 *   - Menu boot (no such param, or `menu=1` / `autostart=0`): the title screen appears at once;
 *     an attract-mode Game (`options.attract`: no input, no HUD, drifting camera) is created
 *     behind it a couple of frames later. `window.__myrme` is only set while a PLAYABLE game
 *     exists; `window.__myrmeShell` (`ShellDebug`) always is.
 *
 * TEARDOWN: every transition disposes the current Game (listeners, HUD, audio voices, WebGL
 * context) before the next one is built — menu ↔ game can cycle indefinitely.
 */
import { DEFAULT_GAME_OPTIONS, type DebugApi, type GameOptions, type MapId, type NewGameConfig, type QualityPreset, type ShellDebug, type ShellScreen, type SpeciesId, type UrlParams } from '../core';
import { createAudio } from '../audio';
import { hudFontPx } from '../ui';
import { h, setClass } from '../ui/dom';
import { MenuUi, randomSeed, type MenuStep } from '../ui/menu';
import { buildSettingsPanel, type SettingsPanel } from '../ui/settingsPanel';
import { getSettings, type Settings } from '../ui/settingsStore';
import { SHELL_CSS } from '../ui/shellStyles';
import { getHud } from '../ui/slots';
import { acquireHudStyles, registerHudCss } from '../ui/styles';
import { getSpecies } from '../sim/data/species';
import { getMap } from '../world/maps';
import { Game } from './Game';
import { parseGameOptions, parseParams, urlFlag, urlHasQuality, wantsMenu } from './params';

declare global {
  interface Window {
    __myrme?: DebugApi;
    __myrmeShell?: ShellDebug;
  }
}

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Shortest time the loading screen stays up, so it reads as a screen rather than a flash. */
const MIN_LOADING_MS = 650;
/** Sim ticks the attract colony is fast-forwarded so the backdrop is already busy. */
const ATTRACT_WARMUP_TICKS = 450;

export class App {
  private readonly settings = getSettings();
  private readonly audio = createAudio();
  private readonly params: UrlParams;
  private readonly qualityLocked: boolean;
  private game: Game | null = null;
  private screen: ShellScreen = 'boot';
  private gamesCreated = 0;
  private busy = false;
  private lastCfg: NewGameConfig;

  // shell DOM (created lazily: a direct boot never needs it)
  private shellRoot: HTMLElement | null = null;
  private veil: HTMLElement | null = null;
  private settingsLayer: HTMLElement | null = null;
  private menu: MenuUi | null = null;
  private menuSettings: SettingsPanel | null = null;
  private releaseStyles: (() => void) | null = null;
  private attractTimer = 0;
  /** A menu screen forced over a running game through the debug hooks (screenshots). */
  private overlayOverGame = false;
  readonly debug: ShellDebug;

  constructor(
    private readonly root: HTMLElement,
    private readonly search: string,
  ) {
    this.params = parseParams(search);
    this.qualityLocked = urlHasQuality(search);
    const last = this.settings.value.lastGame;
    this.lastCfg = { ...last, seed: 1 };
    this.debug = this.createDebug();
  }

  // =====================================================================================
  // boot
  // =====================================================================================

  boot(): void {
    window.__myrmeShell = this.debug;
    this.applyAudioSettings(this.settings.value);
    this.settings.subscribe((s, changed) => {
      if (changed === 'audio' || changed === 'all') this.applyAudioSettings(s);
      if (changed === 'ui' || changed === 'all') this.applyShellFont();
    });
    // browsers only start audio after a gesture
    const unlock = (): void => {
      this.audio.unlock();
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    window.addEventListener('resize', () => this.applyShellFont());
    window.addEventListener('keydown', (e) => this.onKey(e));

    if (wantsMenu(this.search)) {
      this.showTitle();
      if (urlFlag(this.search, 'attract') !== false) this.scheduleAttract();
      return;
    }

    // ---- direct boot: synchronous, no menu in the way ----
    const options = parseGameOptions(this.search);
    this.lastCfg = { map: this.params.map, faction: this.params.faction, seed: this.params.seed, size: options.size ?? 'standard', difficulty: options.difficulty ?? 'normal', mode: options.mode ?? 'goal' };
    // no `quality=` in the URL: the saved preset applies (shots / tests always pin it)
    const params: UrlParams = this.qualityLocked || this.params.shot ? this.params : { ...this.params, quality: this.settings.value.graphics.quality };
    const game = this.createGame(params, options, urlFlag(this.search, 'tutorial') === true, this.qualityLocked, options.difficulty !== undefined);
    window.__myrme = game.debug;
    // `?frozen=1` (tools/shots.mjs): start with time frozen so scripted runs begin at exactly tick 0
    if (urlFlag(this.search, 'frozen') === true) game.debug.freezeTime(true);
    this.audio.setScene(this.params.shot ? 'silent' : 'game');
    game.start();
    this.screen = 'playing';
    game.playIntro();
  }

  private applyAudioSettings(s: Settings): void {
    const a = s.audio;
    this.audio.setVolumes({ master: a.master, ambience: a.ambience, sfx: a.sfx, music: a.music });
    this.audio.setMuted(a.muted);
    this.audio.setMusicEnabled(a.musicEnabled);
  }

  // =====================================================================================
  // games
  // =====================================================================================

  /**
   * Whether a new game opens with the camera move into the nest. `?intro=1` / `?intro=0` force it;
   * otherwise only menu-started games play it, and never automated browsers (e2e, screenshot
   * tooling), shot mode, a frozen boot or players who asked for reduced motion.
   */
  private wantsIntro(menuStarted: boolean): boolean {
    if (this.params.shot || urlFlag(this.search, 'frozen') === true) return false;
    const forced = urlFlag(this.search, 'intro');
    if (forced !== null) return forced;
    if (!menuStarted || this.reducedMotion()) return false;
    return !(typeof navigator !== 'undefined' && navigator.webdriver);
  }

  private createGame(params: UrlParams, options: Partial<GameOptions>, tutorial: boolean, qualityLocked: boolean, explicitDifficulty: boolean, menuStarted = false): Game {
    // `difficulty` is only forwarded when it was actually chosen (menu, or `?difficulty=`)
    const opts: Partial<GameOptions> = { ...options };
    if (!explicitDifficulty) delete opts.difficulty;
    const game = new Game(this.root, params, opts, {
      host: { restart: () => void this.restart(), quitToMenu: () => void this.toMenu() },
      shell: this.debug,
      tutorial,
      qualityLocked,
      intro: this.wantsIntro(menuStarted),
    });
    this.gamesCreated++;
    this.game = game;
    return game;
  }

  private disposeGame(): void {
    const g = this.game;
    this.game = null;
    if (!g) return;
    if (window.__myrme === g.debug) delete window.__myrme;
    try {
      g.dispose();
    } catch (err) {
      // a half-broken game must never block the way back to the menu
      console.warn('[myrme] error while disposing the game', err);
    }
  }

  private menuParams(map: MapId, faction: SpeciesId, seed: number): UrlParams {
    const quality: QualityPreset = this.qualityLocked ? this.params.quality : this.settings.value.graphics.quality;
    return { map, faction, seed, quality, autostart: true, shot: false, fixture: 'none', ants: this.params.ants };
  }

  private scheduleAttract(): void {
    window.clearTimeout(this.attractTimer);
    // let the menu paint (and its first animation frames run) before the blocking world build
    this.attractTimer = window.setTimeout(() => {
      if (this.game || this.busy || (this.screen !== 'title' && this.screen !== 'newGame' && this.screen !== 'settings')) return;
      try {
        this.root.style.transition = 'none';
        this.root.style.opacity = '0';
        const cfg = this.lastCfg;
        const game = new Game(this.root, this.menuParams(cfg.map, cfg.faction, 7), { ...DEFAULT_GAME_OPTIONS, attract: true });
        this.gamesCreated++;
        this.game = game;
        game.debug.step(ATTRACT_WARMUP_TICKS);
        game.start();
        // fade the world in behind the menu
        void this.root.offsetWidth;
        this.root.style.transition = '';
        this.root.style.opacity = '1';
      } catch (err) {
        // the menu works without a backdrop
        this.game = null;
        this.root.style.opacity = '1';
        console.warn('[myrme] attract scene unavailable:', err);
      }
    }, 120);
  }

  /** Resolves when no transition (start / restart / quit) is running. */
  private async idle(): Promise<void> {
    while (this.busy) await sleep(30);
  }

  async startGame(partial: Partial<NewGameConfig> = {}): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const cfg: NewGameConfig = { ...this.lastCfg, ...this.menu?.config, ...partial };
    if (!partial.seed && !this.menu) cfg.seed = this.lastCfg.seed || randomSeed();
    this.lastCfg = cfg;
    this.settings.set('lastGame', { map: cfg.map, faction: cfg.faction, size: cfg.size, difficulty: cfg.difficulty, mode: cfg.mode });
    window.clearTimeout(this.attractTimer);
    const shownAt = performance.now();
    try {
      this.ensureShell();
      this.closeMenuSettings();
      this.showLoadingScreen('Founding', `${getMap(cfg.map).name} · ${getSpecies(cfg.faction).name}`);
      this.audio.setScene('loading');
      await nextFrame();
      await nextFrame();
      this.disposeGame();
      this.root.style.transition = 'none';
      this.root.style.opacity = '1';
      await nextFrame();
      const game = this.createGame(this.menuParams(cfg.map, cfg.faction, cfg.seed), { mode: cfg.mode, difficulty: cfg.difficulty, size: cfg.size, attract: false }, true, this.qualityLocked, true, true);
      window.__myrme = game.debug;
      game.start();
      this.audio.setScene('game');
      const wait = MIN_LOADING_MS - (performance.now() - shownAt);
      if (wait > 0) await sleep(wait);
      this.screen = 'playing';
      await this.hideLoadingScreen();
      if (this.game === game) game.playIntro();
    } catch (err) {
      console.error('[myrme] could not start the game', err);
      this.disposeGame();
      // The loading screen sits on top of every menu layer: drop it at once, or the menu behind it
      // is unclickable and the only way out is a page reload.
      this.menu?.loadingEl.classList.remove('ms-show', 'ms-in');
      // Back to the setup step with the same choices, so a different seed / size / quality is one
      // click away.
      this.showTitle();
      if (this.menu) this.menu.go('setup');
      const detail = err instanceof Error && err.message ? ` (${err.message.replace(/^THREE\.\w+:\s*/, '').slice(0, 140)})` : '';
      this.toast(`The colony could not be founded${detail}. Try another seed, the small size, or a lower quality in Settings → Graphics.`);
      this.scheduleAttract();
    } finally {
      this.root.style.transition = '';
      this.busy = false;
    }
  }

  async restart(): Promise<void> {
    await this.startGame({ ...this.lastCfg });
  }

  async toMenu(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.ensureShell();
      this.showLoadingScreen('Leaving', 'the colony');
      await nextFrame();
      await nextFrame();
      this.disposeGame();
      this.audio.setScene('menu');
      this.showTitle();
      await sleep(250);
      await this.hideLoadingScreen();
    } finally {
      // never leave the loading screen covering the menu
      this.menu?.loadingEl.classList.remove('ms-show', 'ms-in');
      this.busy = false;
    }
    this.scheduleAttract();
  }

  // =====================================================================================
  // shell DOM
  // =====================================================================================

  private ensureShell(): HTMLElement {
    if (this.shellRoot) return this.shellRoot;
    registerHudCss(SHELL_CSS);
    this.releaseStyles = acquireHudStyles();
    const menu = new MenuUi(
      this.lastCfg.seed > 1 ? this.lastCfg : { ...this.lastCfg, seed: randomSeed() },
      {
        onStart: (cfg) => void this.startGame(cfg),
        onSettings: () => this.openMenuSettings(),
        onStep: (step) => this.onMenuStep(step),
      },
      this.audio,
      this.reducedMotion(),
    );
    this.menu = menu;
    this.veil = h('div', 'ms-veil');
    this.settingsLayer = h('div', 'ms-layer ms-menu-settings');
    const root = h('div', 'myrme-hud myrme-shell', { testid: 'shell' }, [this.veil, menu.titleEl, menu.newGameEl, this.settingsLayer, menu.loadingEl]);
    document.body.appendChild(root);
    this.shellRoot = root;
    this.applyShellFont();
    document.getElementById('boot')?.remove();
    return root;
  }

  private reducedMotion(): boolean {
    let system = false;
    try {
      system = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      /* no matchMedia */
    }
    return system || this.settings.value.ui.reducedMotion;
  }

  private applyShellFont(): void {
    if (!this.shellRoot) return;
    this.shellRoot.style.fontSize = `${hudFontPx(window.innerHeight, this.settings.value.ui.scale, window.innerWidth)}px`;
    setClass(this.shellRoot, 'mh-reduced', this.settings.value.ui.reducedMotion);
  }

  private setLayers(show: 'title' | 'newGame' | 'settings' | 'none', veil: '' | 'soft' | 'strong'): void {
    const m = this.menu;
    if (!m || !this.veil || !this.settingsLayer) return;
    setClass(m.titleEl, 'ms-show', show === 'title');
    setClass(m.newGameEl, 'ms-show', show === 'newGame');
    setClass(this.settingsLayer, 'ms-show', show === 'settings');
    setClass(this.veil, 'ms-show', veil !== '');
    setClass(this.veil, 'ms-strong', veil === 'strong');
  }

  private showTitle(): void {
    this.ensureShell();
    this.screen = 'title';
    this.audio.setScene('menu');
    if (this.menu!.currentStep !== 'title') this.menu!.go('title');
    else this.setLayers('title', 'soft');
  }

  private onMenuStep(step: MenuStep): void {
    if (step === 'title') {
      this.screen = 'title';
      this.setLayers('title', 'soft');
    } else {
      this.screen = 'newGame';
      this.setLayers('newGame', 'strong');
    }
  }

  private openMenuSettings(tab?: string): void {
    this.ensureShell();
    if (this.menuSettings) return;
    const panel = buildSettingsPanel({
      store: this.settings,
      audio: this.audio,
      close: () => this.closeMenuSettings(),
      initialTab: tab,
      qualityLocked: this.qualityLocked ? this.params.quality : null,
    });
    this.menuSettings = panel;
    this.settingsLayer!.replaceChildren(panel.el);
    this.screen = 'settings';
    this.setLayers('settings', 'strong');
    this.audio.ui('open');
  }

  private closeMenuSettings(): void {
    if (!this.menuSettings) return;
    this.menuSettings.dispose();
    this.menuSettings = null;
    this.settingsLayer?.replaceChildren();
    if (this.screen === 'settings') {
      this.audio.ui('close');
      this.onMenuStep(this.menu?.currentStep ?? 'title');
    }
  }

  private showLoadingScreen(what: string, detail: string, tip?: number): void {
    const m = this.menu!;
    this.screen = 'loading';
    m.setLoading(what, detail, tip);
    this.setLayers('none', '');
    m.loadingEl.classList.add('ms-show');
    // next style flush starts the fade-in (opaque at once when motion is reduced)
    void m.loadingEl.offsetWidth;
    m.loadingEl.classList.add('ms-in');
  }

  private async hideLoadingScreen(): Promise<void> {
    const el = this.menu?.loadingEl;
    if (!el) return;
    el.classList.remove('ms-in');
    await sleep(this.reducedMotion() ? 0 : 460);
    el.classList.remove('ms-show');
  }

  private toast(text: string): void {
    const root = this.ensureShell();
    const el = h('div', 'mh-panel ms-toast', { role: 'alert', testid: 'shell-toast' }, text);
    root.append(el);
    window.setTimeout(() => el.remove(), 7000);
  }

  private onKey(e: KeyboardEvent): void {
    // only the menu screens: in game, Esc is routed by the input layer
    if (this.screen !== 'title' && this.screen !== 'newGame' && this.screen !== 'settings') return;
    if (this.overlayOverGame && e.code === 'Escape') {
      this.debug.closeAll();
      return;
    }
    const target = e.target as HTMLElement | null;
    const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
    if (e.code === 'Escape') {
      if (this.screen === 'settings') {
        if (!this.menuSettings?.isCapturing()) this.closeMenuSettings();
      } else if (this.menu?.goBack()) this.audio.ui('back');
      e.preventDefault();
    } else if (e.code === 'Enter' && !typing && this.screen === 'newGame' && !(target && target.tagName === 'BUTTON')) {
      this.audio.ui('confirm');
      this.menu?.goNext();
      e.preventDefault();
    }
  }

  // =====================================================================================
  // debug hooks (tests, tools/shots.mjs --eval)
  // =====================================================================================

  private hudVisible(visible: boolean): void {
    const g = this.game;
    if (g && !g.options.attract) getHud(g.view)?.setHudVisible(visible);
  }

  private createDebug(): ShellDebug {
    const app = this;
    return {
      get screen(): ShellScreen {
        if (app.screen === 'playing') return app.game?.shell?.screen() ?? 'playing';
        return app.screen;
      },
      get gamesCreated() {
        return app.gamesCreated;
      },
      get gamesAlive() {
        return app.game && !app.game.isDisposed ? 1 : 0;
      },
      showMenu(step = 'title') {
        app.ensureShell();
        app.overlayOverGame = !!app.game && !app.game.options.attract;
        app.hudVisible(false);
        app.closeMenuSettings();
        if (step === 'settings') app.openMenuSettings();
        else {
          app.menu!.go(step);
          if (step === 'title') app.screen = 'title';
        }
      },
      showLoading(tip) {
        app.ensureShell();
        app.overlayOverGame = !!app.game && !app.game.options.attract;
        const c = app.lastCfg;
        app.showLoadingScreen('Founding', `${getMap(c.map).name} · ${getSpecies(c.faction).name}`, tip);
      },
      openPause() {
        app.game?.shell?.actions.openPause();
      },
      openSettings(tab) {
        if (app.game?.shell) app.game.shell.actions.openSettings(tab);
        else app.openMenuSettings(tab);
      },
      openColony(tab) {
        app.game?.shell?.actions.openColony(tab);
      },
      openCodex(entry) {
        app.game?.shell?.actions.openCodex(entry);
      },
      closeAll() {
        app.game?.shell?.closeAll();
        if (app.shellRoot) {
          app.closeMenuSettings();
          app.setLayers('none', '');
          app.menu?.loadingEl.classList.remove('ms-show', 'ms-in');
        }
        if (app.overlayOverGame || (app.game && !app.game.options.attract)) {
          app.overlayOverGame = false;
          app.screen = 'playing';
          app.hudVisible(true);
        }
      },
      // scripted callers may fire these back to back: wait out a running transition
      startGame: async (cfg) => {
        await app.idle();
        await app.startGame(cfg);
      },
      toMenu: async () => {
        await app.idle();
        await app.toMenu();
      },
      restart: async () => {
        await app.idle();
        await app.restart();
      },
      tutorial(op) {
        return app.game?.shell?.tutorial.control(op) ?? null;
      },
      settings: () => app.settings.value,
    };
  }

  /** Full teardown (tests / hot reload). */
  dispose(): void {
    window.clearTimeout(this.attractTimer);
    this.disposeGame();
    this.menuSettings?.dispose();
    this.menu?.dispose();
    this.shellRoot?.remove();
    this.shellRoot = null;
    this.releaseStyles?.();
    this.audio.destroy();
    delete window.__myrmeShell;
  }
}
