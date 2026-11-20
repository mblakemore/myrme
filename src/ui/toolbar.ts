import type { BeaconKind } from '../core';
import type { ActionId } from '../input/keybinds';
import { getSpecies } from '../sim/data/species';
import type { HudComponent, HudContext } from './context';
import { cap, h, setClass, setShown, setText } from './dom';
import { icon } from './icons';
import type { ToolbarButtonDef } from './slots';

const BEACONS: readonly { kind: BeaconKind; tip: string }[] = [
  { kind: 'gather', tip: 'Gather beacon — foragers collect food around it' },
  { kind: 'dig', tip: 'Dig beacon — diggers work here first' },
  { kind: 'rally', tip: 'Rally beacon — idle ants assemble here' },
  { kind: 'attack', tip: 'Attack beacon — soldiers engage enemies around it' },
  { kind: 'avoid', tip: 'Avoid beacon — ants keep clear of the area' },
];
const BEACON_ICON: Record<BeaconKind, string> = { gather: 'food', dig: 'dig', rally: 'flag', attack: 'target', avoid: 'warn' };

interface Btn {
  el: HTMLButtonElement;
  active(): boolean;
  /** Bound action (built-in buttons): its hotkey caption is re-read after a rebind. */
  action?: ActionId;
  tip: string;
  small: boolean;
  /** Caption supplier of an extra button (`addToolbarButton` with a function `hint`). */
  hint?: () => string;
}

export interface ToolbarComponent extends HudComponent {
  addButton(def: ToolbarButtonDef): { remove(): void };
}

