/**
 * Onboarding (B5 item 5): the six contextual hints of PLAN §2 as unobtrusive coach marks — each
 * completed by doing the thing — plus one-time tips for later events (first rain, predator,
 * infection, flood, night…). Progress lives in the settings store (localStorage, try/catch there).
 *
 * The step logic is the pure `TutorialMachine`; this file observes the game (view state, input
 * actions, sim events) and renders the card + a highlight ring on the relevant HUD element.
 */
import { THREAT_ROLES, type AnySimEvent, type FrameInfo } from '../core';
import type { ActionId } from '../input/keybinds';
import { getCreature } from '../sim/data/creatures';
import { h, setClass, setShown, setStyle, setText } from './dom';
import type { Feature, FeatureContext } from './features';
import { TUTORIAL_STEPS, TipQueue, TutorialMachine, type TipId, type TutorialSignal, type TutorialSnapshot, type TutorialStepId } from './tutorialMachine';

type Part = string | { key: ActionId | string; raw?: boolean };
const k = (key: ActionId): Part => ({ key });
const raw = (key: string): Part => ({ key, raw: true });

interface StepText {
  title: string;
  /** Body per sub-progress index (a two-part step swaps its text half-way). */
  body: Part[][];
  /** `data-testid` of the HUD element to ring (optional). */
  target?: string;
}

const STEP_TEXT: Record<TutorialStepId, StepText> = {
  camera: {
    title: 'Look around',
    body: [['Pan with ', k('cam.forward'), k('cam.left'), k('cam.back'), k('cam.right'), ', zoom with the ', raw('Wheel'), ' and orbit by dragging the ', raw('Right mouse'), ' button.']],
  },
  select: {
    title: 'Pick some ants',
    body: [['Click an ant, or drag a box around a few. ', raw('Double-click'), ' takes every ant of that caste on screen.']],
  },
  order: {
    title: 'Send them out',
    body: [[raw('Right-click'), ' the ground to move your selection — or a food source, and they will gather from it.']],
    target: 'selection-panel',
  },
  dig: {
    title: 'Plan a tunnel',
    body: [['Take the dig brush ', k('tool.dig'), ' and paint on soil. Workers excavate what you mark.']],
    target: 'tool-dig',
  },
  possess: {
    title: 'Become an ant',
    body: [
      ['Select one ant and press ', k('possess.toggle'), ' to crawl as her.'],
      ['You are the ant. ', k('p.view'), ' swaps first and third person. Press ', k('possess.toggle'), ' again to let go — she goes back to her tasks.'],
    ],
  },
  colony: {
    title: 'Run the colony',
    body: [['Open the colony panel with ', k('ui.colony'), ': population, jobs and what the colony should favour.']],
    target: 'quick-panel',
  },
};

interface TipText {
  title: string;
  body: string;
  /** Field-guide entry to offer. */
  codex?: string;
}

const TIP_TEXT: Record<TipId, TipText> = {
  rain: { title: 'Rain', body: 'Drops hit like boulders at this scale. Trails wash out and low galleries flood — brood is safest in the upper chambers.', codex: 'weather.rain' },
  predator: { title: 'A predator', body: 'Big hunters cannot follow into narrow tunnels. Send soldiers together, or possess one and lead the charge.', codex: 'creatures' },
  infection: { title: 'Something is wrong with her', body: 'An ant walking in erratic circles carries the zombie fungus. Exile or cull her before she climbs and bursts into spores.', codex: 'fungus.zombie' },
  flood: { title: 'Water in the nest', body: 'Flooded tunnels drown workers and brood. Dig chambers higher, and keep the entrance off low ground.', codex: 'weather.flood' },
  night: { title: 'Nightfall', body: 'Cold slows everyone down. Most foragers come home; some hunters prefer the dark.', codex: 'weather.night' },
  starving: { title: 'The stores are empty', body: 'Raise the Forage priority, drop a Gather beacon on food, or carry some home yourself.', codex: 'colony.food' },
  raid: { title: 'Under attack', body: 'Alarm pheromone pulls nearby workers in. An Attack beacon focuses your soldiers; guard the queen first.', codex: 'pheromones' },
};

