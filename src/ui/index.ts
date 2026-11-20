import { viewExt, type AppContext, type FrameInfo, type UiLayer } from '../core';
import type { ActionId } from '../input/keybinds';
import { createAlerts } from './alerts';
import { hudFontPx } from './scale';
import { makeContext, type HudComponent } from './context';
import { createDebugOverlay } from './debugOverlay';
import { Disposer, h, setClass, setShown, setStyle, setText } from './dom';
import { buildHelp } from './help';
import { icon } from './icons';
import { createMinimap } from './minimap';
import { createPossessHud } from './possessHud';
import { createQuickPanel } from './quickPanel';
import { createSelectionPanel } from './selectionPanel';
import { HUD_SLOTS, registerHud, type HudApi, type HudSlotId, type PanelDef, type PanelHandle } from './slots';
import { getSettings } from './settingsStore';
import { acquireHudStyles } from './styles';
import { createToolbar } from './toolbar';
import { createTooltip } from './tooltip';
import { createTopBar } from './topbar';

export { getHud, whenHud } from './slots';
export type { HudApi, HudSlotId, PanelDef, PanelHandle, ToolbarButtonDef, ToastOptions, ModalOptions, Severity } from './slots';

/** HUD model → DOM rate (real time). Per-frame work is limited to cheap diffed writes. */
const UPDATE_INTERVAL_MS = 100;

export { hudFontPx, autoUiScale } from './scale';

/**
 * UI layer (§5.4): the in-game HUD. Vanilla DOM + one injected stylesheet. The HUD only reads
 * `app.sim` / `app.view` and talks back through `app.command(...)` and the input API
 * (`getInputApi(app.view)`); it never mutates sim or view state itself.
 *
 * Other UI code mounts into it through the slot API in `./slots` (`getHud` / `whenHud`).
 * Hidden entirely in shot mode (`?shot=1`).
 */
