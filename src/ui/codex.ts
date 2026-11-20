/**
 * Field guide (codex) modal + the pheromone-vision colour legend.
 *  - `open(entryId?)` shows the guide (HUD modal, Esc / backdrop closes); toolbar button "Field guide".
 *  - The legend card (`data-testid="phero-legend"`, topRight slot) appears by itself while
 *    pheromone vision is on, using the channel colours the renderer draws with.
 */
import { PHERO_NAMES } from '../core';
import { PHERO_INFO, buildCodex, findCodexEntry, pheroCss, type CodexCategory, type CodexEntry } from './codexData';
import { h, setClass, setShown } from './dom';
import type { Feature, FeatureContext } from './features';
import { icon } from './icons';

export const CODEX_CSS = `
.myrme-hud .mx-codex { width: 62em; max-width: 94%; height: 38em; max-height: 90%; padding: 0; display: flex; flex-direction: column; overflow: hidden; }
.myrme-hud .mx-codex .mh-panel-head { flex: none; font-size: .95em; padding: .6em 1em; }
.myrme-hud .mx-codex .mh-panel-head .mh-icon { color: var(--mh-accent); }
.myrme-hud .mx-main { flex: 1 1 auto; min-height: 0; display: flex; }
.myrme-hud .mx-nav { flex: 0 0 15.5em; overflow-y: auto; padding: .5em .5em .8em; border-right: 1px solid var(--mh-border); scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.25) transparent; }
.myrme-hud .mx-cat { margin: .5em .4em .2em; font-size: .76em; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--mh-accent); display: flex; align-items: center; gap: .4em; }
.myrme-hud .mx-cat .mh-icon { width: 1.1em; height: 1.1em; }
.myrme-hud .mx-link { pointer-events: auto; appearance: none; font: inherit; color: var(--mh-text); text-align: left; cursor: pointer; display: flex; align-items: center; gap: .45em; width: 100%; padding: .22em .55em; border-radius: .35em; background: transparent; border: 1px solid transparent; }
.myrme-hud .mx-link:hover { background: var(--mh-bg-hi); }
.myrme-hud .mx-link:focus-visible { border-color: var(--mh-accent); outline: none; }
.myrme-hud .mx-link.mh-on { background: rgba(159, 216, 107, .18); color: var(--mh-accent); }
.myrme-hud .mx-sw { flex: none; width: .75em; height: .75em; border-radius: 50%; box-shadow: 0 0 .5em currentColor; background: currentColor; }
.myrme-hud .mx-detail { flex: 1 1 auto; min-width: 0; overflow-y: auto; padding: 1em 1.4em 1.2em; user-select: text; -webkit-user-select: text; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.25) transparent; }
.myrme-hud .mx-detail h3 { margin: 0; font-size: 1.5em; font-weight: 600; display: flex; align-items: center; gap: .45em; }
.myrme-hud .mx-detail h3 .mh-icon { width: 1.1em; height: 1.1em; color: var(--mh-accent); }
.myrme-hud .mx-detail h3 .mx-sw { width: .7em; height: .7em; }
.myrme-hud .mx-crumb { font-size: .76em; letter-spacing: .08em; text-transform: uppercase; color: var(--mh-dim); margin-bottom: .2em; }
.myrme-hud .mx-lead { margin: .3em 0 .8em; font-size: 1.08em; color: #f4e2a8; }
.myrme-hud .mx-detail p { margin: 0 0 .6em; line-height: 1.5; max-width: 44em; }
.myrme-hud .mx-facts { display: grid; grid-template-columns: max-content 1fr; gap: .2em 1em; margin: .9em 0 0; padding: .6em .8em; border-radius: .5em; background: var(--mh-bg-hi); max-width: 44em; }
.myrme-hud .mx-facts > span:nth-child(odd) { color: var(--mh-dim); }
.myrme-hud .mx-table { border-collapse: collapse; margin-top: .9em; font-size: .95em; }
.myrme-hud .mx-table th { text-align: left; font-weight: 600; color: var(--mh-dim); font-size: .85em; text-transform: uppercase; letter-spacing: .05em; padding: .2em 1.2em .3em 0; border-bottom: 1px solid var(--mh-border); }
.myrme-hud .mx-table td { padding: .25em 1.2em .25em 0; border-bottom: 1px solid rgba(255,255,255,.05); }
.myrme-hud .mx-legend { padding: .45em .7em .5em; width: 13.5em; }
.myrme-hud .mx-legend .mx-ltitle { font-size: .78em; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; color: var(--mh-violet); margin-bottom: .3em; display: flex; align-items: center; gap: .4em; }
.myrme-hud .mx-legend .mx-ltitle .mh-icon { width: 1.1em; height: 1.1em; }
.myrme-hud .mx-legend .mx-lgrid { display: grid; grid-template-columns: 1fr 1fr; gap: .12em .6em; }
.myrme-hud .mx-legend .mx-lrow { pointer-events: auto; appearance: none; font: inherit; color: var(--mh-text); background: none; border: 0; padding: 0; cursor: pointer; display: flex; align-items: center; gap: .45em; font-size: .92em; text-align: left; }
.myrme-hud .mx-legend .mx-lrow:hover span:last-child { text-decoration: underline; }
@media (max-width: 760px) { .myrme-hud .mx-nav { flex-basis: 11em; } }
`;

export interface CodexFeature extends Feature {
  open(entry?: string): void;
  close(): void;
  isOpen(): boolean;
}

