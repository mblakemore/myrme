import { viewExt, type Ant, type AppContext, type Colony, type FrameInfo, type ViewExtA5 } from '../core';
import { getInputApi, type InputApi } from '../input/api';
import type { ActionId } from '../input/keybinds';
import type { Disposer } from './dom';
import type { Severity, ToastOptions } from './slots';

/** What every HUD component gets. `api()` / `ext()` are looked up lazily and may be undefined. */
export interface HudContext {
  readonly app: AppContext;
  readonly d: Disposer;
  api(): InputApi | undefined;
  ext(): ViewExtA5 | undefined;
  /** The player colony (undefined in fixtures without one). */
  colony(): Readonly<Colony> | undefined;
  /** Hotkey caption for an action ('' when unbound or the input API is missing). */
  hint(action: ActionId): string;
  trigger(action: ActionId): void;
  toast(text: string, opts?: ToastOptions): void;
  /** Bumped whenever the key bindings change — components re-read their hotkey captions. */
  keysVersion(): number;
}

export interface HudComponent {
  readonly el: HTMLElement;
  /** Model → DOM at ≤ 10 Hz (`now` = performance.now()). */
  update?(now: number, frame: FrameInfo): void;
  /** Every frame: only cheap, diffed writes (drag box, tooltip position) and event collection. */
  frame?(frame: FrameInfo, now: number): void;
  dispose?(): void;
}

export function makeContext(app: AppContext, d: Disposer, toast: (text: string, opts?: ToastOptions) => void, keysVersion: () => number = () => 0): HudContext {
  return {
    app,
    d,
    api: () => getInputApi(app.view),
    ext: () => viewExt(app.view),
    colony: () => app.sim.getColony(app.sim.playerColony),
    hint(action) {
      try {
        return getInputApi(app.view)?.keymap.hint(action) ?? '';
      } catch {
        return '';
      }
    },
    trigger(action) {
      getInputApi(app.view)?.trigger(action);
    },
    toast,
    keysVersion,
  };
}

export const SEVERITIES: readonly Severity[] = ['info', 'good', 'warn', 'danger'];

/** Display name of an ant's current activity: first task kind, else behavior id, else idle. */
export function antActivity(a: Readonly<Ant>): string {
  if (a.tasks.length) return a.tasks[0].kind;
  return a.behavior || 'idle';
}
