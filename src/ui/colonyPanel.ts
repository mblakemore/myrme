/**
 * Full colony management panel (`L` / toolbar button). A NON-modal card docked on the left,
 * between the goal tracker and the minimap, so the game keeps running underneath:
 *
 *   Overview  population by caste + history, brood pipeline, stores + net income, new-brood caste
 *             ratio, threat / weather status, faction extras (fungus garden, termite works, aphid
 *             herds, rafts — shown only when the species' capability flags apply)
 *   Jobs      job board per job kind (assigned vs open slots) with a fine priority slider each,
 *             and what the ants are doing right now
 *   Nest      chamber list (click → camera jump), lifetime statistics
 *   Log       deaths by cause + recent deaths (click → jump)
 *   Keeper    farm maps in sandbox: play the keeper (food, water, lamp, tap the glass)
 *
 * The A5 quick panel (bottom right) keeps the four coarse priority sliders; opening this panel
 * unfolds it, closing folds it again. Everything is read from the `SimView`; changes go out as
 * `setPriority` / `setCasteRatio` / keeper commands.
 */
import {
  JOB_KINDS,
  antActivityLabel,
  b3StateOf,
  envOf,
  forecastLabel,
  jobSummary,
  keeperCommand,
  weatherLabel,
  type CasteId,
  type ChamberKind,
  type Colony,
  type DeathCause,
  type JobKind,
  type KeeperActionEx,
  type SpeciesDef,
  type Vec3,
} from '../core';
import { getSpecies } from '../sim/data/species';
import { fmtNum, fmtTime, h, humanize, renderKeyed, setClass, setShown, setStyle, setText } from './dom';
import type { Feature, FeatureContext } from './features';
import { casteIcon, icon } from './icons';
import { createSparkline, type Sparkline } from './sparkline';
import type { SeriesKey } from './timeSeries';

export const COLONY_CSS = `
.myrme-hud .mc-colony { width: 24em; max-width: 100%; display: flex; flex-direction: column; min-height: 9em; overflow: hidden; }
.myrme-hud .mc-colony .mh-panel-head { flex: none; }
.myrme-hud .mc-colony .mh-panel-head .mh-icon { color: var(--mh-accent); }
.myrme-hud .mc-colony .mc-species { text-transform: none; letter-spacing: 0; font-weight: 400; margin-left: .2em; }
.myrme-hud .mc-colony .mh-x { width: 1.7em; height: 1.7em; margin: -.2em -.35em -.2em auto; }
.myrme-hud .mc-colony .mh-x .mh-icon { color: var(--mh-text); width: 1em; height: 1em; }
.myrme-hud .mc-tabs { flex: none; display: flex; gap: .2em; padding: .35em .5em 0; border-bottom: 1px solid var(--mh-border); }
.myrme-hud .mc-tab { border-radius: .4em .4em 0 0; border-bottom-color: transparent; padding: .25em .6em; font-size: .92em; background: transparent; color: var(--mh-dim); margin-bottom: -1px; }
.myrme-hud .mc-tab .mh-icon { width: 1em; height: 1em; }
.myrme-hud .mc-tabs.mc-many .mc-tab { padding: .25em .5em; }
.myrme-hud .mc-tabs.mc-many .mc-tab .mh-icon { display: none; }
.myrme-hud .mc-tab.mh-on { background: var(--mh-bg-hi); color: var(--mh-text); border-color: var(--mh-border); border-bottom-color: transparent; box-shadow: inset 0 2px 0 var(--mh-accent); }
.myrme-hud .mc-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: .5em .7em .65em; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.25) transparent; }
.myrme-hud .mc-body::-webkit-scrollbar { width: .45em; }
.myrme-hud .mc-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,.22); border-radius: .3em; }
.myrme-hud .mc-page.mh-hidden { display: none; }
.myrme-hud .mc-sec { margin: 0 0 .65em; }
.myrme-hud .mc-sec:last-child { margin-bottom: 0; }
.myrme-hud .mc-sec > h5 { margin: 0 0 .3em; font-size: .78em; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; color: var(--mh-dim); display: flex; align-items: center; gap: .5em; }
.myrme-hud .mc-sec > h5::after { content: ''; flex: 1 1 auto; height: 1px; background: var(--mh-border); }
.myrme-hud .mc-spark { display: block; width: 100%; height: 1.9em; }
.myrme-hud .mc-popline { display: flex; align-items: center; gap: .7em; }
.myrme-hud .mc-big { font-size: 1.7em; font-weight: 600; line-height: 1; color: var(--mh-accent); }
.myrme-hud .mc-popline .mc-sub { font-size: .85em; color: var(--mh-dim); line-height: 1.25; flex: none; }
.myrme-hud .mc-popline .mc-spark { flex: 1 1 auto; width: auto; min-width: 0; }
.myrme-hud .mc-castes { display: flex; flex-wrap: wrap; gap: .3em; margin-top: .4em; }
.myrme-hud .mc-castes .mh-chip b { font-weight: 600; }
.myrme-hud .mc-pipe { display: flex; align-items: stretch; gap: .3em; }
.myrme-hud .mc-stage { flex: 1 1 0; display: flex; align-items: center; gap: .4em; padding: .3em .5em; border-radius: .4em; background: var(--mh-bg-hi); color: #e6dfc8; }
.myrme-hud .mc-stage b { font-size: 1.15em; font-weight: 600; }
.myrme-hud .mc-stage span { font-size: .82em; color: var(--mh-dim); }
.myrme-hud .mc-pipe .mc-arrow { align-self: center; color: var(--mh-dim); width: .9em; height: .9em; transform: rotate(-90deg); flex: none; }
.myrme-hud .mc-store { display: grid; grid-template-columns: 1.3em 3.6em 3.2em 4.6em 1fr; align-items: center; column-gap: .45em; margin: .12em 0; color: var(--mh-amber); }
.myrme-hud .mc-store .mc-lbl { color: var(--mh-dim); font-size: .92em; }
.myrme-hud .mc-store b { font-weight: 600; text-align: right; }
.myrme-hud .mc-store .mc-rate { font-size: .85em; color: var(--mh-dim); white-space: nowrap; }
.myrme-hud .mc-store .mc-rate.mc-up { color: var(--mh-accent); }
.myrme-hud .mc-store .mc-rate.mc-down { color: var(--mh-red); }
.myrme-hud .mc-store .mc-spark { height: 1.3em; }
.myrme-hud .mc-colony .mh-slider { grid-template-columns: 5.2em 1fr 2.6em; }
.myrme-hud .mc-kv { display: grid; grid-template-columns: 5.6em 1fr; column-gap: .5em; row-gap: .15em; align-items: baseline; }
.myrme-hud .mc-kv > span:nth-child(odd) { color: var(--mh-dim); font-size: .9em; }
.myrme-hud .mc-kv .mc-warn { color: var(--mh-amber); }
.myrme-hud .mc-kv .mc-bad { color: var(--mh-red); }
.myrme-hud .mc-kv .mc-good { color: var(--mh-accent); }
.myrme-hud .mc-kv .mc-barval { display: flex; align-items: center; gap: .5em; }
.myrme-hud .mc-job { display: grid; grid-template-columns: 6.6em 3.2em 1fr 2.5em; align-items: center; column-gap: .45em; margin: .08em 0; }
.myrme-hud .mc-job .mc-jname { font-size: .92em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.myrme-hud .mc-job .mc-jcount { font-size: .88em; color: var(--mh-dim); text-align: right; white-space: nowrap; }
.myrme-hud .mc-job .mc-jcount b { color: var(--mh-text); font-weight: 600; }
.myrme-hud .mc-job output { text-align: right; font-size: .85em; color: var(--mh-dim); }
.myrme-hud .mc-job.mc-idle .mc-jname { color: var(--mh-dim); }
.myrme-hud .mc-jobhead { font-size: .75em; color: var(--mh-dim); text-transform: uppercase; letter-spacing: .05em; margin-bottom: .15em; }
.myrme-hud .mc-acts { display: flex; flex-direction: column; gap: .14em; }
.myrme-hud .mc-act { display: grid; grid-template-columns: 9.5em 1fr 2.2em; align-items: center; column-gap: .5em; font-size: .92em; }
.myrme-hud .mc-act > span:first-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.myrme-hud .mc-act b { text-align: right; font-weight: 600; }
.myrme-hud .mc-act .mh-bar { height: .4em; }
.myrme-hud .mc-list { display: flex; flex-direction: column; gap: .2em; }
.myrme-hud .mc-item { pointer-events: auto; appearance: none; font: inherit; color: var(--mh-text); text-align: left; cursor: pointer; display: flex; align-items: center; gap: .5em; padding: .28em .5em; border-radius: .4em; background: var(--mh-bg-hi); border: 1px solid transparent; width: 100%; }
.myrme-hud .mc-item:hover, .myrme-hud .mc-item:focus-visible { border-color: var(--mh-border-hi); background: rgba(255,255,255,.12); outline: none; }
.myrme-hud .mc-item .mh-icon { color: var(--mh-accent); width: 1.1em; height: 1.1em; }
.myrme-hud .mc-item .mc-meta { margin-left: auto; color: var(--mh-dim); font-size: .85em; white-space: nowrap; }
.myrme-hud .mc-item .mh-bar { flex: 0 0 4em; }
.myrme-hud .mc-item.mc-death .mh-icon { color: var(--mh-red); }
.myrme-hud .mc-empty { color: var(--mh-dim); font-size: .92em; padding: .2em 0; }
.myrme-hud .mc-cause { display: grid; grid-template-columns: 6.2em 1fr 2.2em; align-items: center; column-gap: .5em; font-size: .92em; margin: .1em 0; }
.myrme-hud .mc-cause .mh-bar > i { background: var(--mh-red); }
.myrme-hud .mc-cause b { text-align: right; font-weight: 600; }
.myrme-hud .mc-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: .3em; }
.myrme-hud .mc-stat { padding: .3em .5em; border-radius: .4em; background: var(--mh-bg-hi); }
.myrme-hud .mc-stat b { display: block; font-size: 1.1em; font-weight: 600; }
.myrme-hud .mc-stat span { font-size: .78em; color: var(--mh-dim); }
.myrme-hud .mc-keeper { display: grid; grid-template-columns: 1fr 1fr; gap: .35em; }
.myrme-hud .mc-keeper .mh-btn { justify-content: flex-start; padding: .45em .6em; }
.myrme-hud .mc-keeper .mh-btn .mh-icon { color: var(--mh-blue); }
.myrme-hud .mc-hint { color: var(--mh-dim); font-size: .88em; margin-top: .45em; line-height: 1.35; }
`;