export interface TutorialFeature extends Feature {
  /** Debug / settings hooks. */
  control(op: 'reset' | 'skip' | 'state' | number): TutorialSnapshot;
  offerTip(id: TipId): void;
}

export function createTutorial(ctx: FeatureContext, opts: { enabled: boolean; isColonyOpen(): boolean }): TutorialFeature {
  const { app, hud, settings } = ctx;
  const saved = settings.value.tutorial;
  const machine = new TutorialMachine(opts.enabled ? saved : { done: TUTORIAL_STEPS.map((s) => s.id), skipped: true });
  const tips = new TipQueue(saved.tips);
  let enabled = opts.enabled;
  const hintsOn = (): boolean => enabled && settings.value.ui.hints;

  // ---- DOM ---------------------------------------------------------------------------------
  const kicker = h('span', 'ms-coach-kicker');
  const dots = h('span', 'ms-coach-dots');
  const title = h('div', 'ms-coach-title', { testid: 'tutorial-title' });
  const body = h('div', 'ms-coach-body');
  const skip = h('button', 'ms-coach-link', { type: 'button', testid: 'tutorial-skip' }, 'Skip tutorial');
  const ok = h('button', 'mh-btn', { type: 'button', testid: 'tip-ok' }, 'Got it');
  const more = h('button', 'ms-coach-link', { type: 'button', testid: 'tip-more' }, 'Field guide');
  const foot = h('div', 'ms-coach-foot', null, [skip, more, h('span', 'mh-grow'), ok]);
  const card = h('div', 'mh-panel ms-coach mh-hidden', { testid: 'tutorial', role: 'status', 'aria-live': 'polite' }, [h('div', 'ms-coach-head', null, [kicker, dots]), title, body, foot]);
  const ring = h('div', 'ms-coach-ring mh-hidden', { testid: 'tutorial-ring' });
  hud.slot('overlay').append(ring, card);

  ctx.d.on(skip, 'click', () => {
    machine.skip();
    persist();
    ctx.audio?.ui('back');
    hud.toast('Tutorial skipped — replay it any time from Settings › Interface', { ttl: 8 });
    render(true);
  });
  ctx.d.on(ok, 'click', () => {
    tips.dismiss();
    ctx.audio?.ui('click');
    render(true);
  });
  ctx.d.on(more, 'click', () => {
    const tip = tips.current;
    tips.dismiss();
    if (tip) ctx.shell.openCodex(TIP_TEXT[tip].codex);
    render(true);
  });

  const persist = (): void => {
    if (!enabled) return;
    settings.patch('tutorial', { ...machine.save(), tips: tips.seenList() });
  };

  function parts(list: Part[]): Node[] {
    return list.map((p) => {
      if (typeof p === 'string') return document.createTextNode(p);
      const text = p.raw ? p.key : ctx.hint(p.key as ActionId) || '?';
      return h('span', 'mh-kbd', null, text);
    });
  }

  let shownKey = '';
  let flashUntil = 0;
  let keysSeen = '';

  function render(force = false): void {
    const now = performance.now();
    const tip = hintsOn() ? tips.next() : null;
    const snap = machine.snapshot();
    const showStep = hintsOn() && snap.active && !tip;
    const flashing = now < flashUntil && !tip;
    const key = tip ? `tip:${tip}` : flashing ? 'flash' : showStep ? `step:${snap.step}:${snap.progress}:${keysSeen}` : 'none';
    setShown(card, key !== 'none');
    if (key === 'none') setShown(ring, false);
    if (key === shownKey && !force) return;
    shownKey = key;
    setClass(card, 'ms-coach-tip', !!tip);
    setClass(card, 'ms-coach-done', flashing);
    setShown(skip, showStep && !flashing);
    setShown(ok, !!tip);
    setShown(more, !!tip && !!TIP_TEXT[tip].codex);
    setShown(dots, !tip);
    setShown(foot, !flashing);
    if (tip) {
      const t = TIP_TEXT[tip];
      setText(kicker, 'Tip');
      setText(title, t.title);
      body.replaceChildren(t.body);
    } else if (flashing) {
      setText(kicker, 'Tutorial');
      setText(title, snap.finished ? 'That is everything' : 'Done');
      body.replaceChildren(snap.finished ? 'The colony is yours. The field guide in the toolbar has the rest.' : 'Nicely done.');
    } else if (showStep && snap.step) {
      const t = STEP_TEXT[snap.step];
      setText(kicker, `Tutorial · ${snap.index + 1} of ${TUTORIAL_STEPS.length}`);
      setText(title, t.title);
      body.replaceChildren(...parts(t.body[Math.min(snap.progress, t.body.length - 1)]));
    }
    if (!tip) {
      dots.replaceChildren(
        ...TUTORIAL_STEPS.map((s, i) => h('i', snap.done.includes(s.id) ? 'ms-on' : i === snap.index && !flashing ? 'ms-cur' : undefined)),
      );
    }
  }

  function placeRing(): void {
    const snap = machine.snapshot();
    const target = hintsOn() && snap.active && !tips.current && performance.now() >= flashUntil && snap.step ? STEP_TEXT[snap.step].target : undefined;
    const el = target ? hud.root.querySelector<HTMLElement>(`[data-testid="${target}"]`) : null;
    const r = el && el.offsetParent !== null ? el.getBoundingClientRect() : null;
    setShown(ring, !!r && r.width > 0);
    if (!r || r.width <= 0) return;
    const pad = 4;
    setStyle(ring, 'transform', `translate(${Math.round(r.left - pad)}px,${Math.round(r.top - pad)}px)`);
    setStyle(ring, 'width', `${Math.round(r.width + pad * 2)}px`);
    setStyle(ring, 'height', `${Math.round(r.height + pad * 2)}px`);
  }

  // ---- observation ---------------------------------------------------------------------------
  function feed(signal: TutorialSignal): void {
    if (!machine.active) return;
    const res = machine.feed(signal);
    if (res.completed.length) {
      flashUntil = performance.now() + (res.finished ? 3600 : 1100);
      ctx.audio?.ui('confirm');
      persist();
      if (res.finished) hud.toast('Tutorial complete', { severity: 'good', ttl: 6 });
    }
    if (res.completed.length || res.progressed) render(true);
  }

  // camera baseline (re-taken whenever the camera step becomes current)
  let camBase: { x: number; y: number; z: number; fx: number; fy: number; fz: number } | null = null;
  let camBaseAt = 0;
  function watchCamera(now: number): void {
    if (machine.current?.id !== 'camera') {
      camBase = null;
      return;
    }
    const c = app.view.camera;
    if (!camBase) {
      camBase = { x: c.pos.x, y: c.pos.y, z: c.pos.z, fx: c.forward.x, fy: c.forward.y, fz: c.forward.z };
      camBaseAt = now;
      return;
    }
    // the opening camera settle is not the player
    if (now - camBaseAt < 700) {
      camBase = { x: c.pos.x, y: c.pos.y, z: c.pos.z, fx: c.forward.x, fy: c.forward.y, fz: c.forward.z };
      return;
    }
    const moved = Math.hypot(c.pos.x - camBase.x, c.pos.y - camBase.y, c.pos.z - camBase.z);
    const turned = 1 - (c.forward.x * camBase.fx + c.forward.y * camBase.fy + c.forward.z * camBase.fz);
    if (moved > Math.max(2.5, c.focusDist * 0.12) || turned > 0.012) feed('cameraMoved');
  }

  let subscribed = false;
  function subscribe(): void {
    if (subscribed) return;
    const api = ctx.input();
    if (!api) return;
    subscribed = true;
    ctx.d.add(
      api.onAction((a) => {
        if (a === 'ui.colony') feed('colonyOpened');
      }),
    );
  }

  let sawDay = false;
  let savedTipCount = saved.tips.length;
  function watchTips(events: readonly AnySimEvent[]): void {
    const pc = app.sim.playerColony;
    for (const e of events) {
      switch (e.type) {
        case 'weatherChanged':
          if (e.to === 'rain' || e.to === 'storm') tips.offer('rain');
          break;
        case 'flood':
          if (e.rising) tips.offer('flood');
          break;
        case 'creatureSpawned':
          // only when it turns up near the nest — the map's far-off resident hunters (antlion pits,
          // a spider across the meadow) must not pre-empt the opening tutorial; `predatorNear`
          // alerts cover the ones that wander in later
          if (THREAT_ROLES[getCreature(e.def)?.role ?? ''] && app.sim.tick > 30) {
            const nest = app.sim.getColony(pc)?.nestPos;
            if (nest && Math.hypot(e.pos.x - nest.x, e.pos.y - nest.y, e.pos.z - nest.z) < 28) tips.offer('predator');
          }
          break;
        case 'infectionStage':
          if (e.stage === 'erratic' || e.stage === 'summit') {
            const a = app.sim.getAnt(e.id);
            if (!a || a.colony === pc) tips.offer('infection');
          }
          break;
        case 'alert':
          if (e.colony !== pc && e.colony !== 0) break;
          if (e.code === 'predatorNear') tips.offer('predator');
          else if (e.code === 'infectionSpotted') tips.offer('infection');
          else if (e.code === 'flooding') tips.offer('flood');
          else if (e.code === 'starving') tips.offer('starving');
          else if (e.code === 'raidIncoming' || e.code === 'underAttack') tips.offer('raid');
          break;
        default:
          break;
      }
    }
  }

  // settings: "Replay the tutorial" clears the stored progress; hints toggle hides the card
  ctx.d.add(
    settings.subscribe((s, changed) => {
      if (changed === 'tutorial' && enabled && s.tutorial.done.length === 0 && !s.tutorial.skipped && !machine.active) {
        machine.reset();
        flashUntil = 0;
      }
      if (changed === 'keys') keysSeen = JSON.stringify(s.keys);
      if (changed === 'tutorial' || changed === 'ui' || changed === 'keys' || changed === 'all') render(true);
    }),
  );

  render(true);

  return {
    frame(frame: FrameInfo) {
      if (!enabled || !frame.events.length) return;
      const events = frame.events as readonly AnySimEvent[];
      if (machine.active) {
        for (const e of events) {
          if (e.type === 'orderIssued') {
            if (e.order !== 'stop') feed('ordered');
          } else if (e.type === 'designationChanged') {
            if (e.op === 'add' && e.designation.kind === 'dig') feed('digPainted');
          } else if (e.type === 'possession') {
            if (e.op === 'start') feed('possessed');
            else feed('released');
          }
        }
      }
      watchTips(events);
    },
    update(now) {
      if (!enabled) return;
      subscribe();
      if (machine.active) {
        watchCamera(now);
        if (app.view.selection.length > 0) feed('selected');
        if (opts.isColonyOpen()) feed('colonyOpened');
      }
      // ambient tips
      const w = app.sim.weather;
      if (w.kind === 'rain' || w.kind === 'storm') tips.offer('rain');
      if (app.sim.map.flags.dayNight) {
        const tod = ((w.timeOfDay % 1) + 1) % 1;
        if (tod > 0.3 && tod < 0.7) sawDay = true;
        else if (sawDay && (tod > 0.8 || tod < 0.18)) tips.offer('night');
      }
      render();
      placeRing();
      // remember newly offered tips
      const seen = tips.seenList().length;
      if (seen !== savedTipCount) {
        savedTipCount = seen;
        persist();
      }
    },
    control(op) {
      if (op === 'reset') {
        enabled = true;
        machine.reset();
        flashUntil = 0;
        persist();
      } else if (op === 'skip') {
        machine.skip();
        persist();
      } else if (typeof op === 'number') {
        enabled = true;
        machine.goto(op);
        flashUntil = 0;
      }
      render(true);
      placeRing();
      return machine.snapshot();
    },
    offerTip(id) {
      enabled = true;
      tips.offer(id);
      render(true);
    },
    dispose() {
      card.remove();
      ring.remove();
    },
  };
}
