/**
 * HUD slot / panel API — how other UI code (B5: menu, tutorial, settings, goals, colony panel)
 * plugs into the A5 HUD without touching its files.
 *
 *     import { whenHud } from './slots';
 *     whenHud(app.view, (hud) => {
 *       const panel = hud.mountPanel({
 *         id: 'goals', title: 'Goals', slot: 'goal',
 *         render(body) { body.append(myElement); },
 *         update(frame) { ...patch text at your own rate... },
 *       });
 *       // later: panel.remove();
 *     });
 *
 * Slots (all are plain flex containers, `pointer-events:none` themselves — mounted panels get
 * `pointer-events:auto`):
 *   goal        under the top bar, left: the goal tracker (`ui/goals.ts`, `data-testid="goal"`).
 *   topLeft     column under the goal slot (tutorial hints…)
 *   topRight    column under the alerts feed
 *   left        left edge, vertically centred column
 *   right       right edge column above the toolbar (the colony quick-panel lives here)
 *   bottomRight row at the right end of the bottom bar
 *   modal       full-screen dimmed layer for dialogs (use `openModal`; Esc closes the top one)
 *   overlay     full-screen click-through layer (tutorial arrows, banners)
 *
 * The HUD registers itself against the game's shared `ViewState` object (same pattern as
 * `getInputApi`). `getHud` is undefined before `UiLayer.init` and after `dispose`; `whenHud` fires
 * immediately if the HUD exists, else on init. In shot mode (`?shot=1`) the HUD exists but is
 * hidden and its `update` hooks do not run.
 *
 * Styling: reuse the HUD classes — `.mh-panel` (glass card), `.mh-btn` (button), `.mh-chip`,
 * `.mh-bar` > `i` (progress bar), `.mh-kbd` (key cap), `.mh-row`, `.mh-dim`; colours are CSS
 * variables on `.myrme-hud` (`--mh-accent`, `--mh-amber`, `--mh-red`, `--mh-blue`, `--mh-text`…).
 * All sizes are `em` (root font-size scales with the viewport height).
 */
import type { FrameInfo, Vec3, ViewState } from '../core';

export type HudSlotId = 'goal' | 'topLeft' | 'topRight' | 'left' | 'right' | 'bottomRight' | 'modal' | 'overlay';

export const HUD_SLOTS: readonly HudSlotId[] = ['goal', 'topLeft', 'topRight', 'left', 'right', 'bottomRight', 'modal', 'overlay'];

export type Severity = 'info' | 'good' | 'warn' | 'danger';

export interface PanelDef {
  /** Unique id; mounting an id twice replaces the earlier panel. Also `data-testid="panel-<id>"`. */
  id: string;
  /** Header text ('' = no header). */
  title: string;
  slot: HudSlotId;
  /** Header click collapses the body. */
  collapsible?: boolean;
  /** Start collapsed (with `collapsible`). */
  collapsed?: boolean;
  /** Build the body once. */
  render(body: HTMLElement): void;
  /** Called at the HUD rate (≤ 10 Hz) while the HUD is visible — diff your own writes. */
  update?(frame: FrameInfo): void;
  /** Call `update` every rendered frame instead (only for cheap, diffed work such as event collection). */
  everyFrame?: boolean;
  dispose?(): void;
}

export interface PanelHandle {
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  setTitle(title: string): void;
  setVisible(visible: boolean): void;
  setCollapsed(collapsed: boolean): void;
  remove(): void;
}

export interface ModalOptions {
  /** Close on a backdrop click or Esc (default true). `false`: both are swallowed without closing. */
  dismissible?: boolean;
  /** Extra class on the dialog element. */
  className?: string;
  onClose?(): void;
}

export interface ToolbarButtonDef {
  id: string;
  /** Icon name from `ui/icons.ts` (optional). */
  icon?: string;
  label: string;
  /** Hotkey caption shown under the icon. A function is re-evaluated after key rebinding. */
  hint?: string | (() => string);
  tip?: string;
  onClick(): void;
  /** Polled at the HUD rate to show the pressed state. */
  active?(): boolean;
}

export interface ToastOptions {
  severity?: Severity;
  /** World position: clicking the toast jumps the camera there. */
  pos?: Vec3 | null;
  /** Seconds on screen (default 12). */
  ttl?: number;
  /** Merge key: a toast with the key of one still on screen refreshes it (default: the text). */
  key?: string;
}

export interface HudApi {
  readonly root: HTMLElement;
  slot(id: HudSlotId): HTMLElement;
  mountPanel(def: PanelDef): PanelHandle;
  /** Show a dialog in the modal layer. Pass an element or a builder that fills the dialog. */
  openModal(content: HTMLElement | ((dialog: HTMLElement, close: () => void) => void), opts?: ModalOptions): { close(): void };
  addToolbarButton(def: ToolbarButtonDef): { remove(): void };
  /** Push a message into the alerts feed. A `backticked` run in the text is drawn as a key cap. */
  toast(text: string, opts?: ToastOptions): void;
  /** Hide / show the whole HUD (menus, photo mode). */
  setHudVisible(visible: boolean): void;
  /** Attach a tooltip to any element inside the HUD (sets `data-tip`). */
  tip(el: HTMLElement, text: string): void;
  /** Fold / unfold the colony quick-panel (priority sliders, bottom right). */
  setQuickPanelCollapsed(collapsed: boolean): void;
  isQuickPanelCollapsed(): boolean;
}

const registry = new WeakMap<ViewState, HudApi>();
const waiting = new WeakMap<ViewState, ((hud: HudApi) => void)[]>();

export function registerHud(view: ViewState, hud: HudApi | null): void {
  if (!hud) {
    registry.delete(view);
    return;
  }
  registry.set(view, hud);
  const list = waiting.get(view);
  if (list) {
    waiting.delete(view);
    for (const cb of list) cb(hud);
  }
}

/** The HUD of a game's shared view object (undefined before `UiLayer.init`). */
export function getHud(view: ViewState): HudApi | undefined {
  return registry.get(view);
}

/** Run `cb` with the HUD — now if it exists, otherwise when it initialises. */
export function whenHud(view: ViewState, cb: (hud: HudApi) => void): void {
  const hud = registry.get(view);
  if (hud) {
    cb(hud);
    return;
  }
  const list = waiting.get(view);
  if (list) list.push(cb);
  else waiting.set(view, [cb]);
}
