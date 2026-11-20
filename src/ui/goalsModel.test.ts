import { describe, expect, it } from 'vitest';
import type { GoalKind, GoalsState, NuptialState } from '../core';
import { buildGoalView, goalViewKey, type GoalInputs } from './goalsModel';

const goals = (p: Partial<GoalsState> = {}): GoalsState => ({
  phase: 'playing',
  graceUntil: 0,
  summary: { result: 'playing', reason: '', days: 0, seconds: 0, population: 0, peakPopulation: 0, born: 0, deaths: 0, kills: 0, dugVoxels: 0, foodGathered: 0, alatesLaunched: 0 },
  rivalsAlive: 0,
  rivalsEliminated: 0,
  excavatedPercent: 0,
  ...p,
});
const nuptial = (p: Partial<NuptialState>): NuptialState => ({ colony: 1, phase: 'none', wanted: 0, alates: 0, launched: 0, gatherPos: null, gatherCell: -1, phaseTick: 0, hold: '', ...p });

function inputs(kind: GoalKind, target: number, p: Partial<GoalInputs> & { progress?: number; status?: 'active' | 'won' | 'lost' } = {}): GoalInputs {
  return {
    goal: { def: { id: 'g', kind, target, label: `Goal ${kind}` }, progress: p.progress ?? 0, status: p.status ?? 'active', reason: '' },
    goals: p.goals ?? goals(),
    nuptial: p.nuptial ?? null,
    population: p.population ?? 0,
    day: p.day ?? 0,
    tick: p.tick ?? 0,
    event: p.event ?? null,
  };
}

describe('buildGoalView', () => {
  it('population: falls back to the live population while the goals system is a stub', () => {
    const v = buildGoalView(inputs('population', 60, { population: 15 }));
    expect(v.status).toBe('active');
    expect(v.bars).toHaveLength(1);
    expect(v.bars[0]).toMatchObject({ id: 'population', value: 15, target: 60, text: '15 / 60' });
    expect(v.subObjectives[0]).toMatchObject({ id: 'grow', done: false, progress: 0.25 });
    const w = buildGoalView(inputs('population', 60, { population: 15, progress: 61 }));
    expect(w.bars[0].text).toBe('61 / 60');
    expect(w.subObjectives[0].done).toBe(true);
  });

  it('a goalProgress event overrides progress and target', () => {
    const v = buildGoalView(inputs('population', 60, { population: 15, progress: 15, event: { progress: 33, target: 80 } }));
    expect(v.bars[0]).toMatchObject({ value: 33, target: 80, text: '33 / 80' });
  });

  it('nuptial flight walks population → alates → gather → take-off', () => {
    let v = buildGoalView(inputs('nuptialFlight', 150, { population: 30 }));
    expect(v.bars[0].id).toBe('population');
    expect(v.subObjectives.map((s) => s.done)).toEqual([false, false, false, false]);

    v = buildGoalView(inputs('nuptialFlight', 150, { population: 160, nuptial: nuptial({ phase: 'rearing', wanted: 8, alates: 2 }) }));
    expect(v.bars[0]).toMatchObject({ id: 'alates', value: 2, target: 8, text: '2 / 8' });
    expect(v.subObjectives.map((s) => s.done)).toEqual([true, false, false, false]);
    expect(v.subObjectives[1].progress).toBe(0.25);

    // population may dip below the target once rearing has begun: step one stays done
    v = buildGoalView(inputs('nuptialFlight', 150, { population: 120, nuptial: nuptial({ phase: 'waiting', wanted: 8, alates: 8, hold: 'rain' }) }));
    expect(v.subObjectives.map((s) => s.done)).toEqual([true, true, false, false]);
    expect(v.note).toMatch(/rain/);

    v = buildGoalView(inputs('nuptialFlight', 150, { population: 150, nuptial: nuptial({ phase: 'takeoff', wanted: 8, alates: 3, launched: 5 }) }));
    expect(v.bars[0]).toMatchObject({ id: 'flight', value: 5, target: 8 });
    expect(v.subObjectives.map((s) => s.done)).toEqual([true, true, true, false]);

    v = buildGoalView(inputs('nuptialFlight', 150, { population: 150, status: 'won', nuptial: nuptial({ phase: 'done', wanted: 8, launched: 8 }) }));
    expect(v.status).toBe('won');
    expect(v.statusText).toBe('Complete');
    expect(v.subObjectives.every((s) => s.done)).toBe(true);
  });

  it('eliminate rival and excavate read the B3 goal state', () => {
    let v = buildGoalView(inputs('eliminateRival', 1, { goals: goals({ rivalsAlive: 2, rivalsEliminated: 1 }) }));
    expect(v.bars[0]).toMatchObject({ value: 1, target: 3, text: '1 / 3' });
    v = buildGoalView(inputs('excavate', 25, { goals: goals({ excavatedPercent: 12.5 }) }));
    expect(v.bars[0]).toMatchObject({ value: 12.5, target: 25, text: '12.5% / 25%' });
    expect(v.subObjectives[0].progress).toBe(0.5);
  });

  it('survive counts days', () => {
    const v = buildGoalView(inputs('survive', 5, { progress: 2.37 }));
    expect(v.bars[0].text).toBe('2.3 / 5');
  });

  it('sandbox is a compact chip without bars', () => {
    const v = buildGoalView(inputs('sandbox', 0, { population: 42, day: 2 }));
    expect(v.status).toBe('sandbox');
    expect(v.title).toBe('Sandbox');
    expect(v.bars).toEqual([]);
    expect(v.subObjectives).toEqual([]);
    expect(v.note).toBe('Day 3 · 42 ants');
  });

  it('reports succession, loss and continued play', () => {
    let v = buildGoalView(inputs('population', 60, { tick: 300, goals: goals({ phase: 'succession', graceUntil: 900 }) }));
    expect(v.status).toBe('succession');
    expect(v.statusText).toBe('Queen lost — 20s to raise an heir');
    v = buildGoalView(inputs('population', 60, { status: 'lost' }));
    expect(v.status).toBe('lost');
    v = buildGoalView(inputs('population', 60, { goals: goals({ phase: 'continued' }), population: 10 }));
    expect(v.status).toBe('continued');
    expect(v.subObjectives.every((s) => s.done)).toBe(true);
  });

  it('view key changes only when something visible changes', () => {
    const a = goalViewKey(buildGoalView(inputs('population', 60, { population: 15 })));
    const b = goalViewKey(buildGoalView(inputs('population', 60, { population: 15, tick: 999 })));
    const c = goalViewKey(buildGoalView(inputs('population', 60, { population: 16 })));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('never produces NaN with zero targets', () => {
    for (const k of ['population', 'nuptialFlight', 'eliminateRival', 'excavate', 'survive', 'sandbox'] as GoalKind[]) {
      const v = buildGoalView(inputs(k, 0));
      expect(goalViewKey(v)).not.toMatch(/NaN|Infinity/);
    }
  });
});