/** Bottom toolbar: paint tools, brush size, beacons, view toggles (+ the active-tool hint line). */
export function createToolbar(ctx: HudContext): ToolbarComponent {
  const { app } = ctx;
  const btns: Btn[] = [];

  const mk = (testid: string, ic: string, cls: string, tip: string, hint: string, onClick: () => void, active: () => boolean, small = false): HTMLButtonElement => {
    const el = h('button', `mh-btn mh-tool ${cls}${small ? ' mh-small' : ''}`, { type: 'button', testid, tip: hint ? `${tip} (${hint})` : tip }, [icon(ic), small ? null : h('span', 'mh-hint', null, hint || ' ')]);
    ctx.d.on(el, 'click', () => {
      onClick();
      el.blur();
    });
    btns.push({ el, active, tip, small });
    return el;
  };
  const action = (testid: string, ic: string, cls: string, tip: string, id: ActionId, active: () => boolean, small = false): HTMLButtonElement => {
    const el = mk(testid, ic, cls, tip, ctx.hint(id), () => ctx.trigger(id), active, small);
    btns[btns.length - 1].action = id;
    return el;
  };
  /** Re-read every hotkey caption from the live keymap (after rebinding in the settings screen). */
  const refreshHints = (): void => {
    for (const b of btns) {
      const hint = b.action ? ctx.hint(b.action) : b.hint ? b.hint() : null;
      if (hint === null) continue;
      b.el.dataset.tip = hint ? `${b.tip} (${hint})` : b.tip;
      const cap = b.el.querySelector('.mh-hint');
      if (cap && !b.small) cap.textContent = hint || ' ';
    }
    kEsc = ctx.hint('cancel') || 'Esc';
    kErase = ctx.hint('tool.erase');
  };
  let keysSeen = ctx.keysVersion();
  const tool = (): string | null => ctx.ext()?.activeTool ?? app.view.tool;

  const bDig = action('tool-dig', 'dig', 'mh-b-dig', 'Dig brush — paint tunnels and chambers', 'tool.dig', () => tool() === 'dig');
  const bBuild = action('tool-build', 'build', 'mh-b-dig', 'Build brush — paint mud walls', 'tool.build', () => tool() === 'build');
  const bErase = action('tool-erase', 'erase', 'mh-t-erase', 'Erase designations', 'tool.erase', () => !!ctx.ext()?.erase);
  const bMinus = action('brush-down', 'minus', 'mh-t-neutral', 'Smaller brush', 'tool.brushDown', () => false, true);
  const brushVal = h('b', undefined, { testid: 'brush-radius' }, '2');
  const brush = h('div', 'mh-brush', { tip: 'Brush radius (voxels)' }, [brushVal, h('span', undefined, null, 'brush')]);
  const bPlus = action('brush-up', 'plus', 'mh-t-neutral', 'Larger brush', 'tool.brushUp', () => false, true);

  const beaconBtns = BEACONS.map((b) => action(`beacon-${b.kind}`, BEACON_ICON[b.kind], `mh-b-${b.kind}`, b.tip, `beacon.${b.kind}` as ActionId, () => tool() === `beacon:${b.kind}`));

  const bCut = action('toggle-cut', 'cut', 'mh-t-cut', 'Cutaway view', 'view.cut', () => app.view.cut.enabled);
  const bPhero = action('toggle-phero', 'eye', 'mh-t-phero', 'Pheromone vision', 'view.phero', () => app.view.pheroVision);
  const bFollow = action('toggle-follow', 'follow', 'mh-t-neutral', 'Camera follows the selected ant', 'cam.follow', () => (ctx.ext()?.followId ?? 0) !== 0);
  const bHelp = action('toggle-help', 'help', 'mh-t-neutral', 'Keys & help', 'ui.help', () => false);

  const sep = (): HTMLElement => h('span', 'mh-sep');
  const extra = h('span', 'mh-row mh-hidden');
  const extraSep = h('span', 'mh-sep mh-hidden');
  const bar = h('div', 'mh-panel mh-toolbar', { testid: 'toolbar' }, [bDig, bBuild, bErase, bMinus, brush, bPlus, sep(), ...beaconBtns, sep(), bCut, bPhero, bFollow, bHelp, extraSep, extra]);
  const hint = h('div', 'mh-panel mh-toolhint mh-hidden', { testid: 'tool-hint' });
  const el = h('div', 'mh-toolwrap', null, [hint, bar]);

  let kEsc = ctx.hint('cancel') || 'Esc';
  let kErase = ctx.hint('tool.erase');

  return {
    el,
    addButton(def) {
      const hintFn = typeof def.hint === 'function' ? def.hint : null;
      const b = mk(`tool-x-${def.id}`, def.icon ?? 'info', 'mh-t-neutral', def.tip ?? def.label, hintFn ? hintFn() : ((def.hint as string | undefined) ?? ''), def.onClick, def.active ?? (() => false));
      if (hintFn) btns[btns.length - 1].hint = hintFn;
      b.setAttribute('aria-label', def.label);
      extra.append(b);
      setShown(extra, true);
      setShown(extraSep, true);
      return {
        remove() {
          b.remove();
          const i = btns.findIndex((x) => x.el === b);
          if (i >= 0) btns.splice(i, 1);
          const empty = extra.childElementCount === 0;
          setShown(extra, !empty);
          setShown(extraSep, !empty);
        },
      };
    },
    update() {
      if (keysSeen !== ctx.keysVersion()) {
        keysSeen = ctx.keysVersion();
        refreshHints();
      }
      const colony = ctx.colony();
      const canFill = getSpecies(colony?.species ?? app.sim.options.faction).caps.canFill;
      setShown(bBuild, canFill);
      for (const b of btns) setClass(b.el, 'mh-on', b.active());
      const ext = ctx.ext();
      const r = ext?.brushRadius ?? 2;
      setText(brushVal, Number.isInteger(r) ? String(r) : r.toFixed(1));
      const t = tool();
      let text = '';
      if (t === 'dig' || t === 'build') {
        const erase = !!ext?.erase;
        text = `${erase ? `Erasing ${t}` : cap(t)} designations · brush r=${Number.isInteger(r) ? r : r.toFixed(1)} — drag to paint${kErase ? `, ${kErase} ${erase ? 'paint' : 'erase'}` : ''}, ${kEsc} cancel`;
      } else if (t && t.startsWith('beacon:')) {
        text = `${cap(t.slice(7))} beacon — click to place, click a beacon to remove it, ${kEsc} cancel`;
      }
      setShown(hint, text !== '');
      if (text) setText(hint, text);
    },
  };
}
