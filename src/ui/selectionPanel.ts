import { TICK_HZ, type Ant, type CasteId, type EntityId } from '../core';
import { getCaste, getSpecies } from '../sim/data/species';
import type { HudComponent, HudContext } from './context';
import { fmtNum, fmtTime, h, humanize, renderKeyed, setClass, setShown, setStyle, setText } from './dom';
import { casteIcon, icon } from './icons';

function bar(cls = ''): { el: HTMLElement; fill: HTMLElement } {
  const fill = h('i');
  return { el: h('span', `mh-bar ${cls}`, null, [fill]), fill };
}
export function setBar(b: { el: HTMLElement; fill: HTMLElement }, frac: number, lowAt = 0.3): void {
  const f = Math.min(1, Math.max(0, Number.isFinite(frac) ? frac : 0));
  setStyle(b.fill, 'transform', `scaleX(${f.toFixed(3)})`);
  setClass(b.el, 'mh-low', f < lowAt);
}

function carryText(a: Readonly<Ant>): string {
  const c = a.carrying;
  if (!c) return 'Nothing';
  if (c.kind === 'brood') return 'Brood';
  const amt = c.amount > 0 ? ` ×${fmtNum(c.amount)}` : '';
  return `${humanize(c.itemKind)}${amt}`;
}

/**
 * Selection panel. One ant: caste, bars, age, activity, task queue, carrying + actions.
 * Several: counts by caste (click a chip to narrow the selection), average health + group actions.
 */