export interface ColonyPanelFeature extends Feature {
  /** Open (optionally on a tab) / close. */
  toggle(tab?: string): void;
  open(tab?: string): void;
  close(): void;
  isOpen(): boolean;
}

type TabId = 'overview' | 'jobs' | 'nest' | 'log' | 'keeper';
const TABS: readonly { id: TabId; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'chart' },
  { id: 'jobs', label: 'Jobs', icon: 'jobs' },
  { id: 'nest', label: 'Nest', icon: 'chamber' },
  { id: 'log', label: 'Log', icon: 'skull' },
  { id: 'keeper', label: 'Keeper', icon: 'hand' },
];

const CASTE_ORDER: readonly CasteId[] = ['queen', 'king', 'worker', 'major', 'soldier', 'nasute', 'alate'];
/** Castes the player may weight for new brood (royals and alates are raised by the colony itself). */
const RATIO_CASTES: readonly CasteId[] = ['worker', 'major', 'soldier', 'nasute'];

const JOB_LABEL: Record<JobKind, string> = {
  forage: 'Forage',
  haulFood: 'Haul food',
  dig: 'Dig',
  build: 'Build',
  feedLarva: 'Feed larvae',
  feedQueen: 'Feed queen',
  carryBrood: 'Carry brood',
  carryCorpse: 'Clear corpses',
  guard: 'Guard',
  patrol: 'Patrol',
  tendGarden: 'Tend garden',
  harvestLeaves: 'Cut leaves',
  herdAphids: 'Herd aphids',
  exile: 'Hygiene',
};
const JOB_TIP: Record<JobKind, string> = {
  forage: 'Scouting and gathering food outside',
  haulFood: 'Carrying dropped food to the granary',
  dig: 'Excavating dig designations',
  build: 'Building mud walls and tubes',
  feedLarva: 'Feeding hungry larvae',
  feedQueen: 'Feeding the queen so she keeps laying',
  carryBrood: 'Moving brood to the nursery or out of danger',
  carryCorpse: 'Hauling the dead to the midden',
  guard: 'Standing guard at posts and entrances',
  patrol: 'Walking the perimeter',
  tendGarden: 'Weeding and feeding the fungus garden',
  harvestLeaves: 'Cutting leaves for the fungus garden',
  herdAphids: 'Tending and milking aphid herds',
  exile: 'Dragging infected nestmates out of the nest',
};

const CHAMBER_LABEL: Record<ChamberKind, string> = {
  queen: 'Queen chamber',
  nursery: 'Nursery',
  granary: 'Granary',
  midden: 'Midden',
  fungusGarden: 'Fungus garden',
  entrance: 'Entrance',
  barracks: 'Barracks',
};
const CHAMBER_ICON: Record<ChamberKind, string> = { queen: 'queen', nursery: 'larva', granary: 'food', midden: 'skull', fungusGarden: 'fungus', entrance: 'home', barracks: 'soldier' };

