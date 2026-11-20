/**
 * Title menu + New Game flow + loading screen (B5 item 1). Pure DOM, no game objects: the app
 * shell (`game/App.ts`) owns the flow and the attract-mode game rendered behind it; this file
 * builds the screens inside the shell root and reports choices through callbacks.
 *
 * New Game: Habitat (six maps with real generated previews) → Species (four factions) →
 * Colony (seed, size, difficulty, goal vs sandbox) → found.
 */
import { DIFFICULTIES, DIFFICULTY_INTENSITY, FACTION_INFO, type AudioLayerB5, type CasteDef, type Difficulty, type GameMode, type MapId, type MapSize, type NewGameConfig, type SpeciesDef, type SpeciesId } from '../core';
import { SPECIES } from '../sim/data/species';
import { MAPS, getMap } from '../world/maps';
import { Disposer, h, setClass, setText } from './dom';
import { icon } from './icons';
import { ThumbQueue } from './mapThumb';

export type MenuStep = 'title' | 'map' | 'faction' | 'setup';

export interface MenuCallbacks {
  onStart(cfg: NewGameConfig): void;
  onSettings(): void;
  /** Step changed (the shell swaps the veil / plays sounds). */
  onStep(step: MenuStep): void;
}

/** Short map goal for a card, from the generator (cached with the preview seed). */
const GOAL_CACHE = new Map<MapId, string>();
function mapGoalLabel(id: MapId): string {
  let g = GOAL_CACHE.get(id);
  if (g === undefined) {
    try {
      g = getMap(id).generate(1, { faction: 'gardenAnt', small: true }).goal.label;
    } catch {
      g = '';
    }
    GOAL_CACHE.set(id, g);
  }
  return g;
}

const FACTION_TINT: Record<SpeciesId, { body: string; tint: string }> = {
  gardenAnt: { body: '#1d1a18', tint: '#9fd86b' },
  fireAnt: { body: '#b4432a', tint: '#ef6f61' },
  leafcutter: { body: '#9a5a2a', tint: '#7fc46a' },
  termite: { body: '#e6d6ae', tint: '#f0b54a' },
};
const FACTION_WEAK: Record<SpeciesId, string> = {
  gardenAnt: 'No special defence against flood or sun',
  fireAnt: 'Workers die quickly when caught alone',
  leafcutter: 'Starves if the fungus garden fails',
  termite: 'Burns in open sun; lost if either royal dies',
};

const DIFFICULTY_TEXT: Record<Difficulty, { label: string; note: string }> = {
  peaceful: { label: 'Peaceful', note: 'No predators, raids or rival attacks. Weather and hunger remain.' },
  easy: { label: 'Gentle', note: 'Fewer and weaker threats. Good for a first colony.' },
  normal: { label: 'Natural', note: 'Scouts, hunters, raids and a fungus season, as intended.' },
  hard: { label: 'Harsh', note: 'Threats arrive sooner and in greater numbers.' },
  brutal: { label: 'Merciless', note: 'The meadow wants you gone.' },
};

export const LOADING_TIPS: readonly string[] = [
  'Foragers that find food lay a scent trail home. The more ants follow it, the stronger it gets.',
  'Possess any ant with F. She keeps her task list and picks it up again when you let go.',
  'Painted dig designations are jobs, not orders — raise the Dig priority to get more workers on them.',
  'Rain washes trails away and floods low galleries. Keep the brood in the upper chambers.',
  'An ant that stumbles in circles is infected. Exile or cull her before she climbs.',
  'Big predators cannot fit into a three-voxel tunnel. The nest is a fortress.',
  'Pheromone vision (P) shows what the colony smells: food trails, alarm, your beacons.',
  'Drop a Gather beacon on a distant food pile to pull foragers to it.',
  'Larvae must be fed to pupate. If they go hungry, raise the Nurse priority.',
  'Dead nestmates are carried to the midden. A tidy nest is a healthy nest.',
  'Cutaway (C) slices the ground open so you can watch the nest at work.',
  'On an ant farm, the keeper decides the weather: food from the lid, the lamp, a tap on the glass.',
  'Termites paint build designations too: mud walls and covered tubes keep the sun off.',
  'Leafcutters cannot eat leaves. The fungus garden turns them into food — keep it tended.',
];

// ---- silhouettes ---------------------------------------------------------------------------