export function createUi(): UiLayer {
  let app!: AppContext;
  let root: HTMLDivElement | null = null;
  let releaseStyles: (() => void) | null = null;
  const d = new Disposer();
  let components: HudComponent[] = [];
  const panels = new Map<string, { def: PanelDef; handle: PanelHandle }>();
  const slots = new Map<HudSlotId, HTMLElement>();
  const modals: { close(): void; dismissible: boolean }[] = [];
  let keysVersion = 0;
  let lastUpdate = -1e9;
  let lastSig = '';
  let fontPx = 0;
  let hudVisible = true;
  let subscribed = false;
  let frameHooks: ((frame: FrameInfo, now: number) => void)[] = [];
  let slowHooks: ((now: number, frame: FrameInfo) => void)[] = [];
  let onActionFn: ((a: ActionId) => void) | null = null;

  function mountPanel(def: PanelDef): PanelHandle {
    panels.get(def.id)?.handle.remove();
    const body = h('div', 'mh-panel-body');
    const titleEl = h('span', undefined, null, def.title);
    const head = h('div', `mh-panel-head${def.collapsible ? ' mh-click' : ''}`, null, [titleEl, def.collapsible ? icon('chevron', 'mh-chev') : null]);
    const el = h('div', 'mh-panel', { testid: `panel-${def.id}` }, [head, body]);
    setShown(head, def.title !== '');
    let collapsed = !!def.collapsed && !!def.collapsible;
    setClass(el, 'mh-collapsed', collapsed);
    const onHead = (): void => {
      if (!def.collapsible) return;
      collapsed = !collapsed;
      setClass(el, 'mh-collapsed', collapsed);
    };
    head.addEventListener('click', onHead);
    const slot = slots.get(def.slot) ?? slots.get('right')!;
    slot.append(el);
    def.render(body);
    const handle: PanelHandle = {
      el,
      body,
      setTitle(title) {
        setText(titleEl, title);
        setShown(head, title !== '');
      },
      setVisible(visible) {
        setShown(el, visible);
      },
      setCollapsed(c) {
        collapsed = c;
        setClass(el, 'mh-collapsed', collapsed);
      },
      remove() {
        if (panels.get(def.id)?.handle !== handle) return;
        panels.delete(def.id);
        head.removeEventListener('click', onHead);
        try {
          def.dispose?.();
        } finally {
          el.remove();
        }
      },
    };
    panels.set(def.id, { def, handle });
    return handle;
  }

  return {
    init(a) {
      app = a;
      releaseStyles = acquireHudStyles();
      root = document.createElement('div');
      root.className = 'myrme-hud';
      root.dataset.testid = 'hud';
      const rootEl = root;

      // ---- slots ----
      for (const id of HUD_SLOTS) slots.set(id, h('div', `mh-slot mh-slot-${id}`, { 'data-slot': id }));
      const slot = (id: HudSlotId): HTMLElement => slots.get(id)!;

      // ---- components ----
      const alertsRef: { push?: (text: string, opts?: Parameters<HudApi['toast']>[1]) => void } = {};
      const ctx = makeContext(app, d, (text, opts) => alertsRef.push?.(text, opts), () => keysVersion);
      const topbar = createTopBar(ctx);
      const alerts = createAlerts(ctx);
      alertsRef.push = alerts.push;
      const minimap = createMinimap(ctx);
      const selection = createSelectionPanel(ctx);
      const toolbar = createToolbar(ctx);
      const quick = createQuickPanel(ctx);
      const possess = createPossessHud(ctx);
      const debug = createDebugOverlay(ctx);
      const tooltip = createTooltip(ctx, rootEl);
      components = [topbar, alerts, minimap, selection, toolbar, quick, possess, debug, tooltip];

      const dragBox = h('div', 'mh-dragbox mh-hidden', { testid: 'dragbox' });
      const reticle = h('div', 'mh-reticle mh-hidden', { testid: 'reticle' });

      // ---- layout ----
      const dockTL = h('div', 'mh-slot mh-dock-tl', null, [slot('goal'), slot('topLeft')]);
      const dockTR = h('div', 'mh-slot mh-dock-tr', null, [alerts.el, slot('topRight')]);
      slot('right').append(quick.el);
      const bottom = h('div', 'mh-bottom', null, [minimap.el, selection.el, toolbar.el, slot('bottomRight')]);
      rootEl.append(dragBox, reticle, slot('overlay'), topbar.el, dockTL, dockTR, slot('left'), slot('right'), bottom, possess.el, possess.captureEl, debug.el, slot('modal'), tooltip.el);

      // HUD clicks must never reach the canvas / start a browser drag or context menu
      d.on(rootEl, 'contextmenu', (e: Event) => e.preventDefault());
      d.on(rootEl, 'dragstart', (e: Event) => e.preventDefault());

      // ---- font scaling (viewport height × the UI-scale setting) + rebinding refresh ----
      const settings = getSettings();
      d.add(
        settings.subscribe((_s, changed) => {
          if (changed === 'ui' || changed === 'all') applyFont();
          if (changed === 'keys' || changed === 'all') keysVersion++;
        }),
      );
      const applyFont = (): void => {
        const px = hudFontPx(app.viewport().height || window.innerHeight, app.params.shot ? 1 : settings.value.ui.scale, app.viewport().width || window.innerWidth);
        if (px === fontPx) return;
        fontPx = px;
        rootEl.style.fontSize = `${px}px`;
        minimap.resize(px);
      };
      applyFont();
      d.on(window, 'resize', applyFont);

      // ---- modals ----
      const modalLayer = slot('modal');
      const openModal: HudApi['openModal'] = (content, opts = {}) => {
        let dialog: HTMLElement;
        let closed = false;
        let popEscape: (() => void) | undefined;
        const handle = {
          dismissible: opts.dismissible !== false,
          close(): void {
            if (closed) return;
            closed = true;
            popEscape?.();
            dialog.remove();
            const i = modals.indexOf(handle);
            if (i >= 0) modals.splice(i, 1);
            setClass(modalLayer, 'mh-open', modals.length > 0);
            opts.onClose?.();
          },
        };
        if (typeof content === 'function') {
          dialog = h('div', `mh-panel mh-dialog ${opts.className ?? ''}`);
          content(dialog, handle.close);
        } else dialog = content;
        modalLayer.append(dialog);
        modals.push(handle);
        setClass(modalLayer, 'mh-open', true);
        popEscape = ctx.api()?.pushEscape(() => {
          if (closed) return false;
          // a non-dismissible dialog swallows Esc without closing (end screens, confirmations)
          if (handle.dismissible) handle.close();
          return true;
        });
        return handle;
      };
      d.on(modalLayer, 'pointerdown', (e: PointerEvent) => {
        if (e.target !== modalLayer) return;
        // backdrop click closes the top modal — unless it was opened with `dismissible: false`
        const top = modals[modals.length - 1];
        if (top?.dismissible) top.close();
      });
      // Esc fallback when the input API is not there to route it
      d.on(window, 'keydown', (e: KeyboardEvent) => {
        if (e.key === 'Escape' && modals.length && !ctx.api() && modals[modals.length - 1].dismissible) modals[modals.length - 1].close();
      });

      let helpModal: { close(): void } | null = null;
      const toggleHelp = (): void => {
        if (helpModal) {
          helpModal.close();
          return;
        }
        const helpD = new Disposer();
        const el = buildHelp({ ...ctx, d: helpD }, () => helpModal?.close());
        helpModal = openModal(el, {
          onClose: () => {
            helpModal = null;
            helpD.dispose();
          },
        });
      };

      // ---- input actions handled by the HUD ----
      onActionFn = (action) => {
        if (action === 'ui.help') toggleHelp();
        else if (action === 'ui.debug') debug.toggle();
      };
      const subscribe = (): void => {
        if (subscribed) return;
        const api = ctx.api();
        if (!api || !onActionFn) return;
        subscribed = true;
        d.add(api.onAction(onActionFn));
      };
      subscribe();
      // without the input API (never in the real game) keep the two overlay keys working
      d.on(window, 'keydown', (e: KeyboardEvent) => {
        if (ctx.api()) return;
        if (e.code === 'F1' || (e.code === 'Slash' && e.shiftKey)) {
          toggleHelp();
          e.preventDefault();
        } else if (e.code === 'F9') debug.toggle();
      });

      // ---- per-frame hook: drag box, reticle, mode visibility ----
      let lastMode = '';
      frameHooks = [
        (frame, now) => {
          const view = app.view;
          const b = view.dragBox;
          setShown(dragBox, !!b);
          if (b) {
            setStyle(dragBox, 'transform', `translate(${Math.min(b.x0, b.x1)}px,${Math.min(b.y0, b.y1)}px)`);
            setStyle(dragBox, 'width', `${Math.abs(b.x1 - b.x0)}px`);
            setStyle(dragBox, 'height', `${Math.abs(b.y1 - b.y0)}px`);
          }
          const possessing = view.mode === 'possess';
          setShown(reticle, possessing && view.firstPerson);
          if (view.mode !== lastMode) {
            lastMode = view.mode;
            setShown(selection.el, !possessing);
            setShown(toolbar.el, !possessing);
            setShown(quick.el, !possessing);
            lastUpdate = -1e9; // refresh the model right away on a mode switch
          }
          for (const c of components) c.frame?.(frame, now);
          for (const p of panels.values()) if (p.def.everyFrame) p.def.update?.(frame);
        },
      ];
      slowHooks = [
        (now, frame) => {
          subscribe();
          applyFont();
          for (const c of components) c.update?.(now, frame);
          // mounted panels update at the HUD rate (≤ 10 Hz) unless they asked for every frame
          for (const p of panels.values()) if (!p.def.everyFrame) p.def.update?.(frame);
        },
      ];

      if (app.params.shot) rootEl.style.display = 'none';
      app.root.appendChild(rootEl);
      applyFont();

      // ---- public slot API ----
      const hud: HudApi = {
        root: rootEl,
        slot,
        mountPanel,
        openModal,
        addToolbarButton: (def) => toolbar.addButton(def),
        toast: (text, opts) => alerts.push(text, opts),
        setHudVisible(visible) {
          hudVisible = visible;
          if (!app.params.shot) rootEl.style.display = visible ? '' : 'none';
        },
        tip(el, text) {
          el.dataset.tip = text;
        },
        setQuickPanelCollapsed: (collapsed) => quick.setCollapsed(collapsed),
        isQuickPanelCollapsed: () => quick.isCollapsed(),
      };
      registerHud(app.view, hud);
    },

    update(frame: FrameInfo) {
      if (!root || app.params.shot) return;
      const now = performance.now();
      if (!hudVisible) {
        // keep collecting alerts so nothing is lost while a menu covers the HUD
        for (const c of components) if (c.frame && c.el.dataset.testid === 'alerts') c.frame(frame, now);
        return;
      }
      for (const f of frameHooks) f(frame, now);
      // Throttled to 10 Hz — except when something the player just did changed what the HUD
      // shows (selection, mode, tool, speed…): that must appear on the very next frame.
      const v = app.view;
      const e = viewExt(v);
      const sig = `${v.mode}|${v.selection.length}|${v.selection[0] ?? 0}|${e?.primaryId ?? 0}|${v.possessedId}|${v.firstPerson ? 1 : 0}|${e?.activeTool ?? ''}|${e?.erase ? 1 : 0}|${e?.brushRadius ?? 0}|${v.cut.enabled ? 1 : 0}|${v.pheroVision ? 1 : 0}|${e?.followId ?? 0}|${app.sim.paused ? 1 : 0}|${app.sim.speed}|${frame.frozen ? frame.tick : 0}`;
      if (sig === lastSig && now - lastUpdate < UPDATE_INTERVAL_MS) return;
      lastSig = sig;
      lastUpdate = now;
      for (const f of slowHooks) f(now, frame);
    },

    dispose() {
      if (app) registerHud(app.view, null);
      for (const m of modals.slice()) m.close();
      modals.length = 0;
      for (const p of [...panels.values()]) p.handle.remove();
      for (const c of components) c.dispose?.();
      components = [];
      frameHooks = [];
      slowHooks = [];
      onActionFn = null;
      subscribed = false;
      d.dispose();
      slots.clear();
      root?.remove();
      releaseStyles?.();
      root = null;
      releaseStyles = null;
    },
  };
}
