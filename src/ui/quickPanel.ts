import type { CasteId, JobKind, SpeciesDef } from '../core';
import { getSpecies } from '../sim/data/species';
import type { HudComponent, HudContext } from './context';
import { h, setClass, setShown, setStyle, setText } from './dom';
import { icon } from './icons';

interface PriorityDef {
  id: 'forage' | 'dig' | 'nurse' | 'defend';
  label: string;
  tip: string;
  jobs(species: SpeciesDef): JobKind[];
}

const PRIORITIES: readonly PriorityDef[] = [
  {
    id: 'forage',
    label: 'Forage',
    tip: 'Scouting, gathering and hauling food',
    jobs: (s) => ['forage', 'haulFood', ...(s.caps.farmsFungus ? (['harvestLeaves'] as JobKind[]) : []), ...(s.caps.herdsAphids ? (['herdAphids'] as JobKind[]) : [])],
  },
  { id: 'dig', label: 'Dig', tip: 'Excavating designations', jobs: (s) => ['dig', ...(s.caps.canFill ? (['build'] as JobKind[]) : [])] },
  { id: 'nurse', label: 'Nurse', tip: 'Feeding larvae and the queen, carrying brood', jobs: (s) => ['feedLarva', 'feedQueen', 'carryBrood', ...(s.caps.farmsFungus ? (['tendGarden'] as JobKind[]) : [])] },
  { id: 'defend', label: 'Defend', tip: 'Guarding and patrolling', jobs: () => ['guard', 'patrol'] },
];

const MILITARY: readonly CasteId[] = ['soldier', 'nasute', 'major'];
const HOLD_MS = 500;

interface Slider {
  row: HTMLElement;
  input: HTMLInputElement;
  out: HTMLOutputElement;
  /** Value waiting to be sent (null = none). */
  pending: number | null;
  dragging: boolean;
  /** Until when the slider ignores the sim value (lets the command land). */
  holdUntil: number;
  fmt(v: number): string;
  send(v: number): void;
  read(): number | null;
}

/**
 * Colony quick-panel: four priority sliders (0..2, 1 = neutral) and the soldier share of new
 * brood. Slider input is coalesced — commands go out at the HUD rate (≤ 10 bursts/s) and once
 * more on release; while idle the sliders mirror the colony's real values.
 */
export function createQuickPanel(ctx: HudContext): HudComponent & { toggle(): void; setCollapsed(collapsed: boolean): void; isCollapsed(): boolean } {
  const { app } = ctx;
  const sliders: Slider[] = [];
  const species = (): SpeciesDef => getSpecies(ctx.colony()?.species ?? app.sim.options.faction);

  function mkSlider(cls: string, label: string, tip: string, min: number, max: number, step: number, fmt: (v: number) => string, send: (v: number) => void, read: () => number | null): Slider {
    const input = h('input', undefined, { type: 'range', min, max, step, value: (min + max) / 2, 'aria-label': label });
    const out = h('output');
    const row = h('div', `mh-slider ${cls}`, { tip }, [h('label', undefined, null, label), input, out]);
    const s: Slider = { row, input, out, pending: null, dragging: false, holdUntil: 0, fmt, send, read };
    const paint = (): void => {
      const v = Number(input.value);
      setStyle(input, '--fill', `${(((v - min) / (max - min)) * 100).toFixed(1)}%`);
      setText(out, fmt(v));
    };
    ctx.d.on(input, 'pointerdown', () => {
      s.dragging = true;
    });
    ctx.d.on(input, 'input', () => {
      s.pending = Number(input.value);
      paint();
    });
    const release = (): void => {
      s.dragging = false;
      flush(s, performance.now());
      input.blur(); // give the keyboard back to the game
    };
    ctx.d.on(input, 'change', release);
    ctx.d.on(input, 'pointerup', release);
    ctx.d.on(input, 'pointercancel', release);
    // keep arrow keys etc. inside the slider from reaching the game's window-level handlers
    ctx.d.on(input, 'keydown', (e: KeyboardEvent) => e.stopPropagation());
    (s as Slider & { paint: () => void }).paint = paint;
    paint();
    sliders.push(s);
    return s;
  }

  function flush(s: Slider, now: number): void {
    if (s.pending === null) return;
    const v = s.pending;
    s.pending = null;
    s.holdUntil = now + HOLD_MS;
    s.send(v);
  }

  const body = h('div', 'mh-panel-body');
  for (const p of PRIORITIES) {
    const s = mkSlider(
      `mh-s-${p.id}`,
      p.label,
      p.tip,
      0,
      2,
      0.05,
      (v) => `${Math.round(v * 100)}%`,
      (v) => {
        for (const job of p.jobs(species())) app.command({ type: 'setPriority', job, value: v });
      },
      () => {
        const c = ctx.colony();
        if (!c) return null;
        const v = c.priorities?.[p.jobs(species())[0]];
        return typeof v === 'number' ? v : null;
      },
    );
    s.input.dataset.testid = `priority-${p.id}`;
    body.append(s.row);
  }

  const military = (): CasteId | null => {
    const sp = species();
    return MILITARY.find((c) => sp.castes[c]) ?? null;
  };
  const casteHead = h('div', 'mh-subhead', null, 'New brood');
  const casteSlider = mkSlider(
    'mh-s-defend',
    'Soldiers',
    'Share of new brood raised as soldiers',
    0,
    0.6,
    0.02,
    (v) => `${Math.round(v * 100)}%`,
    (v) => {
      const m = military();
      if (!m) return;
      app.command({ type: 'setCasteRatio', caste: m, value: v });
      app.command({ type: 'setCasteRatio', caste: 'worker', value: 1 - v });
    },
    () => {
      const c = ctx.colony();
      const m = military();
      if (!c || !m) return null;
      const ratio = c.casteRatio ?? {};
      const mv = ratio[m] ?? 0;
      const wv = ratio.worker ?? 0;
      const sum = mv + wv;
      return sum > 0 ? mv / sum : 0;
    },
  );
  casteSlider.input.dataset.testid = 'caste-ratio';
  body.append(casteHead, casteSlider.row);

  const hintKey = ctx.hint('ui.colony');
  const head = h('div', 'mh-panel-head mh-click', { tip: `Colony priorities${hintKey ? ` (${hintKey})` : ''}` }, [icon('home'), h('span', undefined, null, 'Colony'), icon('chevron', 'mh-chev')]);
  const el = h('div', 'mh-panel mh-quick', { testid: 'quick-panel' }, [head, body]);
  let collapsed = app.viewport().height < 620; // start folded on small viewports
  setClass(el, 'mh-collapsed', collapsed);
  const toggle = (): void => {
    collapsed = !collapsed;
    setClass(el, 'mh-collapsed', collapsed);
  };
  ctx.d.on(head, 'click', toggle);

  return {
    el,
    toggle,
    setCollapsed(c) {
      collapsed = c;
      setClass(el, 'mh-collapsed', collapsed);
    },
    isCollapsed: () => collapsed,
    update(now) {
      const hasMil = military() !== null;
      setShown(casteHead, hasMil);
      setShown(casteSlider.row, hasMil);
      for (const s of sliders) {
        if (s.pending !== null) {
          flush(s, now);
          continue;
        }
        if (s.dragging || now < s.holdUntil || collapsed) continue;
        const v = s.read();
        if (v === null) continue;
        const cur = Number(s.input.value);
        if (Math.abs(cur - v) > 1e-3) {
          s.input.value = String(v);
          (s as Slider & { paint: () => void }).paint();
        }
      }
    },
  };
}
