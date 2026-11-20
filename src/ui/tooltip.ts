import type { Ant, Brood, Creature, Entity, FoodSource, Item } from '../core';
import { contextOrderKind, orderVerb, type OrderTarget } from '../input/orders';
import { getCreature } from '../sim/data/creatures';
import { getSpecies } from '../sim/data/species';
import { antActivity, type HudComponent, type HudContext } from './context';
import { fmtNum, h, humanize, setClass, setShown, setStyle, setText } from './dom';
import { icon } from './icons';

const DOM_DELAY_MS = 300;
const WORLD_DELAY_MS = 120;

/**
 * Tooltips. (1) Delegated: any HUD element with `data-tip` shows its text after ~300 ms.
 * (2) World hover: driven by `view.hoverId` + the pointer published by the input layer; shows
 * what is under the cursor and, with a selection, the verb a right-click would issue.
 */
export function createTooltip(ctx: HudContext, root: HTMLElement): HudComponent {
  const { app } = ctx;
  const title = h('span');
  const titleRow = h('div', 'mh-tt-title', null, [title]);
  const sub = h('div', 'mh-tt-sub');
  const fill = h('i');
  const bar = h('span', 'mh-bar', null, [fill]);
  const verbText = h('span');
  const verb = h('div', 'mh-tt-verb', null, [icon('mouse'), verbText]);
  const el = h('div', 'mh-panel mh-tooltip mh-hidden', { testid: 'tooltip' }, [titleRow, bar, sub, verb]);

  // ---- delegated DOM tooltips ----
  let domTarget: HTMLElement | null = null;
  let domSince = 0;
  let domShown = false;
  let px = 0;
  let py = 0;
  ctx.d.on(root, 'pointerover', (e: PointerEvent) => {
    const t = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-tip]') ?? null;
    if (t !== domTarget) {
      domTarget = t;
      domSince = performance.now();
      domShown = false;
    }
  });
  ctx.d.on(root, 'pointerleave', () => {
    domTarget = null;
    domShown = false;
  });
  ctx.d.on(root, 'pointerdown', () => {
    // a click dismisses the tip until the pointer moves to another element
    domSince = Infinity;
    domShown = false;
  });
  ctx.d.on(root, 'pointermove', (e: PointerEvent) => {
    px = e.clientX;
    py = e.clientY;
  });

  let worldId = 0;
  let worldSince = 0;
  let worldReady = false;
  let mode: 'none' | 'dom' | 'world' = 'none';
  let boxW = 0;
  let boxH = 0;
  let measured = '';

  function place(x: number, y: number, above: boolean): void {
    const vw = root.clientWidth;
    const vh = root.clientHeight;
    let tx = x + 14;
    let ty = above ? y - boxH - 10 : y + 18;
    if (tx + boxW > vw - 4) tx = Math.max(4, x - boxW - 12);
    if (ty + boxH > vh - 4) ty = Math.max(4, y - boxH - 12);
    if (ty < 4) ty = y + 18;
    setStyle(el, 'transform', `translate(${Math.round(tx)}px,${Math.round(ty)}px)`);
  }

  function measure(key: string): void {
    if (key === measured) return;
    measured = key;
    boxW = el.offsetWidth;
    boxH = el.offsetHeight;
  }

  function describe(e: Readonly<Entity>): { title: string; sub: string; hp: number; hostile: boolean; target: OrderTarget } {
    const pc = app.sim.playerColony;
    const base = { id: e.id, pos: e.pos, cell: e.cell, colony: 0 };
    switch (e.kind) {
      case 'ant': {
        const a = e as Readonly<Ant>;
        const sp = getSpecies(a.species);
        const own = a.colony === pc;
        const infected = a.infection && a.infection.stage !== 'none' ? ` · fungus (${a.infection.stage})` : '';
        return {
          title: `${sp.name} ${(sp.castes[a.caste]?.name ?? a.caste).toLowerCase()}`,
          sub: `${own ? 'Your colony' : 'Enemy colony'} · ${humanize(antActivity(a))}${infected}`,
          hp: a.health / Math.max(1e-6, a.maxHealth),
          hostile: !own,
          target: { ...base, kind: 'ant', colony: a.colony },
        };
      }
      case 'creature': {
        const c = e as Readonly<Creature>;
        const def = getCreature(c.def);
        const hostile = def.role !== 'prey' && def.role !== 'herd';
        return {
          title: def?.name ?? humanize(c.def),
          sub: `${humanize(def.role)} · ${humanize(c.state)}`,
          hp: c.health / Math.max(1e-6, c.maxHealth),
          hostile,
          target: { ...base, kind: 'creature', colony: c.colony, creatureRole: def.role },
        };
      }
      case 'food': {
        const f = e as Readonly<FoodSource>;
        return { title: humanize(f.foodKind), sub: `Food source · ${fmtNum(f.amount)} / ${fmtNum(f.maxAmount)}`, hp: -1, hostile: false, target: { ...base, kind: 'food' } };
      }
      case 'item': {
        const it = e as Readonly<Item>;
        return {
          title: humanize(it.itemKind),
          sub: `${it.amount > 0 ? `Amount ${fmtNum(it.amount)}` : 'Item'}${it.infected ? ' · infected' : ''}${it.carriedBy ? ' · being carried' : ''}`,
          hp: -1,
          hostile: false,
          target: { ...base, kind: 'item', colony: it.colony, itemKind: it.itemKind },
        };
      }
      default: {
        const b = e as Readonly<Brood>;
        return { title: humanize(b.stage), sub: `Brood · future ${b.caste}${b.colony === pc ? '' : ' · enemy'}`, hp: -1, hostile: false, target: { ...base, kind: 'brood', colony: b.colony } };
      }
    }
  }

  return {
    el,
    update(now) {
      // DOM tip has priority
      if (domTarget && domTarget.isConnected && now - domSince >= DOM_DELAY_MS) {
        const text = domTarget.dataset.tip ?? '';
        if (text) {
          if (!domShown || mode !== 'dom') {
            domShown = true;
            mode = 'dom';
            setShown(el, true);
            setShown(bar, false);
            setShown(sub, false);
            setShown(verb, false);
            setClass(titleRow, 'mh-hostile', false);
          }
          setText(title, text);
          measure(`d:${text}`);
          const r = domTarget.getBoundingClientRect();
          const rr = root.getBoundingClientRect();
          const cx = r.left - rr.left + r.width / 2 - boxW / 2 - 14;
          // above the element when it sits in the lower half of the screen
          const lower = r.top - rr.top > rr.height / 2;
          place(Math.max(-10, cx), lower ? r.top - rr.top : r.bottom - rr.top - 12, lower);
          return;
        }
      }
      domShown = false;

      // world hover
      const view = app.view;
      const ext = ctx.ext();
      const id = view.mode !== 'possess' && (!ext || ext.pointer.over) && !view.dragBox ? view.hoverId : 0;
      if (id !== worldId) {
        worldId = id;
        worldSince = now;
        worldReady = false;
      }
      const ent = id ? app.sim.getEntity(id) : undefined;
      if (!ent || now - worldSince < WORLD_DELAY_MS) {
        if (mode !== 'none') {
          mode = 'none';
          setShown(el, false);
        }
        return;
      }
      const info = describe(ent);
      mode = 'world';
      worldReady = true;
      setShown(el, true);
      setText(title, info.title);
      setClass(titleRow, 'mh-hostile', info.hostile);
      setShown(sub, true);
      setText(sub, info.sub);
      setShown(bar, info.hp >= 0);
      if (info.hp >= 0) {
        const f = Math.min(1, Math.max(0, info.hp));
        setStyle(fill, 'transform', `scaleX(${f.toFixed(2)})`);
        setClass(bar, 'mh-low', f < 0.3);
      }
      let verbStr = '';
      const selCount = view.selection.length;
      if (selCount > 0 && !(selCount === 1 && view.selection[0] === id)) {
        const tool = ext?.activeTool ?? view.tool;
        if (!tool) verbStr = orderVerb(contextOrderKind(info.target, app.sim.playerColony));
      }
      setShown(verb, verbStr !== '');
      if (verbStr) setText(verbText, `Right-click: ${verbStr}`);
      measure(`w:${info.title}|${info.sub}|${info.hp >= 0}|${verbStr}`);
    },
    frame() {
      if (mode !== 'world' || !worldReady) return;
      const ext = ctx.ext();
      if (ext) place(ext.pointer.x, ext.pointer.y, false);
      else place(px, py, false);
    },
  };
}
