/**
 * In-game shell (B5): everything that sits on top of the A5 HUD for one Game — goal tracker,
 * colony panel, field guide, tutorial, pause menu, settings, end screens — wired through the HUD
 * slot API. Created by the Game after `UiLayer.init`, updated once per frame, disposed with it.
 */
import { viewExt, type AppContext, type AudioLayerB5, type FrameInfo, type GameOptions, type QualityPreset } from '../core';
import { getInputApi } from '../input/api';
import { createCodex } from './codex';
import { createColonyPanel } from './colonyPanel';
import { Disposer, h } from './dom';
import { createEndScreen } from './endScreen';
import type { Feature, FeatureContext, ShellActions } from './features';
import { createGoalTracker } from './goals';
import { createPauseMenu } from './pauseMenu';
import { getSettings } from './settingsStore';
import { buildSettingsPanel, type SettingsPanel } from './settingsPanel';
import { SHELL_CSS } from './shellStyles';
import { getHud } from './slots';
import { registerHudCss } from './styles';
import { TimeSeriesRecorder } from './timeSeries';
import { createTutorial, type TutorialFeature } from './tutorial';

registerHudCss(SHELL_CSS);

/** Menu-side actions supplied by the app shell (absent when a Game runs without it). */
export interface GameShellHost {
  restart(): void;
  quitToMenu(): void;
}

export interface GameShellDeps {
  options: Readonly<GameOptions>;
  audio: AudioLayerB5 | null;
  host: GameShellHost | null;
  /** Run the onboarding hints and first-time tips. */
  tutorial: boolean;
  /** Quality preset fixed by the URL for this session (shown locked in the settings). */
  qualityLocked: QualityPreset | null;
}

export interface GameShell {
  readonly recorder: TimeSeriesRecorder;
  readonly actions: ShellActions;
  readonly tutorial: TutorialFeature;
  /** 'paused' | 'won' | 'lost' | 'playing' — what the shell overlays show. */
  screen(): 'playing' | 'paused' | 'won' | 'lost';
  closeAll(): void;
  update(frame: FrameInfo): void;
  dispose(): void;
}

const UPDATE_MS = 100;
const MENU_ICON = '<svg viewBox="0 0 16 16" class="mh-icon" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.500h10"/></svg>';