export function createCodex(ctx: FeatureContext): CodexFeature {
  const { app, hud } = ctx;
  const style = h('style', undefined, { 'data-myrme': 'b5-codex' }, CODEX_CSS);
  document.head.appendChild(style);

  let modal: { close(): void } | null = null;
  let current = 'faction.' + (ctx.colony()?.species ?? app.sim.options.faction);
  let show: ((id: string) => void) | null = null;

  function swatch(color: string): HTMLElement {
    const s = h('span', 'mx-sw');
    s.style.color = color;
    return s;
  }

  function detail(cat: CodexCategory, e: CodexEntry): Node[] {
    const out: Node[] = [
      h('div', 'mx-crumb', null, cat.title),
      h('h3', undefined, { testid: 'codex-title' }, [e.swatch ? swatch(e.swatch) : icon(e.icon), h('span', undefined, null, e.title)]),
      h('div', 'mx-lead', null, e.lead),
      ...e.body.map((p) => h('p', undefined, null, p)),
    ];
    if (e.facts) out.push(h('div', 'mx-facts', null, e.facts.flatMap(([k, v]) => [h('span', undefined, null, k), h('span', undefined, null, v)])));
    if (e.table) {
      out.push(
        h('table', 'mx-table', null, [
          h('thead', undefined, null, [h('tr', undefined, null, e.table.head.map((c) => h('th', undefined, null, c)))]),
          h('tbody', undefined, null, e.table.rows.map((r) => h('tr', undefined, null, r.map((c) => h('td', undefined, null, c))))),
        ]),
      );
    }
    return out;
  }

  function open(entryId?: string): void {
    if (entryId) {
      const f = findCodexEntry(entryId);
      if (f) current = f.entry.id;
    }
    if (modal) {
      show?.(current);
      return;
    }
    const cats = buildCodex();
    const links = new Map<string, HTMLElement>();
    const nav = h('div', 'mx-nav', { testid: 'codex-nav' });
    const pane = h('div', 'mx-detail', { testid: 'codex-detail' });
    for (const cat of cats) {
      nav.append(h('div', 'mx-cat', null, [icon(cat.icon), h('span', undefined, null, cat.title)]));
      for (const e of cat.entries) {
        const b = h('button', 'mx-link', { type: 'button', 'data-entry': e.id, testid: `codex-link-${e.id}` }, [e.swatch ? swatch(e.swatch) : null, h('span', undefined, null, e.title)]);
        links.set(e.id, b);
        nav.append(b);
      }
    }
    show = (id: string): void => {
      const f = findCodexEntry(id) ?? findCodexEntry(cats[0].entries[0].id)!;
      current = f.entry.id;
      for (const [k, b] of links) setClass(b, 'mh-on', k === current);
      pane.replaceChildren(...detail(f.category, f.entry));
      pane.scrollTop = 0;
      const b = links.get(current);
      if (b && (b.offsetTop < nav.scrollTop || b.offsetTop + b.offsetHeight > nav.scrollTop + nav.clientHeight)) nav.scrollTop = Math.max(0, b.offsetTop - nav.clientHeight / 2);
    };
    const onNav = (e: MouseEvent): void => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-entry]');
      if (!b) return;
      show?.(b.dataset.entry!);
      ctx.audio?.ui('click');
      b.blur();
    };
    nav.addEventListener('click', onNav);
    const x = h('button', 'mh-btn mh-x', { type: 'button', 'aria-label': 'Close', testid: 'codex-close' }, [icon('close')]);
    const onX = (): void => modal?.close();
    x.addEventListener('click', onX);
    const el = h('div', 'mh-panel mh-dialog mx-codex', { testid: 'codex', role: 'dialog', 'aria-label': 'Field guide' }, [
      h('div', 'mh-panel-head', null, [icon('book'), h('span', undefined, null, 'Field guide'), x]),
      h('div', 'mx-main', null, [nav, pane]),
    ]);
    modal = hud.openModal(el, {
      onClose: () => {
        modal = null;
        show = null;
        nav.removeEventListener('click', onNav);
        x.removeEventListener('click', onX);
        ctx.audio?.ui('close');
      },
    });
    show(current);
    ctx.audio?.ui('open');
  }

  const toolBtn = hud.addToolbarButton({ id: 'codex', icon: 'book', label: 'Field guide', tip: 'Field guide — castes, creatures, scents, weather', onClick: () => (modal ? modal.close() : open()), active: () => !!modal });

  // ---- pheromone-vision legend ----
  const grid = h('div', 'mx-lgrid');
  PHERO_INFO.forEach((p, i) => {
    const sw = h('span', 'mx-sw');
    sw.style.color = pheroCss(i);
    grid.append(h('button', 'mx-lrow', { type: 'button', 'data-entry': `phero.${PHERO_NAMES[i]}`, tip: p.short, testid: `phero-legend-${PHERO_NAMES[i]}` }, [sw, h('span', undefined, null, p.label)]));
  });
  ctx.d.on(grid, 'click', (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-entry]');
    if (b) open(b.dataset.entry);
  });
  const legend = h('div', 'mh-panel mx-legend mh-hidden', { testid: 'phero-legend' }, [h('div', 'mx-ltitle', null, [icon('eye'), h('span', undefined, null, 'Pheromone vision')]), grid]);
  hud.slot('topRight').append(legend);

  return {
    open,
    close() {
      modal?.close();
    },
    isOpen: () => !!modal,
    update() {
      setShown(legend, !!app.view.pheroVision);
    },
    dispose() {
      modal?.close();
      toolBtn.remove();
      legend.remove();
      style.remove();
    },
  };
}