export function createSelectionPanel(ctx: HudContext): HudComponent {
  const { app } = ctx;

  const btn = (label: string, ic: string, tip: string, fn: () => void, cls = ''): HTMLButtonElement => {
    const b = h('button', `mh-btn ${cls}`, { type: 'button', tip }, label ? [icon(ic), h('span', undefined, null, label)] : [icon(ic)]);
    ctx.d.on(b, 'click', () => {
      fn();
      b.blur();
    });
    return b;
  };

  let primary: EntityId = 0;
  const possess = (): void => {
    const api = ctx.api();
    if (!primary) return;
    if (api) api.possess(primary);
    else app.command({ type: 'possessStart', id: primary });
  };
  const stop = (): void => {
    const api = ctx.api();
    if (api) api.orderSelection('stop');
    else app.command({ type: 'order', ids: app.view.selection.slice(), order: 'stop' });
  };
  const exile = (): void => {
    const api = ctx.api();
    if (api) api.orderSelection('exile');
    else app.command({ type: 'order', ids: app.view.selection.slice(), order: 'exile' });
  };
  const dismiss = (): void => ctx.api()?.select([]);
  const follow = (): void => {
    const api = ctx.api();
    if (!api || !primary) return;
    api.setFollow(ctx.ext()?.followId === primary ? 0 : primary);
  };
  const withHint = (text: string, action: Parameters<HudContext['hint']>[0]): string => {
    const k = ctx.hint(action);
    return k ? `${text} (${k})` : text;
  };

  // ---- single ----
  const sIcon = h('span', 'mh-row');
  const sName = h('span');
  const sBadge = h('span', 'mh-badge');
  const sHealth = bar();
  const sHealthT = h('span');
  const sEnergy = bar('mh-energy');
  const sEnergyT = h('span');
  const sAge = h('span');
  const sDoing = h('span');
  const sCarry = h('span');
  const sQueue = h('div', 'mh-queue');
  const bFollow = btn('Follow', 'follow', withHint('Camera follows this ant', 'cam.follow'), follow);
  const single = h('div', undefined, null, [
    h('div', 'mh-title', null, [sIcon, sName, sBadge]),
    h('div', 'mh-kv', null, [
      h('span', undefined, null, 'Health'),
      h('span', 'mh-val', null, [sHealth.el, sHealthT]),
      h('span', undefined, null, 'Energy'),
      h('span', 'mh-val', null, [sEnergy.el, sEnergyT]),
      h('span', undefined, null, 'Age'),
      h('span', 'mh-val', null, [sAge]),
      h('span', undefined, null, 'Doing'),
      h('span', 'mh-val', null, [sDoing]),
      h('span', undefined, null, 'Carrying'),
      h('span', 'mh-val', null, [sCarry]),
      h('span', undefined, null, 'Queue'),
      sQueue,
    ]),
    h('div', 'mh-actions', null, [
      btn('Possess', 'possess', withHint('Take direct control', 'possess.toggle'), possess),
      bFollow,
      btn('Stop', 'stop', withHint('Clear player orders', 'order.stop'), stop),
      btn('', 'close', 'Dismiss selection (Esc)', dismiss, 'mh-icononly'),
    ]),
  ]);

  // ---- group ----
  const gCount = h('span');
  const gChips = h('div', 'mh-chips');
  const gHealth = bar();
  const gHealthT = h('span');
  const gDoing = h('span');
  const group = h('div', undefined, null, [
    h('div', 'mh-title', null, [icon('ant'), gCount]),
    gChips,
    h('div', 'mh-kv', null, [
      h('span', undefined, null, 'Health'),
      h('span', 'mh-val', null, [gHealth.el, gHealthT]),
      h('span', undefined, null, 'Doing'),
      h('span', 'mh-val', null, [gDoing]),
    ]),
    h('div', 'mh-actions', null, [
      btn('Possess', 'possess', withHint('Possess the first ant', 'possess.toggle'), possess),
      btn('Stop', 'stop', withHint('Clear player orders', 'order.stop'), stop),
      btn('Exile', 'exile', 'Send the selected ants away from the nest', exile, 'mh-danger'),
      btn('', 'close', 'Dismiss selection (Esc)', dismiss, 'mh-icononly'),
    ]),
  ]);

  const panel = h('div', 'mh-panel mh-sel mh-hidden', { testid: 'selection-panel' }, [single, group]);
  const el = h('div', 'mh-selwrap', null, [panel]);

  ctx.d.on(gChips, 'click', (e: MouseEvent) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-caste]');
    if (!chip) return;
    const caste = chip.dataset.caste;
    const ids = app.view.selection.filter((id) => app.sim.getAnt(id)?.caste === caste);
    if (ids.length) ctx.api()?.select(ids);
  });

  let lastCasteIcon = '';
  const counts = new Map<CasteId, number>();
  const doing = new Map<string, number>();

  return {
    el,
    update() {
      const sim = app.sim;
      const view = app.view;
      const ants: Readonly<Ant>[] = [];
      if (view.mode !== 'possess') {
        for (const id of view.selection) {
          const a = sim.getAnt(id);
          if (a && a.alive) ants.push(a);
        }
      }
      setShown(panel, ants.length > 0);
      if (!ants.length) {
        primary = 0;
        return;
      }
      const extPrimary = ctx.ext()?.primaryId ?? 0;
      const first = (extPrimary && ants.find((a) => a.id === extPrimary)) || ants[0];
      primary = first.id;
      const isSingle = ants.length === 1;
      setShown(single, isSingle);
      setShown(group, !isSingle);

      if (isSingle) {
        const a = first;
        const species = getSpecies(a.species);
        const caste = getCaste(a.species, a.caste);
        const ci = casteIcon(a.caste);
        if (ci !== lastCasteIcon) {
          lastCasteIcon = ci;
          sIcon.replaceChildren(icon(ci));
        }
        setText(sName, `${species.name} ${(species.castes[a.caste]?.name ?? caste.name ?? a.caste).toLowerCase()}`);
        const infected = a.infection && a.infection.stage !== 'none';
        const grp = a.group || 0;
        setShown(sBadge, infected || grp > 0);
        setClass(sBadge, 'mh-bad', !!infected);
        setText(sBadge, infected ? `Fungus: ${a.infection.stage}` : grp ? `Group ${grp}` : '');
        setBar(sHealth, a.health / Math.max(1e-6, a.maxHealth));
        setText(sHealthT, `${fmtNum(Math.max(0, Math.ceil(a.health)))}/${fmtNum(a.maxHealth)}`);
        setBar(sEnergy, a.energy, 0.25);
        setText(sEnergyT, `${Math.round(Math.min(1, Math.max(0, a.energy)) * 100)}%`);
        const ageS = a.age / TICK_HZ;
        setText(sAge, Number.isFinite(a.lifespan) && a.lifespan > 0 ? `${fmtTime(ageS)} · ${Math.min(999, Math.round((a.age / a.lifespan) * 100))}% of lifespan` : `${fmtTime(ageS)} · ageless`);
        setText(sDoing, humanize(a.behavior || 'idle'));
        setText(sCarry, carryText(a));
        let key = '';
        for (const t of a.tasks) key += `${t.kind}:${t.source},`;
        renderKeyed(sQueue, key, () => {
          if (!a.tasks.length) return [h('span', 'mh-dim', null, 'No tasks')];
          const out: Node[] = [];
          const shown = a.tasks.slice(0, 6);
          shown.forEach((t, i) => {
            if (i) out.push(h('span', 'mh-arrow', null, '›'));
            out.push(h('span', `mh-task${t.source === 'player' ? ' mh-player' : ''}${i === 0 ? ' mh-cur' : ''}`, { tip: t.source === 'player' ? 'Your order' : t.source === 'colony' ? 'Colony job' : 'Own initiative' }, humanize(t.kind)));
          });
          if (a.tasks.length > shown.length) out.push(h('span', 'mh-dim', null, `+${a.tasks.length - shown.length}`));
          return out;
        });
        setClass(bFollow, 'mh-on', ctx.ext()?.followId === a.id);
      } else {
        setText(gCount, `${ants.length} ants selected`);
        counts.clear();
        doing.clear();
        let hp = 0;
        let hpMax = 0;
        for (const a of ants) {
          counts.set(a.caste, (counts.get(a.caste) ?? 0) + 1);
          hp += Math.max(0, a.health);
          hpMax += a.maxHealth;
          const d = a.tasks.length && a.tasks[0].source === 'player' ? `order: ${a.tasks[0].kind}` : a.behavior || 'idle';
          doing.set(d, (doing.get(d) ?? 0) + 1);
        }
        let key = '';
        for (const [c, n] of counts) key += `${c}:${n},`;
        renderKeyed(gChips, key, () => {
          const species = getSpecies(first.species);
          return [...counts].map(([c, n]) => h('button', 'mh-chip', { type: 'button', 'data-caste': c, tip: `Select only ${(species.castes[c]?.name ?? c).toLowerCase()}s` }, [icon(casteIcon(c)), `${n} ${(species.castes[c]?.name ?? humanize(c)).toLowerCase()}`]));
        });
        setBar(gHealth, hp / Math.max(1e-6, hpMax));
        setText(gHealthT, `${Math.round((hp / Math.max(1e-6, hpMax)) * 100)}%`);
        let top = '';
        let topN = 0;
        for (const [d, n] of doing) {
          if (n > topN) {
            topN = n;
            top = d;
          }
        }
        setText(gDoing, doing.size > 1 ? `${humanize(top)} (${topN}) +${doing.size - 1} more` : humanize(top));
      }
    },
  };
}
