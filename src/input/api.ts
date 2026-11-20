import type { ActiveTool, EntityId, OrderKind, Vec3, ViewState } from '../core';
import type { ActionId, Keymap } from './keybinds';

/**
 * Input ↔ UI bridge. The Game hands both layers only the shared `AppContext`, so the input layer
 * registers this API against the shared `ViewState` object and the HUD (and B5 panels) look it up
 * with `getInputApi(app.view)`. Everything here is presentation-side: sim state still only changes
 * through `app.command(...)` (§5.1).
 */
export interface InputSettings {
  /** Pan when the cursor touches the window edge. */
  edgeScroll: boolean;
  /** Possession mouse-look sensitivity multiplier (1 = default). */
  mouseSensitivity: number;
  invertY: boolean;
}

export type SelectMode = 'replace' | 'add' | 'toggle';

/**
 * Camera notices the HUD may want to explain (see `InputApi.onHint`):
 *  - `autoCut`     the cutaway was switched on for the player (focus went underground / double-tap home)
 *  - `introStart`  the opening camera move began
 *  - `introEnd`    … ran to its end (cutaway on, looking into the nest)
 *  - `introSkip`   … was interrupted by the player
 */
export type InputHint = 'autoCut' | 'introStart' | 'introEnd' | 'introSkip';

export interface InputApi {
  readonly keymap: Keymap;
  readonly settings: InputSettings;

  /** Run an action exactly as if its key had been pressed (toolbar buttons, tutorial). */
  trigger(action: ActionId): void;
  /**
   * Subscribe to every fired action (after the input layer handled it). UI-only actions
   * (`ui.help`, `ui.debug`, `ui.colony`) are handled exclusively by subscribers.
   */
  onAction(fn: (action: ActionId) => void): () => void;
  /**
   * Push an Escape handler (most recent first). Return true to consume the key — used by modal
   * overlays so Esc closes them before it cancels tools / clears the selection.
   */
  pushEscape(fn: () => boolean): () => void;

  // ---- camera ----
  /** Smoothly move the map camera to look at a world position (optionally zooming to `dist`). */
  jumpTo(pos: Vec3, dist?: number): void;
  focusSelection(): void;
  jumpToNest(): void;
  setFollow(id: EntityId): void;
  flipSlab(): void;
  /**
   * Opening camera move (outdoor maps): hold on the nest entrance, switch the cutaway on and glide
   * down into the queen's chamber. Any key / click / camera input skips it. Returns false when it
   * does not apply (farm maps, shot mode, nest not underground).
   */
  playIntro(): boolean;
  readonly introActive: boolean;
  /** Subscribe to camera notices (auto cutaway, intro). */
  onHint(fn: (hint: InputHint) => void): () => void;

  // ---- selection / orders ----
  select(ids: EntityId[], mode?: SelectMode): void;
  setPrimary(id: EntityId): void;
  /** Control group members (alive only) for HUD badges; group 1..9. */
  groupMembers(group: number): EntityId[];
  /** Issue a target-less order (`stop`, `exile`) to the current selection. */
  orderSelection(order: Extract<OrderKind, 'stop' | 'exile'>): void;

  // ---- tools ----
  setTool(tool: ActiveTool): void;
  setBrushRadius(radius: number): void;
  setErase(erase: boolean): void;

  // ---- view ----
  setCut(enabled: boolean): void;
  moveCut(steps: number): void;
  snapCut(): void;
  setPheroVision(on: boolean): void;

  // ---- possession ----
  /** Possess `id`, or (0 / omitted) the primary selected ant, or the own ant nearest the cursor. */
  possess(id?: EntityId): void;
  release(): void;
  /** Local mirror of the trail toggle sent with `possessInput.actions.trail` (HUD indicator). */
  readonly trailOn: boolean;

  // ---- game ----
  setSpeed(speed: 1 | 2 | 4): void;
  setPaused(paused: boolean): void;
}

const registry = new WeakMap<ViewState, InputApi>();

export function registerInputApi(view: ViewState, api: InputApi | null): void {
  if (api) registry.set(view, api);
  else registry.delete(view);
}

/** The input API for a game's shared view object (undefined before `InputLayer.init`). */
export function getInputApi(view: ViewState): InputApi | undefined {
  return registry.get(view);
}
