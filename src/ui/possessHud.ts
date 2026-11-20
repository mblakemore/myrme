import { MATERIALS, type Ant } from '../core';
import type { ActionId } from '../input/keybinds';
import { getSpecies } from '../sim/data/species';
import type { HudComponent, HudContext } from './context';
import { fmtNum, h, humanize, renderKeyed, setClass, setShown, setText } from './dom';
import { casteIcon, icon } from './icons';
import { setBar } from './selectionPanel';

function bar(cls = ''): { el: HTMLElement; fill: HTMLElement } {
  const fill = h('i');
  return { el: h('span', `mh-bar ${cls}`, null, [fill]), fill };
}

/** floor / wall / ceiling from the ant's local up. */
export function surfaceKind(upY: number): 'floor' | 'wall' | 'ceiling' {
  return upY > 0.5 ? 'floor' : upY < -0.5 ? 'ceiling' : 'wall';
}

/**
 * In-possession HUD: vitals, what the ant carries and stands on, the suspended task queue it
 * will resume on release, and action hints with live key caps.
 */
export function createPossessHud(ctx: HudContext): HudComponent & { captureEl: HTMLElement } {
  const { app } = ctx;
  const tIcon = h('span', 'mh-row');
  const tName = h('span');
  const tMode = h('span', 'mh-viewmode');
  const health = bar();
  const healthT = h('span');
  const energy = bar('mh-energy');
  const energyT = h('span');
  const carry = h('b');
  const surface = h('b');
  const trail = h('b');
  const trailWrap = h('span', undefined, null, ['Trail ', trail]);
  const resume = h('div', 'mh-resume');

  const hintRow = h('div', 'mh-hints');
  const kbd = (s: string): HTMLElement => h('span', 'mh-kbd', null, s);
  const hintOf = (label: string, keys: string[]): HTMLElement => h('span', undefined, null, [...keys.filter(Boolean).map(kbd), ` ${label}`]);
  const k = (id: ActionId, fallback: string): string => ctx.hint(id) || fallback;
  function buildHints(): void {
    hintRow.replaceChildren(
      hintOf('crawl', [`${k('p.forward', 'W')}${k('p.left', 'A')}${k('p.back', 'S')}${k('p.right', 'D')}`]),
      hintOf('sprint', [k('p.sprint', 'Shift')]),
      hintOf('bite', ['LMB']),
      hintOf('dig', ['RMB']),
      hintOf('pick up / drop', [k('p.pickup', 'E')]),
      hintOf('trail', [k('p.trail', 'R')]),
      hintOf('recruit', [k('p.recruit', 'Q')]),
      hintOf('view', [k('p.view', 'V')]),
      hintOf('hop', [k('p.prev', ','), k('p.next', '.')]),
      hintOf('release', [k('possess.toggle', 'F'), k('cancel', 'Esc')]),
    );
  }
  buildHints();

  const el = h('div', 'mh-panel mh-possess mh-hidden', { testid: 'possess-hud' }, [
    h('div', 'mh-title', null, [tIcon, tName, tMode]),
    h('div', 'mh-bars', null, [h('span', undefined, null, 'Health'), h('span', 'mh-row', null, [health.el, healthT]), h('span', undefined, null, 'Energy'), h('span', 'mh-row', null, [energy.el, energyT])]),
    h('div', 'mh-facts', null, [h('span', undefined, null, ['Carrying ', carry]), h('span', undefined, null, ['On ', surface]), trailWrap]),
    resume,
    hintRow,
  ]);
  const capture = h('div', 'mh-panel mh-capture mh-hidden', { testid: 'capture-hint' }, [icon('mouse'), h('span', undefined, null, 'Click to capture the mouse')]);

  let lastIcon = '';

  function carryText(a: Readonly<Ant>): string {
    const c = a.carrying;
    if (!c) return 'nothing';
    if (c.kind === 'brood') return 'brood';
    return `${humanize(c.itemKind).toLowerCase()}${c.amount > 0 ? ` ×${fmtNum(c.amount)}` : ''}`;
  }

  return {
    el,
    captureEl: capture,
    update() {
      const view = app.view;
      const ant = view.mode === 'possess' ? app.sim.getAnt(view.possessedId || app.sim.possessedId) : undefined;
      setShown(el, !!ant);
      setShown(capture, !!ant && !app.params.shot && document.pointerLockElement !== app.canvas);
      if (!ant) return;
      const sp = getSpecies(ant.species);
      const ci = casteIcon(ant.caste);
      if (ci !== lastIcon) {
        lastIcon = ci;
        tIcon.replaceChildren(icon(ci));
      }
      setText(tName, `Controlling ${sp.name.toLowerCase()} ${(sp.castes[ant.caste]?.name ?? ant.caste).toLowerCase()}`);
      setText(tMode, view.firstPerson ? '1st person' : '3rd person');
      setBar(health, ant.health / Math.max(1e-6, ant.maxHealth));
      setText(healthT, `${fmtNum(Math.max(0, Math.ceil(ant.health)))}/${fmtNum(ant.maxHealth)}`);
      setBar(energy, ant.energy, 0.25);
      setText(energyT, `${Math.round(Math.min(1, Math.max(0, ant.energy)) * 100)}%`);
      setText(carry, carryText(ant));

      const kind = ant.falling ? 'falling' : surfaceKind(ant.up.y);
      const w = app.sim.world;
      const mat = w.materialAt(Math.floor(ant.pos.x - ant.up.x * 0.8), Math.floor(ant.pos.y - ant.up.y * 0.8), Math.floor(ant.pos.z - ant.up.z * 0.8));
      const matName = mat > 0 ? (MATERIALS[mat]?.name ?? '').toLowerCase() : '';
      // out of bounds on a glass map = the pane
      const onPane = !matName && w.boundary === 'glass';
      setText(surface, kind === 'falling' ? 'nothing — falling' : `${matName || (onPane ? 'glass' : 'ground')} ${kind}`);

      const trailOn = !!ctx.api()?.trailOn;
      setText(trail, trailOn ? 'on' : 'off');
      setClass(trailWrap, 'mh-on', trailOn);

      let key = '';
      for (const t of ant.tasks) key += `${t.kind}:${t.source},`;
      renderKeyed(resume, key, () => {
        if (!ant.tasks.length) return [h('span', 'mh-dim', null, 'No queued tasks — it will return to colony duty on release')];
        const out: Node[] = [h('span', 'mh-dim', null, 'Will resume:')];
        const shown = ant.tasks.slice(0, 6);
        shown.forEach((t, i) => {
          if (i) out.push(h('span', 'mh-arrow', null, '→'));
          out.push(h('span', `mh-task${t.source === 'player' ? ' mh-player' : ''}`, null, humanize(t.kind).toLowerCase()));
        });
        if (ant.tasks.length > shown.length) out.push(h('span', 'mh-dim', null, `+${ant.tasks.length - shown.length}`));
        return out;
      });
    },
    dispose() {
      capture.remove();
    },
  };
}