/** Side-profile insect silhouette for a faction card. */
function portraitSvg(id: SpeciesId): string {
  const c = FACTION_TINT[id].body;
  const edge = id === 'gardenAnt' ? 'rgba(233,239,228,.55)' : 'rgba(10,12,10,.7)';
  const leg = id === 'gardenAnt' ? 'rgba(233,239,228,.75)' : c;
  const legs = (pts: string[]): string => pts.map((d) => `<path d="${d}" fill="none" stroke="${leg}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
  if (id === 'termite') {
    // soft, waistless body; straight beaded antennae; big head
    return `<svg viewBox="0 0 180 90" aria-hidden="true">
      ${legs(['M70 52 58 66 50 80', 'M86 54 84 70 80 82', 'M100 53 110 68 118 80'])}
      <path d="M122 30q12-10 24-12M124 34q14-4 26-2" fill="none" stroke="${leg}" stroke-width="2" stroke-linecap="round" stroke-dasharray="1 4"/>
      <ellipse cx="62" cy="48" rx="34" ry="15" fill="${c}" stroke="${edge}" stroke-width="1"/>
      <ellipse cx="98" cy="46" rx="16" ry="11" fill="${c}" stroke="${edge}" stroke-width="1"/>
      <ellipse cx="122" cy="42" rx="15" ry="13" fill="#d9b877" stroke="${edge}" stroke-width="1"/>
      <path d="M134 44l12 3-11 4z" fill="#8a5a2a"/>
      <path d="M40 40v16M52 36v24M64 35v26M76 36v24" stroke="rgba(120,90,40,.35)" stroke-width="1.4"/>
      <circle cx="127" cy="39" r="1.6" fill="#3a2a16"/>
    </svg>`;
  }
  const slim = id === 'fireAnt';
  const big = id === 'leafcutter';
  const headR = big ? 15 : 12;
  return `<svg viewBox="0 0 180 90" aria-hidden="true">
    ${legs(['M82 50 70 62 60 80', 'M92 52 92 66 86 82', 'M100 50 114 62 124 80'])}
    <path d="M${128 + (big ? 4 : 0)} 30q8-14 22-16M${130 + (big ? 4 : 0)} 34q12-8 24-6" fill="none" stroke="${leg}" stroke-width="2" stroke-linecap="round"/>
    <ellipse cx="46" cy="${slim ? 46 : 44}" rx="${slim ? 22 : 26}" ry="${slim ? 13 : 17}" fill="${c}" stroke="${edge}" stroke-width="1" transform="rotate(-8 46 44)"/>
    ${slim ? `<path d="M24 50l-12 8 13-3z" fill="${c}" stroke="${edge}" stroke-width=".8"/>` : ''}
    <ellipse cx="74" cy="48" rx="5" ry="4.500" fill="${c}" stroke="${edge}" stroke-width="1"/>
    <ellipse cx="94" cy="44" rx="${big ? 17 : 15}" ry="${big ? 10 : 9}" fill="${c}" stroke="${edge}" stroke-width="1" transform="rotate(6 94 44)"/>
    ${big ? `<path d="M86 36l-3-9M96 35l1-9M104 37l5-8" stroke="${c}" stroke-width="2" stroke-linecap="round"/>` : ''}
    <circle cx="${122 + (big ? 3 : 0)}" cy="40" r="${headR}" fill="${c}" stroke="${edge}" stroke-width="1"/>
    <path d="M${132 + (big ? 5 : 0)} 46q10 2 12 9M${130 + (big ? 5 : 0)} 49q6 5 6 11" fill="none" stroke="${id === 'gardenAnt' ? leg : c}" stroke-width="2.4" stroke-linecap="round"/>
    <circle cx="${127 + (big ? 3 : 0)}" cy="36" r="2" fill="${id === 'gardenAnt' ? 'rgba(233,239,228,.8)' : '#1a0d08'}"/>
    ${big ? '<path d="M128 22q4-24 30-22-2 22-26 26z" fill="#6fb256" stroke="#3f7a36" stroke-width="1"/><path d="M130 24q10-14 24-20" stroke="#3f7a36" stroke-width="1" fill="none"/>' : ''}
  </svg>`;
}

const TRAIL_PATH = 'M4 30 C 60 4, 110 52, 170 30 S 270 6, 330 28 S 420 50, 492 22';
function trailSvg(animate: boolean): string {
  const ant = (begin: number, scale: number): string => `
    <g class="ms-ant" transform="scale(${scale})">
      <g>
        <path class="ms-ant-legs" d="M-2 0-5 4M0 0 0 4.500M2 0 5 4M-2 0-5-4M0 0 0-4.500M2 0 5-4"/>
        <ellipse cx="-4.200" cy="0" rx="3.200" ry="2.100"/><ellipse cx="0" cy="0" rx="2" ry="1.300"/><circle cx="3.400" cy="0" r="1.700"/>
        ${animate ? `<animateMotion dur="26s" begin="${begin}s" repeatCount="indefinite" rotate="auto"><mpath href="#ms-trail-p"/></animateMotion>` : ''}
      </g>
    </g>`;
  const still = (x: number, y: number, r: number): string => `<g class="ms-ant" transform="translate(${x} ${y}) rotate(${r})"><path class="ms-ant-legs" d="M-2 0-5 4M0 0 0 4.500M2 0 5 4M-2 0-5-4M0 0 0-4.500M2 0 5-4"/><ellipse cx="-4.200" cy="0" rx="3.200" ry="2.100"/><ellipse cx="0" cy="0" rx="2" ry="1.300"/><circle cx="3.400" cy="0" r="1.700"/></g>`;
  return `<svg class="ms-trail" viewBox="0 0 496 60" aria-hidden="true">
    <path id="ms-trail-p" class="ms-trail-glow" d="${TRAIL_PATH}"/>
    <path class="ms-trail-path" d="${TRAIL_PATH}"/>
    ${animate ? [0, -3.1, -7.4, -11, -15.800, -19.300, -23].map((b) => ant(b, 1)).join('') : still(64, 14, -22) + still(170, 30, 12) + still(262, 13, -18) + still(330, 28, 20) + still(430, 38, -8)}
  </svg>`;
}

// ---- menu ------------------------------------------------------------------------------------

export class MenuUi {
  readonly titleEl: HTMLElement;
  readonly newGameEl: HTMLElement;
  readonly loadingEl: HTMLElement;
  private readonly d = new Disposer();
  private readonly thumbs = new ThumbQueue();
  private step: MenuStep = 'title';
  private cfg: NewGameConfig;
  private readonly ngBody = h('div', 'ms-ng-body');
  private readonly ngTitle = h('h2');
  private readonly ngSub = h('p');
  private readonly ngSum = h('span', 'ms-ng-sum');
  private readonly steps = new Map<MenuStep, HTMLElement>();
  private readonly back = h('button', 'mh-btn', { type: 'button', testid: 'ng-back' }, 'Back');
  private readonly next = h('button', 'mh-btn mh-on ms-go', { type: 'button', testid: 'ng-next' }, 'Next');
  private readonly loadWhat = h('div', 'ms-load-what', { testid: 'loading-what' });
  private readonly loadTip = h('div', 'ms-tip', { testid: 'loading-tip' });
  private tipIndex = Math.floor(Math.random() * LOADING_TIPS.length);

  constructor(
    initial: NewGameConfig,
    private readonly cb: MenuCallbacks,
    private readonly audio: AudioLayerB5 | null,
    reducedMotion: boolean,
  ) {
    this.cfg = { ...initial };
    // map goals come from the generators: filled in as the preview worlds are generated
    this.thumbs.onGenerated = (map, _seed, gen) => {
      GOAL_CACHE.set(map, gen.goal.label);
      const el = this.goalEls.get(map);
      if (el) setText(el, gen.goal.label);
    };

    // ---- title ----
    const word = h('span', 'ms-wordmark', { 'aria-label': 'Myrme' });
    for (const ch of 'MYRME') word.append(h('span', undefined, { 'aria-hidden': 'true' }, ch));
    const trail = h('div');
    trail.innerHTML = trailSvg(!reducedMotion);
    const brand = h('div', 'ms-brand', null, [word, trail.firstElementChild as Node]);
    const item = (testid: string, label: string, sub: string, primary: boolean, onClick: () => void): HTMLButtonElement => {
      const b = h('button', `mh-btn ms-main-item${primary ? ' mh-on' : ''}`, { type: 'button', testid }, [h('span', undefined, null, [label, h('small', undefined, null, sub)])]);
      this.d.on(b, 'click', () => {
        this.audio?.ui(primary ? 'confirm' : 'click');
        onClick();
      });
      this.d.on(b, 'pointerenter', () => this.audio?.ui('hover'));
      return b;
    };
    const quickSub = h('small');
    const quick = h('button', 'mh-btn ms-main-item', { type: 'button', testid: 'menu-quick' }, [h('span', undefined, null, ['Quick start', quickSub])]);
    this.d.on(quick, 'click', () => {
      this.audio?.ui('confirm');
      this.cb.onStart({ ...this.cfg, seed: randomSeed() });
    });
    this.d.on(quick, 'pointerenter', () => this.audio?.ui('hover'));
    this.quickSub = quickSub;
    this.titleEl = h('div', 'ms-layer ms-title', { testid: 'menu' }, [
      brand,
      h('div', 'ms-tagline', null, ['A colony at ', h('b', undefined, null, 'ant scale')]),
      h('div', 'ms-main-list', null, [
        item('menu-new', 'New colony', 'Choose a habitat and a species', true, () => this.go('map')),
        quick,
        item('menu-settings', 'Settings', 'Graphics, sound, controls', false, () => this.cb.onSettings()),
      ]),
      h('div', 'ms-footnote', null, 'Everything you see and hear is generated in your browser.'),
    ]);

    // ---- new game ----
    const stepChip = (id: MenuStep, n: number, label: string): HTMLElement => {
      const el = h('button', 'ms-step', { type: 'button', testid: `ng-step-${id}` }, [h('i', undefined, null, String(n)), label]);
      this.d.on(el, 'click', () => this.go(id));
      this.steps.set(id, el);
      return el;
    };
    this.d.on(this.back, 'click', () => {
      this.audio?.ui('back');
      this.goBack();
    });
    this.d.on(this.next, 'click', () => {
      this.audio?.ui('confirm');
      this.goNext();
    });
    this.newGameEl = h('div', 'ms-layer ms-newgame', { testid: 'newgame' }, [
      h('div', 'ms-ng', null, [
        h('div', 'ms-ng-head', null, [this.ngTitle, this.ngSub, h('div', 'ms-steps', null, [stepChip('map', 1, 'Habitat'), stepChip('faction', 2, 'Species'), stepChip('setup', 3, 'Colony')])]),
        this.ngBody,
        h('div', 'ms-ng-foot', null, [this.back, this.ngSum, this.next]),
      ]),
    ]);

    // ---- loading ----
    this.loadingEl = h('div', 'ms-layer ms-loading', { testid: 'loading', role: 'status', 'aria-live': 'polite' }, [
      h('span', 'ms-wordmark', null, 'MYRME'),
      this.loadWhat,
      h('div', 'ms-march', null, [h('i')]),
      this.loadTip,
    ]);
    this.refreshQuick();
  }

  private readonly quickSub: HTMLElement;
  private readonly goalEls = new Map<MapId, HTMLElement>();

  get config(): NewGameConfig {
    return { ...this.cfg };
  }
  get currentStep(): MenuStep {
    return this.step;
  }

  private refreshQuick(): void {
    setText(this.quickSub, `${getMap(this.cfg.map).name} · ${SPECIES[this.cfg.faction].name}`);
  }

  setLoading(what: string, detail: string, tip?: number): void {
    this.loadWhat.replaceChildren(what, ' ', h('b', undefined, null, detail));
    if (tip !== undefined) this.tipIndex = ((tip % LOADING_TIPS.length) + LOADING_TIPS.length) % LOADING_TIPS.length;
    else this.tipIndex = (this.tipIndex + 1 + Math.floor(Math.random() * (LOADING_TIPS.length - 1))) % LOADING_TIPS.length;
    this.loadTip.replaceChildren(h('b', undefined, null, 'Field note'), LOADING_TIPS[this.tipIndex]);
  }

  /** Esc / Back. Returns false when already on the title (nothing to go back to). */
  goBack(): boolean {
    if (this.step === 'title') return false;
    this.go(this.step === 'setup' ? 'faction' : this.step === 'faction' ? 'map' : 'title');
    return true;
  }

  goNext(): void {
    if (this.step === 'map') this.go('faction');
    else if (this.step === 'faction') this.go('setup');
    else if (this.step === 'setup') this.cb.onStart(this.config);
  }

  go(step: MenuStep): void {
    this.step = step;
    this.cb.onStep(step);
    if (step === 'title') {
      this.refreshQuick();
      return;
    }
    for (const [id, el] of this.steps) {
      const order = ['map', 'faction', 'setup'];
      setClass(el, 'ms-cur', id === step);
      setClass(el, 'ms-past', order.indexOf(id) < order.indexOf(step));
    }
    setText(this.next, step === 'setup' ? 'Found the colony' : 'Next');
    this.next.dataset.testid = step === 'setup' ? 'ng-start' : 'ng-next';
    if (step === 'map') this.renderMaps();
    else if (step === 'faction') this.renderFactions();
    else this.renderSetup();
    this.renderSummary();
    this.ngBody.scrollTop = 0;
  }

  private renderSummary(): void {
    const c = this.cfg;
    this.ngSum.replaceChildren(h('b', undefined, null, getMap(c.map).name), ' · ', h('b', undefined, null, SPECIES[c.faction].name), this.step === 'setup' ? ` · ${DIFFICULTY_TEXT[c.difficulty].label}${c.mode === 'sandbox' ? ' · Sandbox' : ''}` : '');
  }

  // ---- step 1: habitat ----
  private renderMaps(): void {
    setText(this.ngTitle, 'Choose a habitat');
    setText(this.ngSub, 'Three outdoor worlds and three ant farms. Every seed grows a different one.');
    const cards: HTMLElement[] = [];
    for (const m of MAPS) {
      const canvas = h('canvas', 'ms-thumb', { width: 376, height: 126, 'aria-hidden': 'true' });
      const goalText = h('span', undefined, null, GOAL_CACHE.get(m.id) ?? '');
      this.goalEls.set(m.id, goalText);
      const card = h('button', 'ms-card', { type: 'button', testid: `map-${m.id}`, 'aria-pressed': String(m.id === this.cfg.map) }, [
        canvas,
        h('div', 'ms-card-body', null, [
          h('div', 'ms-card-title', null, [m.name, h('span', `ms-tag${m.kind === 'outdoor' ? ' ms-tag-out' : ''}`, null, m.kind === 'outdoor' ? 'Outdoor' : 'Ant farm')]),
          h('div', 'ms-card-desc', null, m.description),
          h('div', 'ms-card-goal', null, [icon('goal'), goalText]),
        ]),
      ]);
      setClass(card, 'ms-sel', m.id === this.cfg.map);
      this.d.on(card, 'click', () => {
        this.audio?.ui('click');
        this.cfg.map = m.id;
        for (const c of cards) {
          const on = c === card;
          setClass(c, 'ms-sel', on);
          c.setAttribute('aria-pressed', String(on));
        }
        this.renderSummary();
      });
      this.d.on(card, 'dblclick', () => this.goNext());
      this.d.on(card, 'pointerenter', () => this.audio?.ui('hover'));
      this.thumbs.request(m.id, 1, 'gardenAnt', canvas);
      cards.push(card);
    }
    this.ngBody.replaceChildren(h('div', 'ms-cards ms-cards-map', null, cards));
  }

  // ---- step 2: species ----
  private renderFactions(): void {
    setText(this.ngTitle, 'Choose a species');
    setText(this.ngSub, 'Each plays by its own rules.');
    const all = Object.values(SPECIES) as SpeciesDef[];
    const military = (s: SpeciesDef): CasteDef | undefined => s.castes.soldier ?? s.castes.major ?? s.castes.nasute ?? s.castes.worker;
    const max = {
      speed: Math.max(...all.map((s) => s.castes.worker?.speed ?? 0)),
      health: Math.max(...all.map((s) => s.castes.worker?.maxHealth ?? 0)),
      attack: Math.max(...all.map((s) => military(s)?.attack ?? 0)),
      carry: Math.max(...all.map((s) => s.castes.worker?.carryCapacity ?? 0)),
    };
    const bar = (label: string, v: number, m: number): Node[] => {
      const fill = h('i');
      fill.style.transform = `scaleX(${m > 0 ? Math.max(0.06, Math.min(1, v / m)).toFixed(3) : 0})`;
      return [h('span', undefined, null, label), h('span', 'mh-bar', null, [fill])];
    };
    const cards: HTMLElement[] = [];
    for (const info of FACTION_INFO) {
      const s = SPECIES[info.id];
      const portrait = h('div', 'ms-portrait');
      portrait.innerHTML = portraitSvg(info.id);
      const card = h('button', 'ms-card', { type: 'button', testid: `faction-${info.id}`, 'aria-pressed': String(info.id === this.cfg.faction) }, [
        portrait,
        h('div', 'ms-card-body', null, [
          h('div', 'ms-card-title', null, [info.name, h('span', `ms-tag ms-tag-${info.difficulty}`, null, info.difficulty)]),
          h('div', 'ms-twist', null, info.tagline),
          h('ul', 'ms-traits', null, [...info.traits.map((t) => h('li', undefined, null, t)), h('li', 'ms-weak', null, FACTION_WEAK[info.id])]),
          h('div', 'ms-statbars', null, [
            ...bar('Speed', s.castes.worker?.speed ?? 0, max.speed),
            ...bar('Toughness', s.castes.worker?.maxHealth ?? 0, max.health),
            ...bar('Bite', military(s)?.attack ?? 0, max.attack),
            ...bar('Carry', s.castes.worker?.carryCapacity ?? 0, max.carry),
          ]),
        ]),
      ]);
      card.style.setProperty('--tint', FACTION_TINT[info.id].tint);
      setClass(card, 'ms-sel', info.id === this.cfg.faction);
      this.d.on(card, 'click', () => {
        this.audio?.ui('click');
        this.cfg.faction = info.id;
        for (const c of cards) {
          const on = c === card;
          setClass(c, 'ms-sel', on);
          c.setAttribute('aria-pressed', String(on));
        }
        this.renderSummary();
      });
      this.d.on(card, 'dblclick', () => this.goNext());
      this.d.on(card, 'pointerenter', () => this.audio?.ui('hover'));
      cards.push(card);
    }
    this.ngBody.replaceChildren(h('div', 'ms-cards ms-cards-faction', null, cards));
  }

  // ---- step 3: colony ----
  private renderSetup(): void {
    setText(this.ngTitle, 'Found the colony');
    setText(this.ngSub, 'A queen, a handful of workers and one small chamber.');
    const c = this.cfg;
    const map = getMap(c.map);

    const seg = <T extends string>(prefix: string, options: readonly { id: T; label: string }[], value: T, onPick: (v: T) => void): HTMLElement => {
      const el = h('div', 'ms-seg', { role: 'radiogroup' });
      const btns: HTMLButtonElement[] = [];
      for (const o of options) {
        const b = h('button', `mh-btn${o.id === value ? ' mh-on' : ''}`, { type: 'button', role: 'radio', testid: `${prefix}-${o.id}`, 'aria-checked': String(o.id === value) }, o.label);
        this.d.on(b, 'click', () => {
          this.audio?.ui('click');
          for (const x of btns) {
            setClass(x, 'mh-on', x === b);
            x.setAttribute('aria-checked', String(x === b));
          }
          onPick(o.id);
          b.blur();
        });
        btns.push(b);
        el.append(b);
      }
      return el;
    };
    const row = (label: string, ...controls: Node[]): HTMLElement => h('div', 'ms-set-row', null, [h('div', 'ms-set-label', null, [h('span', undefined, null, label)]), h('div', 'ms-set-control', null, controls)]);

    // seed
    const seed = h('input', undefined, { type: 'text', inputmode: 'numeric', maxlength: 10, value: String(c.seed), testid: 'ng-seed', 'aria-label': 'Seed', spellcheck: 'false' });
    const thumb = h('canvas', 'ms-thumb', { width: 376, height: 126, 'aria-hidden': 'true' });
    let seedTimer: ReturnType<typeof setTimeout> | null = null;
    const applySeed = (): void => {
      c.seed = parseSeed(seed.value);
      if (seedTimer) clearTimeout(seedTimer);
      seedTimer = setTimeout(() => this.thumbs.request(c.map, c.seed, c.faction, thumb), 250);
    };
    this.d.on(seed, 'input', applySeed);
    this.d.on(seed, 'keydown', (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        seed.blur();
        this.goNext();
      }
    });
    this.d.on(seed, 'blur', () => {
      seed.value = String(c.seed);
    });
    const dice = h('button', 'mh-btn', { type: 'button', testid: 'ng-seed-random', 'aria-label': 'Random seed' }, 'Random');
    this.d.on(dice, 'click', () => {
      this.audio?.ui('toggle');
      c.seed = randomSeed();
      seed.value = String(c.seed);
      this.thumbs.request(c.map, c.seed, c.faction, thumb);
      dice.blur();
    });

    const diffNote = h('small', 'ms-set-note', { testid: 'ng-difficulty-note' });
    const paintDiff = (): void => setText(diffNote, `${DIFFICULTY_TEXT[c.difficulty].note}${c.difficulty === 'peaceful' ? '' : ` Threat ×${DIFFICULTY_INTENSITY[c.difficulty]}.`}`);
    paintDiff();
    const goalLabel = mapGoalLabel(c.map);
    const modeNote = h('small', 'ms-set-note', { testid: 'ng-mode-note' });
    const sumGoal = h('span', undefined, { testid: 'ng-sum-goal' });
    const paintMode = (): void => {
      setText(modeNote, c.mode === 'goal' ? goalLabel || 'Play towards the map goal.' : 'No goal and no victory screen. The colony can still be lost.');
      setText(sumGoal, c.mode === 'goal' ? goalLabel || 'Map goal' : 'None — sandbox');
      this.renderSummary();
    };
    const sumDiff = h('span');
    const sumSize = h('span');
    const paintSum = (): void => {
      setText(sumDiff, DIFFICULTY_TEXT[c.difficulty].label);
      setText(sumSize, c.size === 'small' ? 'Small' : 'Standard');
    };
    paintSum();
    paintMode();

    const form = h('div', 'mh-panel ms-form', null, [
      row('Seed', h('div', 'ms-seed', null, [seed, dice]), h('small', 'ms-set-note', null, 'Same seed, same world.')),
      row(
        'World size',
        seg<MapSize>('ng-size', [{ id: 'small', label: 'Small' }, { id: 'standard', label: 'Standard' }], c.size, (v) => {
          c.size = v;
          paintSum();
        }),
        h('small', 'ms-set-note', null, 'Small worlds load faster and keep everything close.'),
      ),
      row(
        'Threats',
        seg<Difficulty>('ng-difficulty', DIFFICULTIES.map((id) => ({ id, label: DIFFICULTY_TEXT[id].label })), c.difficulty, (v) => {
          c.difficulty = v;
          paintDiff();
          paintSum();
          this.renderSummary();
        }),
        diffNote,
      ),
      row(
        'Mode',
        seg<GameMode>('ng-mode', [{ id: 'goal', label: 'Goal' }, { id: 'sandbox', label: 'Sandbox' }], c.mode, (v) => {
          c.mode = v;
          paintMode();
        }),
        modeNote,
      ),
    ]);

    this.thumbs.request(c.map, c.seed, c.faction, thumb);
    const info = FACTION_INFO.find((f) => f.id === c.faction);
    const sumRow = (label: string, value: Node | string): HTMLElement => h('div', 'ms-sum-row', null, [h('span', undefined, null, label), typeof value === 'string' ? h('span', undefined, null, value) : value]);
    const summary = h('div', 'mh-panel ms-summary', { testid: 'ng-summary' }, [
      thumb,
      h('div', 'ms-card-body', null, [
        h('div', 'ms-card-title', null, [map.name, h('span', `ms-tag${map.kind === 'outdoor' ? ' ms-tag-out' : ''}`, null, map.kind === 'outdoor' ? 'Outdoor' : 'Ant farm')]),
        sumRow('Species', `${SPECIES[c.faction].name}${info ? ` — ${info.tagline}` : ''}`),
        sumRow('Goal', sumGoal),
        sumRow('Threats', sumDiff),
        sumRow('World', sumSize),
      ]),
    ]);
    this.ngBody.replaceChildren(h('div', 'ms-setup', null, [form, summary]));
  }

  dispose(): void {
    this.d.dispose();
    this.thumbs.dispose();
    this.titleEl.remove();
    this.newGameEl.remove();
    this.loadingEl.remove();
  }
}

export function randomSeed(): number {
  return 1 + Math.floor(Math.random() * 999_999);
}

/** Digits are used as-is; any other text is hashed, so a word can be a seed. */
export function parseSeed(text: string): number {
  const t = text.trim();
  if (/^\d{1,9}$/.test(t)) return Math.max(1, Number(t));
  if (!t) return 1;
  let hsh = 2166136261;
  for (let i = 0; i < t.length; i++) {
    hsh ^= t.charCodeAt(i);
    hsh = Math.imul(hsh, 16777619);
  }
  return 1 + ((hsh >>> 0) % 999_999);
}
