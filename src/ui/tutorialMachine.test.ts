import { describe, expect, it } from 'vitest';
import { TUTORIAL_STEPS, TipQueue, TutorialMachine } from './tutorialMachine';

describe('TutorialMachine', () => {
  it('has the six steps of PLAN §2 in order', () => {
    expect(TUTORIAL_STEPS.map((s) => s.id)).toEqual(['camera', 'select', 'order', 'dig', 'possess', 'colony']);
  });

  it('advances one step per matching signal', () => {
    const t = new TutorialMachine();
    expect(t.snapshot()).toMatchObject({ index: 0, step: 'camera', active: true, finished: false });
    expect(t.feed('cameraMoved').completed).toEqual(['camera']);
    expect(t.current?.id).toBe('select');
    expect(t.feed('selected').completed).toEqual(['select']);
    expect(t.feed('ordered').completed).toEqual(['order']);
    expect(t.feed('digPainted').completed).toEqual(['dig']);
    expect(t.current?.id).toBe('possess');
  });

  it('possess needs possess then release, in that order', () => {
    const t = new TutorialMachine({ done: ['camera', 'select', 'order', 'dig'] });
    expect(t.current?.id).toBe('possess');
    expect(t.feed('released')).toMatchObject({ completed: [], progressed: false });
    const a = t.feed('possessed');
    expect(a).toMatchObject({ completed: [], progressed: true });
    expect(t.snapshot().progress).toBe(1);
    expect(t.feed('released').completed).toEqual(['possess']);
    expect(t.current?.id).toBe('colony');
    const end = t.feed('colonyOpened');
    expect(end).toMatchObject({ completed: ['colony'], finished: true });
    expect(t.active).toBe(false);
    expect(t.snapshot().step).toBeNull();
  });

  it('ignores signals for other steps but remembers single-signal ones', () => {
    const t = new TutorialMachine();
    expect(t.feed('selected').completed).toEqual([]); // step is still "camera"
    expect(t.feed('colonyOpened').completed).toEqual([]);
    // camera completes → select was already done → cascades
    expect(t.feed('cameraMoved').completed).toEqual(['camera', 'select']);
    expect(t.current?.id).toBe('order');
    t.feed('ordered');
    t.feed('digPainted');
    t.feed('possessed');
    // colony was opened early: finishing possess finishes the tutorial
    expect(t.feed('released')).toMatchObject({ completed: ['possess', 'colony'], finished: true });
  });

  it('an early possession does not pre-complete the two-part step', () => {
    const t = new TutorialMachine();
    t.feed('possessed');
    t.feed('released');
    t.feed('cameraMoved');
    t.feed('selected');
    t.feed('ordered');
    t.feed('digPainted');
    expect(t.current?.id).toBe('possess');
    expect(t.snapshot().progress).toBe(0);
  });

  it('skip stops everything; reset and goto restart it', () => {
    const t = new TutorialMachine();
    t.skip();
    expect(t.active).toBe(false);
    expect(t.feed('cameraMoved').completed).toEqual([]);
    expect(t.save()).toEqual({ done: [], skipped: true });
    t.reset();
    expect(t.snapshot()).toMatchObject({ index: 0, active: true, skipped: false });
    t.goto(4);
    expect(t.current?.id).toBe('possess');
    t.goto(99);
    expect(t.finished).toBe(true);
  });

  it('restores from saved progress and drops unknown ids', () => {
    const t = new TutorialMachine({ done: ['camera', 'select', 'bogus'], skipped: false });
    expect(t.snapshot()).toMatchObject({ index: 2, step: 'order', done: ['camera', 'select'] });
    const s = new TutorialMachine({ done: TUTORIAL_STEPS.map((x) => x.id) });
    expect(s.finished).toBe(true);
    expect(s.active).toBe(false);
  });
});

describe('TipQueue', () => {
  it('shows each tip once, one at a time, in order', () => {
    const q = new TipQueue(['night']);
    expect(q.offer('night')).toBe(false);
    expect(q.offer('rain')).toBe(true);
    expect(q.offer('rain')).toBe(false);
    expect(q.offer('flood')).toBe(true);
    expect(q.next()).toBe('rain');
    expect(q.next()).toBe('rain'); // still showing
    q.dismiss();
    expect(q.next()).toBe('flood');
    q.dismiss();
    expect(q.next()).toBeNull();
    expect(q.seenList().sort()).toEqual(['flood', 'night', 'rain']);
  });
});