export function installGameShell(app: AppContext, deps: GameShellDeps): GameShell | null {
  const hud = getHud(app.view);
  if (!hud) return null;
  const d = new Disposer();
  const recorder = new TimeSeriesRecorder();
  const settings = getSettings();
  const audio = deps.audio;

  let settingsPanel: SettingsPanel | null = null;
  let settingsModal: { close(): void } | null = null;

  const actions: ShellActions = {
    hasMenu: !!deps.host,
    openPause() {
      pause.open();
    },
    openSettings(tab) {
      if (settingsModal) {
        settingsPanel?.setTab((tab as never) ?? 'graphics');
        return;
      }
      audio?.ui('open');
      const panel = buildSettingsPanel({
        store: settings,
        audio,
        close: () => settingsModal?.close(),
        initialTab: tab,
        qualityLocked: deps.qualityLocked,
        onReplayTutorial: () => tutorial.control('reset'),
      });
      settingsPanel = panel;
      settingsModal = hud.openModal(panel.el, {
        onClose: () => {
          panel.dispose();
          settingsPanel = null;
          settingsModal = null;
        },
      });
    },
    openCodex(entry) {
      codex.open(entry);
    },
    openColony(tab) {
      colony.open(tab);
    },
    openHelp() {
      getInputApi(app.view)?.trigger('ui.help');
    },
    restart() {
      deps.host?.restart();
    },
    quitToMenu() {
      deps.host?.quitToMenu();
    },
  };

  const ctx: FeatureContext = {
    app,
    hud,
    d,
    options: deps.options,
    settings,
    audio,
    recorder,
    shell: actions,
    input: () => getInputApi(app.view),
    colony: () => app.sim.getColony(app.sim.playerColony),
    hint(action) {
      try {
        return getInputApi(app.view)?.keymap.hint(action) ?? '';
      } catch {
        return '';
      }
    },
  };

  const goals = createGoalTracker(ctx);
  const colony = createColonyPanel(ctx);
  const codex = createCodex(ctx);
  const pause = createPauseMenu(ctx);
  const end = createEndScreen(ctx);
  const tutorial = createTutorial(ctx, { enabled: deps.tutorial, isColonyOpen: () => colony.isOpen() });
  const features: Feature[] = [goals, colony, codex, pause, end, tutorial];

  // ---- Esc with nothing left to cancel opens the pause menu ---------------------------------
  // Pushed first = asked last: open dialogs, tools, selection and possession all win.
  d.add(
    getInputApi(app.view)?.pushEscape(() => {
      const v = app.view;
      const e = viewExt(v);
      if (app.sim.possessedId || v.mode === 'possess' || v.tool || e?.activeTool || e?.followId || v.selection.length > 0) return false;
      if (pause.isOpen() || end.state() !== 'none') return false;
      pause.open();
      return true;
    }),
  );

  // ---- camera notices: explain the automatic cutaway and the opening move ---------------------
  let autoCutToasts = 0;
  const key = (action: 'view.cut' | 'cam.home' | 'view.cutBack' | 'view.cutFwd'): string => '`' + (ctx.hint(action) || '?') + '`';
  d.add(
    getInputApi(app.view)?.onHint((hint) => {
      switch (hint) {
        case 'autoCut':
          // explained a few times per game, then it is just how the camera behaves
          if (autoCutToasts++ < 3) hud.toast(`Cutaway on — you are looking inside the nest. ${key('view.cut')} switches it off, ${key('view.cutBack')} ${key('view.cutFwd')} move the slice.`, { severity: 'info', ttl: 9, key: 'hint:autoCut' });
          break;
        case 'introEnd':
          hud.toast(`Your nest is down here, under the entrance. ${key('view.cut')} toggles the cutaway; double-tap ${key('cam.home')} to come back to this view.`, { severity: 'good', ttl: 14, key: 'hint:intro' });
          break;
        case 'introSkip':
          hud.toast(`Your nest is underground: double-tap ${key('cam.home')} to look inside it (${key('view.cut')} toggles the cutaway).`, { severity: 'info', ttl: 12, key: 'hint:intro' });
          break;
        default:
          break;
      }
    }) ?? (() => undefined),
  );

  // ---- menu button at the end of the top bar ------------------------------------------------
  const speed = hud.root.querySelector('.mh-speed');
  if (speed) {
    const b = h('button', 'mh-btn ms-topmenu', { type: 'button', testid: 'menu-button', tip: 'Menu', 'aria-label': 'Menu' });
    b.innerHTML = MENU_ICON;
    d.on(b, 'click', () => {
      pause.open();
      b.blur();
    });
    speed.append(b);
    d.add(() => b.remove());
  }

  // ---- interface sounds for the plain HUD buttons (dialogs make their own) -----------------------
  d.on(hud.root, 'click', (e: MouseEvent) => {
    const t = e.target as HTMLElement | null;
    if (!t?.closest || !t.closest('.mh-btn, button.mh-chip')) return;
    if (t.closest('.ms-settings, .ms-pause, .ms-end, .ms-coach')) return;
    audio?.ui('click');
  });

  // ---- reduced motion ---------------------------------------------------------------------------
  const applyMotion = (): void => {
    hud.root.classList.toggle('mh-reduced', settings.value.ui.reducedMotion);
  };
  applyMotion();
  d.add(
    settings.subscribe((_s, changed) => {
      if (changed === 'ui' || changed === 'all') applyMotion();
    }),
  );

  let lastUpdate = -1e9;
  return {
    recorder,
    actions,
    tutorial,
    screen() {
      const s = end.state();
      if (s !== 'none') return s;
      return pause.isOpen() ? 'paused' : 'playing';
    },
    closeAll() {
      settingsModal?.close();
      codex.close();
      pause.close();
      colony.close();
    },
    update(frame) {
      recorder.observe(app.sim, frame.events);
      if (app.params.shot) return;
      const now = performance.now();
      for (const f of features) f.frame?.(frame, now);
      if (now - lastUpdate < UPDATE_MS && !frame.frozen) return;
      lastUpdate = now;
      for (const f of features) f.update?.(now, frame);
    },
    dispose() {
      settingsModal?.close();
      for (const f of features) {
        try {
          f.dispose?.();
        } catch {
          /* keep disposing */
        }
      }
      features.length = 0;
      d.dispose();
    },
  };
}
