/**
 * Shared context for the B5 in-game shell features (goal tracker, colony panel, tutorial, codex,
 * pause / end screens). Each feature is a small factory `(ctx) => Feature` that mounts itself
 * through the A5 HUD slot API (`ctx.hud`) and is driven by `installGameShell` (`./gameShell.ts`):
 *
 *   - `frame(frame, now)`   every rendered frame while the HUD exists — ONLY for collecting
 *                           `frame.events` (valid during the frame, D19) and other O(1) work
 *   - `update(now, frame)`  ≤ 10 Hz — model → DOM with diffed writes (`./dom.ts` setters)
 *   - `dispose()`           remove everything (listeners go through `ctx.d`)
 *
 * Features never touch sim state: commands go through `ctx.app.command`, camera / selection
 * through `ctx.input()`.
 */
import type { AppContext, AudioLayerB5, Colony, FrameInfo, GameOptions } from '../core';
import type { InputApi } from '../input/api';
import type { ActionId } from '../input/keybinds';
import type { Disposer } from './dom';
import type { SettingsStore } from './settingsStore';
import type { HudApi } from './slots';
import type { TimeSeriesRecorder } from './timeSeries';

/** What the shell can do for a feature (all safe to call at any time). */
export interface ShellActions {
  /** Open / close the pause menu (pauses the sim while open). */
  openPause(): void;
  openSettings(tab?: string): void;
  openCodex(entry?: string): void;
  openColony(tab?: string): void;
  openHelp(): void;
  restart(): void;
  quitToMenu(): void;
  /** True when the game was started from the menu (restart / quit make sense). */
  readonly hasMenu: boolean;
}

export interface FeatureContext {
  readonly app: AppContext;
  readonly hud: HudApi;
  /** Disposed with the game shell. */
  readonly d: Disposer;
  readonly options: Readonly<GameOptions>;
  readonly settings: SettingsStore;
  /** Null only in unit-test style setups. */
  readonly audio: AudioLayerB5 | null;
  /** 1 Hz ring buffer of colony metrics for this game (sparklines, end-screen stats). */
  readonly recorder: TimeSeriesRecorder;
  readonly shell: ShellActions;
  input(): InputApi | undefined;
  /** The player colony (undefined in fixtures without one). */
  colony(): Readonly<Colony> | undefined;
  /** Hotkey caption for an action ('' when unbound). Re-read it after a `keys` settings change. */
  hint(action: ActionId): string;
}

export interface Feature {
  frame?(frame: FrameInfo, now: number): void;
  update?(now: number, frame: FrameInfo): void;
  dispose?(): void;
}