const CAUSE_LABEL: Record<DeathCause, string> = {
  age: 'Old age',
  starvation: 'Starvation',
  desiccation: 'Thirst',
  drowning: 'Drowning',
  combat: 'Combat',
  fungus: 'Fungus',
  sun: 'Sunburn',
  cull: 'Culled',
  debug: 'Debug',
};

const STAGE_NAMES = ['Scouts', 'Lone predators', 'Raids', 'Boss', 'Fungus season'];
const KEEPER_LABEL: Record<KeeperActionEx, string> = {
  dropFood: 'food drop',
  dropWater: 'water dropper',
  lamp: 'desk lamp',
  tapGlass: 'glass tap',
  openTube: 'tube to the next farm',
  shake: 'a shake',
  topUp: 'a top-up',
  contaminatedFood: 'food drop',
};

const HOLD_MS = 500;

interface Slider {
  row: HTMLElement;
  input: HTMLInputElement;
  out: HTMLOutputElement;
  pending: number | null;
  dragging: boolean;
  holdUntil: number;
  paint(): void;
  send(v: number): void;
  read(): number | null;
}

export function createColonyPanel(ctx: FeatureContext): ColonyPanelFeature {
  const { app, hud, recorder } = ctx;
  const sim = app.sim;
  const style = h('style', undefined, { 'data-myrme': 'b5-colony' }, COLONY_CSS);
  document.head.appendChild(style);

  const species = (): SpeciesDef => getSpecies(ctx.colony()?.species ?? sim.options.faction);
  const keeperAllowed = (): boolean => !!sim.map.flags.slab && (ctx.options.mode === 'sandbox' || sim.goal?.def?.kind === 'sandbox');

  // ---------------------------------------------------------------------------------------
  // sliders (coalesced like the quick panel: commands leave at the HUD rate and on release)
  // ---------------------------------------------------------------------------------------
  const sliders: Slider[] = [];
  function mkSlider(cls: string, label: string | null, tip: string, min: number, max: number, step: number, testid: string, send: (v: number) => void, read: () => number | null): Slider {
    const input = h('input', undefined, { type: 'range', min, max, step, value: (min + max) / 2, 'aria-label': label ?? tip, testid });
    const out = h('output');
    const row = h('div', cls, { tip }, label === null ? [input, out] : [h('label', undefined, null, label), input, out]);
    const s: Slider = {
      row,
      input,
      out,
      pending: null,
      dragging: false,
      holdUntil: 0,
      send,
      read,
      paint() {
        const v = Number(input.value);
        setStyle(input, '--fill', `${(((v - min) / (max - min)) * 100).toFixed(1)}%`);
        setText(out, `${Math.round(v * 100)}%`);
      },
    };
    ctx.d.on(input, 'pointerdown', () => {
      s.dragging = true;
    });
    ctx.d.on(input, 'input', () => {
      s.pending = Number(input.value);
      s.paint();
    });
    const release = (): void => {
      s.dragging = false;
      flush(s, performance.now());
      input.blur();
    };
    ctx.d.on(input, 'change', release);
    ctx.d.on(input, 'pointerup', release);
    ctx.d.on(input, 'pointercancel', release);
    ctx.d.on(input, 'keydown', (e: KeyboardEvent) => e.stopPropagation());
    s.paint();
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
  function syncSliders(now: number): void {
    for (const s of sliders) {
      if (s.pending !== null) {
        flush(s, now);
        continue;
      }
      if (s.dragging || now < s.holdUntil || !s.row.isConnected) continue;
      const v = s.read();
      if (v === null) continue;
      if (Math.abs(Number(s.input.value) - v) > 1e-3) {
        s.input.value = String(v);
        s.paint();
      }
    }
  }

  const sec = (title: string, children: (Node | null)[], testid?: string): HTMLElement => h('div', 'mc-sec', testid ? { testid } : null, [h('h5', undefined, null, title), ...children]);
  const jump = (pos: Vec3, dist?: number): void => {
    ctx.input()?.jumpTo(pos, dist);
    ctx.audio?.ui('click');
  };

  // ---------------------------------------------------------------------------------------
  // Overview
  // ---------------------------------------------------------------------------------------
  const popTotal = h('span', 'mc-big', { testid: 'colony-pop' }, '0');
  const popSub = h('span', 'mc-sub');
  const popSpark = createSparkline('var(--mh-accent)');
  const casteChips = h('div', 'mc-castes');
  const casteVals = new Map<string, HTMLElement>();
  const secPop = sec('Population', [h('div', 'mc-popline', { tip: 'Adults now, the peak so far, and the last ten minutes' }, [popTotal, popSub, popSpark.el]), casteChips]);

  const stage = (ic: string, label: string, testid: string): { el: HTMLElement; val: HTMLElement } => {
    const val = h('b', undefined, { testid }, '0');
    return { el: h('div', 'mc-stage', null, [icon(ic), val, h('span', undefined, null, label)]), val };
  };
  const stEggs = stage('egg', 'eggs', 'colony-eggs');
  const stLarvae = stage('larva', 'larvae', 'colony-larvae');
  const stPupae = stage('pupa', 'pupae', 'colony-pupae');
  const broodNote = h('div', 'mc-hint mh-hidden');
  const secBrood = sec('Brood pipeline', [h('div', 'mc-pipe', { tip: 'Eggs hatch into larvae, which must be fed before they pupate' }, [stEggs.el, icon('chevron', 'mc-arrow'), stLarvae.el, icon('chevron', 'mc-arrow'), stPupae.el]), broodNote]);

  interface StoreRow {
    key: SeriesKey;
    el: HTMLElement;
    val: HTMLElement;
    rate: HTMLElement;
    spark: Sparkline;
  }
  const mkStore = (key: SeriesKey, ic: string, label: string, tip: string): StoreRow => {
    const val = h('b', undefined, { testid: `colony-store-${key}` }, '0');
    const rate = h('span', 'mc-rate', { testid: `colony-rate-${key}` });
    const spark = createSparkline('var(--mh-amber)');
    return { key, val, rate, spark, el: h('div', 'mc-store', { tip }, [icon(ic), h('span', 'mc-lbl', null, label), val, rate, spark.el]) };
  };
  const stores: StoreRow[] = [
    mkStore('food', 'food', 'Food', 'Stored food and net change per minute'),
    mkStore('leaves', 'leaf', 'Leaves', 'Leaf fragments waiting for the fungus garden'),
    mkStore('wood', 'wood', 'Wood', 'Wood pulp'),
    mkStore('mud', 'drop', 'Mud', 'Building mud'),
  ];
  const secStores = sec('Stores', stores.map((s) => s.el));

  const ratioBox = h('div');
  const secRatio = sec('New brood', [ratioBox, h('div', 'mc-hint', null, 'Share of new eggs destined for each caste.')]);
  let ratioKey = '';
  function buildRatio(sp: SpeciesDef): void {
    const castes = RATIO_CASTES.filter((c) => sp.castes[c]);
    const key = `${sp.id}:${castes.join(',')}`;
    if (key === ratioKey) return;
    ratioKey = key;
    for (let i = sliders.length - 1; i >= 0; i--) if (sliders[i].row.parentElement === ratioBox) sliders.splice(i, 1);
    ratioBox.replaceChildren(
      ...castes.map((c) => {
        const read = (): number | null => {
          const col = ctx.colony();
          if (!col) return null;
          let sum = 0;
          for (const k of castes) sum += col.casteRatio?.[k] ?? 0;
          return sum > 0 ? (col.casteRatio?.[c] ?? 0) / sum : 0;
        };
        const s = mkSlider(
          `mh-slider ${c === 'worker' || c === 'major' ? '' : 'mh-s-defend'}`,
          sp.castes[c]?.name ?? humanize(c),
          `Share of new brood raised as ${(sp.castes[c]?.name ?? c).toLowerCase()}s`,
          0,
          1,
          0.02,
          `caste-${c}`,
          (v) => {
            // keep the weights normalised: the others share what is left, in their current proportions
            const col = ctx.colony();
            const others = castes.filter((k) => k !== c);
            let rest = 0;
            for (const k of others) rest += col?.casteRatio?.[k] ?? 0;
            app.command({ type: 'setCasteRatio', caste: c, value: v });
            for (const k of others) {
              const share = rest > 0 ? (col?.casteRatio?.[k] ?? 0) / rest : 1 / others.length;
              app.command({ type: 'setCasteRatio', caste: k, value: (1 - v) * share });
            }
          },
          read,
        );
        return s.row;
      }),
    );
  }

  const kvRow = (label: string, testid: string): { l: HTMLElement; v: HTMLElement } => ({ l: h('span', undefined, null, label), v: h('span', undefined, { testid }) });
  const kThreat = kvRow('Threat', 'colony-threat');
  const kNear = kvRow('Near nest', 'colony-hostiles');
  const kWeather = kvRow('Weather', 'colony-weather');
  const kForecast = kvRow('Forecast', 'colony-forecast');
  const kShelter = kvRow('Nest', 'colony-shelter');
  const secStatus = sec('Threat & weather', [h('div', 'mc-kv', null, [kThreat.l, kThreat.v, kNear.l, kNear.v, kWeather.l, kWeather.v, kForecast.l, kForecast.v, kShelter.l, kShelter.v])]);

  const extraBox = h('div', 'mc-kv');
  const secExtra = sec('Faction', [extraBox], 'colony-faction');
  const pageOverview = h('div', 'mc-page', { testid: 'colony-page-overview' }, [secPop, secBrood, secStores, secRatio, secStatus, secExtra]);

  // ---------------------------------------------------------------------------------------
  // Jobs
  // ---------------------------------------------------------------------------------------
  interface JobRow {
    kind: JobKind;
    el: HTMLElement;
    count: HTMLElement;
    slider: Slider;
  }
  const jobRows = new Map<JobKind, JobRow>();
  const jobBox = h('div');
  for (const kind of JOB_KINDS) {
    const count = h('span', 'mc-jcount', { testid: `job-count-${kind}` });
    const slider = mkSlider(
      '',
      null,
      '',
      0,
      2,
      0.05,
      `job-prio-${kind}`,
      (v) => app.command({ type: 'setPriority', job: kind, value: v }),
      () => {
        const v = ctx.colony()?.priorities?.[kind];
        return typeof v === 'number' ? v : null;
      },
    );
    const el = h('div', 'mc-job', { tip: `${JOB_TIP[kind]} — ants assigned / open slots, and the priority` }, [h('span', 'mc-jname', null, JOB_LABEL[kind]), count, slider.input, slider.out]);
    slider.row = el;
    jobRows.set(kind, { kind, el, count, slider });
    jobBox.append(el);
  }
  const actBox = h('div', 'mc-acts', { testid: 'colony-activity' });
  const idleNote = h('div', 'mc-hint');
  const pageJobs = h('div', 'mc-page mh-hidden', { testid: 'colony-page-jobs' }, [
    sec('Job board', [h('div', 'mc-job mc-jobhead', null, [h('span', undefined, null, 'Job'), h('span', 'mc-jcount', null, 'Ants'), h('span', undefined, null, 'Priority'), h('span')]), jobBox]),
    sec('Right now', [actBox, idleNote]),
  ]);

  // ---------------------------------------------------------------------------------------
  // Nest
  // ---------------------------------------------------------------------------------------
  const chamberList = h('div', 'mc-list', { testid: 'colony-chambers' });
  let chamberPos: Vec3[] = [];
  ctx.d.on(chamberList, 'click', (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (!b) return;
    const p = chamberPos[Number(b.dataset.i)];
    if (p) jump(p, 16);
    b.blur();
  });
  const mkStat = (label: string, testid: string): { el: HTMLElement; val: HTMLElement } => {
    const val = h('b', undefined, { testid }, '0');
    return { el: h('div', 'mc-stat', null, [val, h('span', undefined, null, label)]), val };
  };
  const sBorn = mkStat('born', 'colony-born');
  const sDeaths = mkStat('died', 'colony-deaths');
  const sKills = mkStat('kills', 'colony-kills');
  const sDug = mkStat('voxels dug', 'colony-dug');
  const sFood = mkStat('food gathered', 'colony-gathered');
  const sAge = mkStat('colony age', 'colony-age');
  const pageNest = h('div', 'mc-page mh-hidden', { testid: 'colony-page-nest' }, [
    sec('Chambers', [chamberList, h('div', 'mc-hint', null, 'Click a chamber to move the camera there.')]),
    sec('Lifetime', [h('div', 'mc-stats', null, [sBorn.el, sDeaths.el, sKills.el, sDug.el, sFood.el, sAge.el])]),
  ]);

  // ---------------------------------------------------------------------------------------
  // Log
  // ---------------------------------------------------------------------------------------
  const causeBox = h('div', undefined, { testid: 'colony-causes' });
  const deathList = h('div', 'mc-list', { testid: 'colony-deathlog' });
  let deathPos: Vec3[] = [];
  ctx.d.on(deathList, 'click', (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (!b) return;
    const p = deathPos[Number(b.dataset.i)];
    if (p) jump(p, 14);
    b.blur();
  });
  const pageLog = h('div', 'mc-page mh-hidden', { testid: 'colony-page-log' }, [sec('Causes of death', [causeBox]), sec('Recent deaths', [deathList])]);

  // ---------------------------------------------------------------------------------------
  // Keeper
  // ---------------------------------------------------------------------------------------
  const dropPos = (): Vec3 => {
    const w = sim.world;
    const c = app.view.cursorWorld ?? ctx.colony()?.nestPos ?? { x: w.sx / 2, y: 0, z: w.sz / 2 };
    return { x: Math.min(w.sx - 2, Math.max(2, c.x)), y: w.sy - 1, z: Math.min(w.sz - 1, Math.max(1, c.z)) };
  };
  const mkKeeper = (id: string, ic: string, label: string, tip: string, fn: () => void): HTMLButtonElement => {
    const b = h('button', 'mh-btn', { type: 'button', testid: `keeper-${id}`, tip }, [icon(ic), h('span', undefined, null, label)]);
    ctx.d.on(b, 'click', () => {
      fn();
      ctx.audio?.ui('confirm');
      b.blur();
    });
    return b;
  };
  const bLamp = mkKeeper('lamp', 'lamp', 'Desk lamp', 'Switch the desk lamp — warms one side of the farm', () => app.command(keeperCommand('lamp', { pos: { x: sim.world.sx * 0.75, y: sim.world.sy - 1, z: sim.world.sz / 2 } })));
  const keeperBtns = h('div', 'mc-keeper', null, [
    mkKeeper('dropFood', 'food', 'Drop food', 'Drop food through the lid above the cursor (or the nest)', () => app.command(keeperCommand('dropFood', { pos: dropPos() }))),
    mkKeeper('dropWater', 'drop', 'Add water', 'A dropper of water above the cursor (or the nest) — a local flood', () => app.command(keeperCommand('dropWater', { pos: dropPos() }))),
    bLamp,
    mkKeeper('tapGlass', 'hand', 'Tap the glass', 'Tap the pane — the colony panics for a moment', () => app.command(keeperCommand('tapGlass', { pos: ctx.colony()?.nestPos }))),
  ]);
  const keeperState = h('div', 'mc-kv', { testid: 'keeper-state' });
  const kLamp = kvRow('Lamp', 'keeper-lamp-state');
  const kNext = kvRow('Keeper', 'keeper-next');
  const kCount = kvRow('So far', 'keeper-counts');
  keeperState.append(kLamp.l, kLamp.v, kNext.l, kNext.v, kCount.l, kCount.v);
  const pageKeeper = h('div', 'mc-page mh-hidden', { testid: 'colony-page-keeper' }, [
    sec('You are the keeper', [keeperBtns, h('div', 'mc-hint', null, 'Food and water land above the cursor, or above the nest when the cursor is off the farm.')]),
    sec('Farm', [keeperState]),
  ]);

  // ---------------------------------------------------------------------------------------
  // frame
  // ---------------------------------------------------------------------------------------
  const pages: Record<TabId, HTMLElement> = { overview: pageOverview, jobs: pageJobs, nest: pageNest, log: pageLog, keeper: pageKeeper };
  const tabBtns = new Map<TabId, HTMLButtonElement>();
  const tabs = h('div', 'mc-tabs', { role: 'tablist' });
  for (const t of TABS) {
    const b = h('button', 'mh-btn mc-tab', { type: 'button', role: 'tab', testid: `colony-tab-${t.id}` }, [icon(t.icon), h('span', undefined, null, t.label)]);
    ctx.d.on(b, 'click', () => {
      setTab(t.id);
      ctx.audio?.ui('click');
      b.blur();
    });
    tabBtns.set(t.id, b);
    tabs.append(b);
  }
  const speciesName = h('span', 'mc-species mh-dim');
  const x = h('button', 'mh-btn mh-x', { type: 'button', 'aria-label': 'Close', testid: 'colony-close' }, [icon('close')]);
  const head = h('div', 'mh-panel-head', null, [icon('home'), h('span', undefined, null, 'Colony'), speciesName, x]);
  const body = h('div', 'mc-body', null, [pageOverview, pageJobs, pageNest, pageLog, pageKeeper]);
  const el = h('div', 'mh-panel mc-colony mh-hidden', { testid: 'colony-panel', role: 'region', 'aria-label': 'Colony' }, [head, tabs, body]);
  hud.slot('topLeft').append(el);

  let open = false;
  let tab: TabId = 'overview';
  let popEscape: (() => void) | null = null;
  let unsubAction: (() => void) | null = null;
  let lastSlow = -1e9;
  let lastLayout = -1e9;
  let lastSamples = -1;

  function setTab(id: TabId): void {
    if (id === 'keeper' && !keeperAllowed()) id = 'overview';
    tab = id;
    for (const t of TABS) {
      setShown(pages[t.id], t.id === id);
      setClass(tabBtns.get(t.id)!, 'mh-on', t.id === id);
      tabBtns.get(t.id)!.setAttribute('aria-selected', String(t.id === id));
    }
    body.scrollTop = 0;
    lastSlow = -1e9;
    lastSamples = -1;
    if (open) render(performance.now(), true);
  }

  function setOpen(o: boolean, t?: string): void {
    if (t && (TABS as readonly { id: string }[]).some((d) => d.id === t)) setTab(t as TabId);
    if (o === open) return;
    open = o;
    setShown(el, open);
    hud.setQuickPanelCollapsed(!open);
    popEscape?.();
    popEscape = null;
    if (open) {
      popEscape =
        ctx.input()?.pushEscape(() => {
          if (!open) return false;
          setOpen(false);
          return true;
        }) ?? null;
      lastSlow = -1e9;
      lastLayout = -1e9;
      lastSamples = -1;
      ctx.audio?.ui('open');
      render(performance.now(), true);
    } else ctx.audio?.ui('close');
  }
  ctx.d.on(x, 'click', () => setOpen(false));
  setTab('overview');

  // toolbar button (caption follows key rebinding)
  let toolBtn: { remove(): void } | null = null;
  const addToolBtn = (): void => {
    toolBtn?.remove();
    toolBtn = hud.addToolbarButton({ id: 'colony', icon: 'home', label: 'Colony panel', hint: ctx.hint('ui.colony'), tip: 'Colony panel — population, jobs, nest', onClick: () => setOpen(!open), active: () => open });
  };
  addToolBtn();
  let hintShown = ctx.hint('ui.colony');
  ctx.d.add(
    ctx.settings.subscribe((_s, changed) => {
      if (changed === 'keys' || changed === 'all') hintShown = '\u0000'; // re-read on the next update (the keymap reloads first)
    }),
  );

  /** Keep the card inside the band between its top edge and the minimap. */
  function layout(): void {
    const root = hud.root;
    const top = el.getBoundingClientRect().top;
    const mm = root.querySelector<HTMLElement>('[data-testid="minimap"]');
    const fs = parseFloat(getComputedStyle(root).fontSize) || 12;
    let bottom = root.clientHeight - fs * 0.6;
    if (mm && mm.offsetParent !== null) bottom = Math.min(bottom, mm.getBoundingClientRect().top - fs * 0.6);
    setStyle(el, 'max-height', `${Math.max(fs * 9, Math.floor(bottom - top))}px`);
  }

  // The goal tracker / tutorial card above can grow at any moment (checklist unfolds): re-fit at
  // once instead of waiting for the 500 ms poll, so the card never rides over the minimap.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      if (open) layout();
    });
    ro.observe(hud.slot('goal'));
    ro.observe(hud.slot('topLeft'));
    ro.observe(hud.root);
    ctx.d.add(() => ro.disconnect());
  }

  // ---------------------------------------------------------------------------------------
  // model → DOM
  // ---------------------------------------------------------------------------------------
  function renderOverview(colony: Readonly<Colony> | undefined, sp: SpeciesDef, slow: boolean): void {
    const pop = colony?.population;
    const total = pop?.total || recorder.last('population');
    setText(popTotal, String(Math.round(total)));
    setText(popSub, `peak ${Math.round(Math.max(recorder.peak('population'), total))}`);
    const by = pop?.byCaste ?? {};
    let key = '';
    for (const c of CASTE_ORDER) if ((by[c] ?? 0) > 0) key += c + ',';
    renderKeyed(casteChips, `${sp.id}:${key}`, () => {
      casteVals.clear();
      const out: Node[] = [];
      for (const c of CASTE_ORDER) {
        if (!((by[c] ?? 0) > 0)) continue;
        const v = h('b', undefined, { testid: `colony-caste-${c}` }, '0');
        casteVals.set(c, v);
        out.push(h('span', 'mh-chip', { tip: sp.castes[c]?.name ?? humanize(c) }, [icon(casteIcon(c)), h('span', undefined, null, sp.castes[c]?.name ?? humanize(c)), v]));
      }
      return out;
    });
    for (const [c, v] of casteVals) setText(v, String(by[c as CasteId] ?? 0));

    setText(stEggs.val, String(pop?.eggs ?? 0));
    setText(stLarvae.val, String(pop?.larvae ?? 0));
    setText(stPupae.val, String(pop?.pupae ?? 0));

    const st = colony?.stores;
    const show: Record<string, boolean> = { food: true, leaves: sp.caps.farmsFungus || (st?.leaves ?? 0) > 0, wood: sp.caps.eatsWood || (st?.wood ?? 0) > 0, mud: sp.caps.canFill || (st?.mud ?? 0) > 0 };
    for (const r of stores) {
      setShown(r.el, show[r.key]);
      if (!show[r.key]) continue;
      setText(r.val, fmtNum(Math.floor((st as unknown as Record<string, number> | undefined)?.[r.key] ?? 0)));
    }

    if (!slow) return;
    // ---- 1 Hz-ish: sparklines, rates, status, faction extras ----
    const n = recorder.samples;
    if (n !== lastSamples) {
      lastSamples = n;
      popSpark.set(recorder.values('population'), n);
      for (const r of stores) {
        if (!show[r.key]) continue;
        r.spark.set(recorder.values(r.key), n);
        const rate = recorder.ratePerMinute(r.key, 60);
        const a = Math.abs(rate);
        setText(r.rate, a < 0.05 ? '±0 /min' : `${rate > 0 ? '+' : '−'}${a >= 10 ? Math.round(a) : a.toFixed(1)} /min`);
        setClass(r.rate, 'mc-up', rate >= 0.05);
        setClass(r.rate, 'mc-down', rate <= -0.05);
      }
    }
    const hungry = pop && pop.larvae > 0 && (st?.food ?? 0) <= 0;
    setShown(broodNote, !!hungry);
    if (hungry) setText(broodNote, 'No food in store — larvae are going hungry.');

    buildRatio(sp);
    setShown(secRatio, ratioBox.childElementCount > 1);

    // threat & weather
    const dir = sim.director;
    const threatText = !dir?.enabled ? 'Peaceful — no threat director' : `${STAGE_NAMES[Math.min(STAGE_NAMES.length - 1, Math.max(0, dir.stage | 0))]} · intensity ×${(dir.intensity ?? 1).toFixed(1)}`;
    setText(kThreat.v, threatText);
    const hostiles = Math.round(recorder.last('threat'));
    setText(kNear.v, hostiles > 0 ? `${hostiles} hostile${hostiles === 1 ? '' : 's'}` : 'All quiet');
    setClass(kNear.v, 'mc-bad', hostiles > 0);
    setClass(kNear.v, 'mc-good', hostiles === 0);
    const w = sim.weather;
    let wl = humanize(w.kind);
    let fc = '';
    try {
      wl = weatherLabel(w) || wl;
      fc = forecastLabel(w, 180);
    } catch {
      /* B2 fields not there yet */
    }
    setText(kWeather.v, `${wl} · ${Number.isFinite(w.temperature) ? Math.round(w.temperature) : '–'}°C${w.wetness > 0.3 ? ' · wet ground' : ''}`);
    setShown(kForecast.l, fc !== '');
    setShown(kForecast.v, fc !== '');
    setText(kForecast.v, fc);
    let shelter = '';
    let bad = false;
    try {
      const cs = colony ? envOf(sim)?.colonyState(colony.id) : undefined;
      if (cs) {
        if (cs.flooded) {
          shelter = `Flooding — ${cs.threatenedBrood.length} brood at risk`;
          bad = true;
        } else if (cs.shelter !== 'none') shelter = `Sheltering from the ${cs.shelter}`;
        else shelter = 'Dry';
      }
    } catch {
      /* ignore */
    }
    setShown(kShelter.l, shelter !== '');
    setShown(kShelter.v, shelter !== '');
    setText(kShelter.v, shelter);
    setClass(kShelter.v, 'mc-bad', bad);

    renderExtras(colony, sp);
  }

  function renderExtras(colony: Readonly<Colony> | undefined, sp: SpeciesDef): void {
    const rows: [string, string, string, number | null][] = []; // label, text, class, bar 0..1
    if (colony) {
      const b3 = b3StateOf(sim);
      const caps = sp.caps;
      if (caps.farmsFungus) {
        const gs = b3.gardens.filter((g) => g.colony === colony.id);
        if (!gs.length) {
          const ch = colony.chambers.find((c) => c.kind === 'fungusGarden');
          rows.push(['Garden', ch ? `Health ${Math.round(ch.health * 100)}%` : 'Not founded yet', ch && ch.health < 0.4 ? 'mc-bad' : '', ch ? ch.health : null]);
        }
        gs.forEach((g, i) => {
          rows.push([gs.length > 1 ? `Garden ${i + 1}` : 'Garden', `${humanize(g.status)} · ${Math.round(g.health * 100)}%`, g.status === 'sick' || g.status === 'collapsed' ? 'mc-bad' : g.status === 'healthy' ? 'mc-good' : '', g.health]);
          rows.push(['Fungus', `${fmtNum(g.biomass)} / ${fmtNum(g.capacity)} · ${g.tenders} tending`, '', g.capacity > 0 ? g.biomass / g.capacity : 0]);
          rows.push(['Mould', `${Math.round(g.mould * 100)}%`, g.mould > 0.3 ? 'mc-bad' : g.mould > 0.1 ? 'mc-warn' : '', null]);
        });
      }
      if (caps.canFill || caps.eatsWood) {
        const t = b3.termite.find((x) => x.colony === colony.id);
        rows.push(['Stores', `${fmtNum(Math.floor(colony.stores.wood))} wood · ${fmtNum(Math.floor(colony.stores.mud))} mud`, '', null]);
        if (t) {
          rows.push(['Mound', `${t.mound.height} high · ${t.mound.chimneys} chimney${t.mound.chimneys === 1 ? '' : 's'}`, '', null]);
          const done = t.tubes.filter((x) => x.done).length;
          rows.push(['Tubes', t.tubes.length ? `${done} / ${t.tubes.length} roofed` : 'None yet', '', t.tubes.length ? done / t.tubes.length : null]);
          if (t.breaches.length) rows.push(['Breaches', `${t.breaches.length} open`, 'mc-bad', null]);
          if (t.scorched > 0) rows.push(['Sun', `${t.scorched} scorched`, 'mc-warn', null]);
        }
        if (caps.sunSensitive && !t) rows.push(['Sun', 'Workers burn in the open — build cover', 'mc-warn', null]);
      }
      if (caps.herdsAphids) {
        const hs = b3.herds.filter((x) => x.owner === colony.id);
        const aphids = hs.reduce((s, x) => s + x.aphids.length, 0);
        const rate = hs.reduce((s, x) => s + x.honeydewRate, 0);
        rows.push(['Aphids', hs.length ? `${hs.length} herd${hs.length === 1 ? '' : 's'} · ${aphids} aphids` : b3.herds.length ? 'Wild herds nearby — not found yet' : 'No herds', hs.length ? 'mc-good' : '', null]);
        if (hs.length) rows.push(['Honeydew', `+${(rate * 60).toFixed(1)} /min`, '', null]);
      }
      if (caps.rafts) {
        const rs = b3.rafts.filter((x) => x.colony === colony.id);
        rows.push(['Rafts', rs.length ? rs.map((r) => `${humanize(r.phase)} (${r.members.length})`).join(', ') : 'Ready — the colony floats when flooded', rs.length ? 'mc-warn' : '', null]);
      }
    }
    setShown(secExtra, rows.length > 0);
    setText(secExtra.firstElementChild as HTMLElement, sp.name);
    renderKeyed(extraBox, rows.map((r) => r.join('~')).join('|'), () => {
      const out: Node[] = [];
      for (const [label, text, cls, bar] of rows) {
        out.push(h('span', undefined, null, label));
        const fill = h('i');
        if (bar !== null) fill.style.transform = `scaleX(${Math.min(1, Math.max(0, bar)).toFixed(3)})`;
        out.push(bar === null ? h('span', cls, null, text) : h('span', `mc-barval ${cls}`, null, [h('span', undefined, null, text), h('span', 'mh-bar', null, [fill])]));
      }
      return out;
    });
  }

  function renderJobs(colony: Readonly<Colony> | undefined, sp: SpeciesDef, slow: boolean): void {
    const summary = colony ? jobSummary(colony) : {};
    const relevant = (k: JobKind): boolean => {
      if (summary[k]) return true;
      if (k === 'build') return sp.caps.canFill;
      if (k === 'tendGarden' || k === 'harvestLeaves') return sp.caps.farmsFungus;
      if (k === 'herdAphids') return sp.caps.herdsAphids;
      return true;
    };
    for (const r of jobRows.values()) {
      const s = summary[r.kind];
      const show = relevant(r.kind);
      setShown(r.el, show);
      if (!show) continue;
      setClass(r.el, 'mc-idle', !s);
      const key = s ? `${s.assigned}/${s.slots}` : '';
      if (r.count.dataset.k !== key) {
        r.count.dataset.k = key;
        r.count.replaceChildren(...(s ? [h('b', undefined, null, String(s.assigned)), ` / ${s.slots}`] : ['–']));
      }
    }
    if (!slow) return;
    // what the ants are doing right now
    const counts = new Map<string, number>();
    let total = 0;
    let idle = 0;
    const pc = sim.playerColony;
    for (const a of sim.ants) {
      if (!a.alive || a.colony !== pc) continue;
      total++;
      let label = antActivityLabel(a);
      const cut = label.indexOf(' — ');
      if (cut > 0) label = label.slice(0, cut);
      if (label === 'Idle' || label === 'Wandering') idle++;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1)).slice(0, 9);
    renderKeyed(actBox, top.map((t) => `${t[0]}:${t[1]}`).join('|') + `/${total}`, () =>
      top.map(([label, n]) => {
        const fill = h('i');
        fill.style.transform = `scaleX(${(total ? n / total : 0).toFixed(3)})`;
        return h('div', 'mc-act', null, [h('span', undefined, null, label), h('span', 'mh-bar', null, [fill]), h('b', undefined, null, String(n))]);
      }),
    );
    const open2 = Math.round(recorder.last('jobsOpen'));
    setText(idleNote, total ? `${idle} of ${total} ants idle · ${open2} open job slot${open2 === 1 ? '' : 's'}` : 'No ants.');
  }

  function renderNest(colony: Readonly<Colony> | undefined): void {
    const chambers = colony?.chambers ?? [];
    const entrances = colony?.entrances ?? [];
    const items: { ic: string; label: string; meta: string; health: number | null; pos: Vec3 }[] = [];
    const seen: Record<string, number> = {};
    for (const c of chambers) {
      seen[c.kind] = (seen[c.kind] ?? 0) + 1;
      const many = chambers.filter((k) => k.kind === c.kind).length > 1;
      items.push({ ic: CHAMBER_ICON[c.kind] ?? 'chamber', label: `${CHAMBER_LABEL[c.kind] ?? humanize(c.kind)}${many ? ` ${seen[c.kind]}` : ''}`, meta: `r ${c.radius.toFixed(1)}`, health: c.kind === 'fungusGarden' ? c.health : null, pos: c.pos });
    }
    if (!chambers.some((c) => c.kind === 'entrance')) {
      const tmp = { x: 0, y: 0, z: 0 };
      entrances.forEach((cell, i) => {
        const p = sim.world.cellCenter(cell, tmp);
        items.push({ ic: 'home', label: `Entrance${entrances.length > 1 ? ` ${i + 1}` : ''}`, meta: 'surface', health: null, pos: { x: p.x, y: p.y, z: p.z } });
      });
    }
    if (colony && !items.length) items.push({ ic: 'queen', label: 'Nest', meta: '', health: null, pos: colony.nestPos });
    chamberPos = items.map((i) => i.pos);
    renderKeyed(chamberList, items.map((i) => `${i.label}:${i.meta}:${i.health === null ? '' : Math.round(i.health * 20)}:${Math.round(i.pos.x)},${Math.round(i.pos.y)},${Math.round(i.pos.z)}`).join('|'), () =>
      items.length
        ? items.map((it, i) => {
            const fill = h('i');
            if (it.health !== null) fill.style.transform = `scaleX(${Math.min(1, Math.max(0, it.health)).toFixed(3)})`;
            return h('button', 'mc-item', { type: 'button', 'data-i': i, testid: `chamber-${i}`, tip: 'Jump the camera here' }, [
              icon(it.ic),
              h('span', undefined, null, it.label),
              it.health !== null ? h('span', `mh-bar${it.health < 0.4 ? ' mh-low' : ''}`, null, [fill]) : null,
              h('span', 'mc-meta', null, it.meta),
            ]);
          })
        : [h('div', 'mc-empty', null, 'No chambers yet.')],
    );
    const sum = recorder.summary(sim);
    setText(sBorn.val, fmtNum(sum.born));
    setText(sDeaths.val, fmtNum(sum.deaths));
    setText(sKills.val, fmtNum(sum.kills));
    setText(sDug.val, fmtNum(sum.dugVoxels));
    setText(sFood.val, fmtNum(Math.floor(sum.foodGathered)));
    setText(sAge.val, sum.days >= 1 ? `${sum.days.toFixed(1)} d` : fmtTime(sim.time));
  }

  function renderLog(): void {
    const by = recorder.deathsByCause();
    const causes = (Object.keys(by) as DeathCause[]).map((c) => [c, by[c] ?? 0] as const).sort((p, q) => q[1] - p[1]);
    const max = causes.length ? causes[0][1] : 1;
    renderKeyed(causeBox, causes.map((c) => `${c[0]}:${c[1]}`).join('|') || 'none', () =>
      causes.length
        ? causes.map(([c, n]) => {
            const fill = h('i');
            fill.style.transform = `scaleX(${(n / max).toFixed(3)})`;
            return h('div', 'mc-cause', { testid: `cause-${c}` }, [h('span', undefined, null, CAUSE_LABEL[c] ?? humanize(c)), h('span', 'mh-bar', null, [fill]), h('b', undefined, null, String(n))]);
          })
        : [h('div', 'mc-empty', null, 'No deaths so far.')],
    );
    const log = recorder.deathLog(24);
    deathPos = log.map((d) => d.pos);
    const sp = species();
    renderKeyed(deathList, log.length ? `${log[0].tick}:${log.length}:${log[log.length - 1].tick}` : 'none', () =>
      log.length
        ? log.map((d, i) =>
            h('button', 'mc-item mc-death', { type: 'button', 'data-i': i, tip: 'Jump to where it happened' }, [
              icon(casteIcon(d.caste)),
              h('span', undefined, null, `${sp.castes[d.caste]?.name ?? humanize(d.caste)} — ${(CAUSE_LABEL[d.cause] ?? d.cause).toLowerCase()}`),
              h('span', 'mc-meta', null, fmtTime(d.tick / 30)),
            ]),
          )
        : [h('div', 'mc-empty', null, 'Nothing to report.')],
    );
  }

  function renderKeeper(): void {
    const k = b3StateOf(sim).keeper;
    setClass(bLamp, 'mh-on', k.lampOn);
    setText(kLamp.v, k.lampOn ? 'On' : 'Off');
    const s = Math.max(0, Math.ceil((k.nextTick - sim.tick) / 30));
    setText(kNext.v, k.enabled ? `Next: ${KEEPER_LABEL[k.nextAction] ?? k.nextAction} in ${fmtTime(s)}` : 'Away — the farm is all yours');
    const c = k.counts;
    setText(kCount.v, `${c.dropFood ?? 0} food · ${c.dropWater ?? 0} water · ${c.tapGlass ?? 0} taps`);
  }

  function render(now: number, force = false): void {
    const colony = ctx.colony();
    const sp = species();
    setText(speciesName, sp.name);
    const kOk = keeperAllowed();
    setShown(tabBtns.get('keeper')!, kOk);
    setClass(tabs, 'mc-many', kOk);
    if (!kOk && tab === 'keeper') setTab('overview');
    const slow = force || now - lastSlow >= 500;
    if (slow) lastSlow = now;
    if (force || now - lastLayout >= 500) {
      lastLayout = now;
      layout();
    }
    if (tab === 'overview') renderOverview(colony, sp, slow);
    else if (tab === 'jobs') renderJobs(colony, sp, slow);
    else if (tab === 'nest') {
      if (slow) renderNest(colony);
    } else if (tab === 'log') {
      if (slow) renderLog();
    } else if (slow) renderKeeper();
  }

  return {
    toggle(t) {
      if (open && t && t !== tab) setTab(t as TabId);
      else setOpen(!open, t);
    },
    open(t) {
      setOpen(true, t);
    },
    close() {
      setOpen(false);
    },
    isOpen: () => open,
    update(now) {
      if (!unsubAction) {
        const api = ctx.input();
        if (api) {
          unsubAction = api.onAction((a) => {
            if (a === 'ui.colony') setOpen(!open);
          });
        }
      }
      const hint = ctx.hint('ui.colony');
      if (hint !== hintShown) {
        hintShown = hint;
        addToolBtn();
      }
      // possession hides the map HUD: the docked panel goes with it
      setShown(el, open && app.view.mode !== 'possess');
      if (!open) return;
      syncSliders(now);
      render(now);
    },
    dispose() {
      popEscape?.();
      unsubAction?.();
      toolBtn?.remove();
      el.remove();
      style.remove();
    },
  };
}
