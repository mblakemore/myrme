/**
 * Goal tracker view-model (pure — no DOM). Turns the sim's goal state (`sim.goal`, B3's
 * `b3StateOf(sim).goals` / `.nuptial`, the latest `goalProgress` event) into what the tracker
 * card shows: a title, status, progress bars and a sub-objective checklist per goal kind.
 * Works with all-zero B3 state (stub systems).
 */
import { b3StateOf, type GoalKind, type GoalState, type GoalsState, type NuptialState, type SimView, type Tick } from '../core';

export interface GoalBar {
  id: string;
  label: string;
  value: number;
  target: number;
  /** Caption, e.g. `42 / 150`. */
  text: string;
}

export interface SubObjective {
  id: string;
  label: string;
  done: boolean;
  /** 0..1 when the step has measurable progress. */
  progress?: number;
  hint: string;
}

export type GoalViewStatus = 'active' | 'succession' | 'won' | 'lost' | 'continued' | 'sandbox';

export interface GoalView {
  kind: GoalKind;
  title: string;
  status: GoalViewStatus;
  /** Short status caption ('' while simply active). */
  statusText: string;
  bars: GoalBar[];
  subObjectives: SubObjective[];
  note: string;
}

export interface GoalInputs {
  goal: Readonly<GoalState>;
  goals: Readonly<GoalsState>;
  nuptial: Readonly<NuptialState> | null;
  /** Player colony adult population. */
  population: number;
  /** 0-based sim day. */
  day: number;
  tick: Tick;
  /** Latest `goalProgress` event for this goal, if newer than `goal.progress`. */
  event: { progress: number; target: number } | null;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const int = (v: number): string => String(Math.round(Number.isFinite(v) ? v : 0));
const pct = (v: number): string => (Number.isInteger(v) ? `${v}%` : `${v.toFixed(1)}%`);

/** Collect the inputs from a live sim (the only impure-ish part: it just reads). */
export function goalInputs(sim: SimView, event: GoalInputs['event'] = null): GoalInputs {
  const b3 = b3StateOf(sim);
  const colony = sim.getColony(sim.playerColony);
  let population = colony?.population.total ?? 0;
  if (!population) for (const a of sim.ants) if (a.alive && a.colony === sim.playerColony) population++;
  return {
    goal: sim.goal,
    goals: b3.goals,
    nuptial: b3.nuptial.find((n) => n.colony === sim.playerColony) ?? null,
    population,
    day: Math.floor(sim.weather?.day ?? 0),
    tick: sim.tick,
    event,
  };
}

const HOLD_TEXT: Record<string, string> = { cold: 'too cold', night: 'waiting for daylight', rain: 'waiting for the rain to stop' };

export function buildGoalView(inp: GoalInputs): GoalView {
  const { goal, goals, nuptial, population } = inp;
  const def = goal.def;
  const kind = def.kind;
  const target = inp.event && inp.event.target > 0 ? inp.event.target : def.target;
  const progress = inp.event ? inp.event.progress : goal.progress;

  let status: GoalViewStatus = 'active';
  let statusText = '';
  if (goal.status === 'won' || goals.phase === 'won') {
    status = 'won';
    statusText = 'Complete';
  } else if (goal.status === 'lost' || goals.phase === 'lost') {
    status = 'lost';
    statusText = 'Failed';
  } else if (goals.phase === 'continued') {
    status = 'continued';
    statusText = 'Complete — playing on';
  } else if (goals.phase === 'succession') {
    status = 'succession';
    const s = Math.max(0, Math.ceil((goals.graceUntil - inp.tick) / 30));
    statusText = s > 0 ? `Queen lost — ${s}s to raise an heir` : 'Queen lost — raise an heir';
  }

  const view: GoalView = { kind, title: def.label || 'Sandbox', status, statusText, bars: [], subObjectives: [], note: '' };
  const finished = status === 'won' || status === 'continued';

  switch (kind) {
    case 'sandbox': {
      if (status === 'active') view.status = 'sandbox';
      view.title = 'Sandbox';
      view.note = `Day ${inp.day + 1} · ${int(population)} ants`;
      break;
    }
    case 'population': {
      const v = progress > 0 ? progress : population;
      view.bars.push({ id: 'population', label: 'Population', value: v, target, text: `${int(v)} / ${int(target)}` });
      view.subObjectives.push(
        { id: 'grow', label: `Grow the colony to ${int(target)} ants`, done: finished || v >= target, progress: clamp01(v / Math.max(1, target)), hint: 'More food and more nurses mean more brood reaching adulthood.' },
        { id: 'queen', label: 'Keep the queen alive', done: finished, hint: 'The colony falls when the queen dies with no heir in the brood.' },
      );
      break;
    }
    case 'nuptialFlight': {
      const popNow = progress > 0 ? progress : population;
      const popV = Math.max(popNow, nuptial && nuptial.phase !== 'none' ? target : 0, finished ? target : 0);
      const popDone = finished || popV >= target || (!!nuptial && nuptial.phase !== 'none');
      const wanted = nuptial?.wanted ?? 0;
      const alates = (nuptial?.alates ?? 0) + (nuptial?.launched ?? 0);
      const phase = nuptial?.phase ?? 'none';
      const reared = finished || (wanted > 0 && alates >= wanted) || phase === 'gather' || phase === 'takeoff' || phase === 'done';
      const gathered = finished || phase === 'takeoff' || phase === 'done';
      const flown = finished || phase === 'done';
      if (!popDone) view.bars.push({ id: 'population', label: 'Population', value: popNow, target, text: `${int(popNow)} / ${int(target)}` });
      else if (!reared) view.bars.push({ id: 'alates', label: 'Alates reared', value: alates, target: Math.max(1, wanted), text: wanted > 0 ? `${int(alates)} / ${int(wanted)}` : 'Rearing…' });
      else {
        // the party that actually assembled can be smaller than `wanted` (stalled brood, losses)
        const party = Math.max(1, Math.min(wanted > 0 ? wanted : alates, alates));
        const launched = nuptial?.launched ?? 0;
        view.bars.push({ id: 'flight', label: 'Alates launched', value: flown ? 1 : launched, target: flown ? 1 : party, text: flown ? 'Flown' : `${int(launched)} / ${int(party)}` });
      }
      view.subObjectives.push(
        { id: 'grow', label: `Raise ${int(target)} ants`, done: popDone, progress: clamp01(popV / Math.max(1, target)), hint: 'The colony only invests in winged alates once it is large enough.' },
        { id: 'rear', label: wanted > 0 ? `Rear ${int(wanted)} winged alates` : 'Rear winged alates', done: reared, progress: wanted > 0 ? clamp01(alates / wanted) : undefined, hint: 'Alate brood needs plenty of food. Keep the nursery fed.' },
        { id: 'gather', label: 'Gather the alates at the launch site', done: gathered, hint: 'Alates wait for a warm, dry day, then climb to the entrance.' },
        { id: 'takeoff', label: 'Launch the nuptial flight', done: flown, hint: 'Protect them until they take off — the flight wins the map.' },
      );
      if (phase === 'waiting' && nuptial?.hold) view.note = `Flight on hold: ${HOLD_TEXT[nuptial.hold] ?? nuptial.hold}`;
      else if (phase === 'gather') view.note = 'The alates are gathering';
      else if (phase === 'takeoff') view.note = 'Take-off!';
      break;
    }
    case 'eliminateRival': {
      const total = Math.max(target, goals.rivalsAlive + goals.rivalsEliminated, 1);
      const v = finished ? total : Math.max(progress, goals.rivalsEliminated);
      view.bars.push({ id: 'rivals', label: 'Rival colonies destroyed', value: v, target: total, text: `${int(v)} / ${int(total)}` });
      view.subObjectives.push(
        { id: 'army', label: 'Raise soldiers', done: finished, hint: 'Shift the brood ratio towards soldiers in the colony panel.' },
        { id: 'queen', label: 'Kill the rival queen', done: finished || v >= total, progress: clamp01(v / total), hint: 'Drop an Attack beacon on their nest, or lead the raid yourself.' },
      );
      break;
    }
    case 'excavate': {
      const v = finished ? Math.max(target, goals.excavatedPercent, progress) : Math.max(progress, goals.excavatedPercent);
      view.bars.push({ id: 'excavated', label: 'Excavated', value: v, target, text: `${pct(v)} / ${pct(target)}` });
      view.subObjectives.push(
        { id: 'dig', label: `Excavate ${pct(target)} of the farm`, done: finished || v >= target, progress: clamp01(v / Math.max(1e-6, target)), hint: 'Paint dig designations and raise the Dig priority.' },
        { id: 'queen', label: 'Keep the queen alive', done: finished, hint: 'The colony falls when the queen dies with no heir in the brood.' },
      );
      break;
    }
    case 'survive': {
      const v = finished ? Math.max(target, progress) : progress;
      view.bars.push({ id: 'days', label: 'Days survived', value: v, target, text: `${v >= 10 ? int(v) : (Math.floor(v * 10) / 10).toString()} / ${int(target)}` });
      view.subObjectives.push({ id: 'survive', label: `Survive ${int(target)} days`, done: finished || v >= target, progress: clamp01(v / Math.max(1, target)), hint: 'Stock the granary before the nights turn cold.' });
      break;
    }
    default:
      break;
  }
  return view;
}

/** Stable signature of a view — the DOM is rebuilt only when it changes. */
export function goalViewKey(v: GoalView): string {
  let k = `${v.kind}|${v.title}|${v.status}|${v.statusText}|${v.note}`;
  for (const b of v.bars) k += `|${b.id}:${b.text}:${(b.target > 0 ? b.value / b.target : 0).toFixed(3)}`;
  for (const s of v.subObjectives) k += `|${s.id}:${s.done ? 1 : 0}:${s.progress === undefined ? '' : s.progress.toFixed(2)}:${s.label}`;
  return k;
}
