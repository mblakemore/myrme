/**
 * Goal tracker & objectives card (HUD `goal` slot, `data-testid="goal"`). The view-model is
 * `./goalsModel.ts`; this file only maps it to DOM with diffed writes. Header click folds the
 * sub-objective checklist in / out.
 */
import type { Feature, FeatureContext } from './features';
import { h, renderKeyed, setClass, setShown, setStyle, setText } from './dom';
import { buildGoalView, goalInputs, goalViewKey, type GoalInputs } from './goalsModel';
import { icon } from './icons';

export const GOALS_CSS = `
.myrme-hud .mg-goal { width: 21em; max-width: 100%; padding: .35em .65em .45em; color: var(--mh-text); }
.myrme-hud .mg-goal .mg-head { display: flex; align-items: flex-start; gap: .45em; cursor: pointer; }
.myrme-hud .mg-goal .mg-head > .mh-icon { color: var(--mh-amber); margin-top: .05em; }
.myrme-hud .mg-goal .mg-title { flex: 1 1 auto; min-width: 0; line-height: 1.25; }
.myrme-hud .mg-goal .mg-chev { width: 1em; height: 1em; margin-top: .15em; color: var(--mh-dim); transition: transform .15s; }
.myrme-hud .mg-goal.mg-folded .mg-chev { transform: rotate(-90deg); }
.myrme-hud .mg-goal .mg-bars { display: flex; flex-direction: column; gap: .2em; margin-top: .3em; }
.myrme-hud .mg-goal .mg-barrow { display: flex; align-items: center; gap: .55em; }
.myrme-hud .mg-goal .mg-barrow .mh-bar { height: .45em; }
.myrme-hud .mg-goal .mg-num { flex: none; font-size: .9em; color: var(--mh-dim); white-space: nowrap; }
.myrme-hud .mg-goal .mg-status { margin-top: .25em; font-size: .9em; font-weight: 600; }
.myrme-hud .mg-goal .mg-note { margin-top: .2em; font-size: .9em; color: var(--mh-dim); }
.myrme-hud .mg-goal .mg-subs { margin-top: .4em; padding-top: .35em; border-top: 1px solid var(--mh-border); display: flex; flex-direction: column; gap: .18em; }
.myrme-hud .mg-goal.mg-folded .mg-subs { display: none; }
.myrme-hud .mg-goal .mg-sub { display: flex; align-items: center; gap: .45em; font-size: .92em; }
.myrme-hud .mg-goal .mg-sub .mg-box { flex: none; width: .95em; height: .95em; border-radius: .25em; border: 1px solid var(--mh-border-hi); display: flex; align-items: center; justify-content: center; }
.myrme-hud .mg-goal .mg-sub .mg-box .mh-icon { width: .8em; height: .8em; display: none; }
.myrme-hud .mg-goal .mg-sub.mg-done { color: var(--mh-dim); }
.myrme-hud .mg-goal .mg-sub.mg-done .mg-box { background: var(--mh-accent); border-color: var(--mh-accent); color: var(--mh-accent-ink); }
.myrme-hud .mg-goal .mg-sub.mg-done .mg-box .mh-icon { display: block; }
.myrme-hud .mg-goal .mg-sub.mg-next { color: var(--mh-text); }
.myrme-hud .mg-goal .mg-sub .mg-subpct { margin-left: auto; color: var(--mh-dim); font-size: .9em; }
.myrme-hud .mg-goal.mg-won { border-color: var(--mh-accent); } .myrme-hud .mg-goal.mg-won .mg-status { color: var(--mh-accent); }
.myrme-hud .mg-goal.mg-lost { border-color: var(--mh-red); } .myrme-hud .mg-goal.mg-lost .mg-status { color: var(--mh-red); }
.myrme-hud .mg-goal.mg-lost .mh-bar > i { background: var(--mh-red); }
.myrme-hud .mg-goal.mg-succession { border-color: var(--mh-amber); } .myrme-hud .mg-goal.mg-succession .mg-status { color: var(--mh-amber); }
.myrme-hud .mg-goal.mg-sandbox { width: auto; }
.myrme-hud .mg-goal.mg-sandbox .mg-head { align-items: center; cursor: default; }
.myrme-hud .mg-goal.mg-sandbox .mg-note { margin: 0 0 0 .3em; }
.myrme-hud .mg-goal.mg-sandbox .mg-chev { display: none; }
`;

const STATUSES = ['won', 'lost', 'succession', 'continued', 'sandbox'] as const;

export function createGoalTracker(ctx: FeatureContext): Feature {
  const { app, hud } = ctx;
  const style = h('style', undefined, { 'data-myrme': 'b5-goals' }, GOALS_CSS);
  document.head.appendChild(style);

  const title = h('span', 'mg-title', { testid: 'goal-title' });
  const headNote = h('span', 'mg-note mh-hidden', { testid: 'goal-note-inline' });
  const head = h('div', 'mg-head', { tip: 'Map goal — click for objectives' }, [icon('goal'), title, headNote, icon('chevron', 'mg-chev')]);
  const bars = h('div', 'mg-bars');
  const status = h('div', 'mg-status mh-hidden', { testid: 'goal-status' });
  const note = h('div', 'mg-note mh-hidden', { testid: 'goal-note' });
  const subs = h('div', 'mg-subs', { testid: 'goal-subs' });
  const el = h('div', 'mh-panel mg-goal mg-folded', { testid: 'goal' }, [head, bars, status, note, subs]);
  hud.slot('goal').append(el);

  let folded = true;
  ctx.d.on(head, 'click', () => {
    folded = !folded;
    setClass(el, 'mg-folded', folded);
  });

  // latest goalProgress event; dropped as soon as sim.goal.progress itself moves on
  let event: GoalInputs['event'] = null;
  let eventBase = 0;
  let barEls: { fill: HTMLElement; num: HTMLElement }[] = [];
  let lastKey = '';

  return {
    frame(frame) {
      for (const e of frame.events) {
        if (e.type !== 'goalProgress') continue;
        if (e.goal && e.goal !== app.sim.goal.def.id) continue;
        event = { progress: e.progress, target: e.target };
        eventBase = app.sim.goal.progress;
      }
    },
    update() {
      const sim = app.sim;
      if (!sim.goal || !sim.goal.def) return;
      if (event && sim.goal.progress !== eventBase) event = null;
      const v = buildGoalView(goalInputs(sim, event));
      const key = goalViewKey(v);
      if (key === lastKey) return;
      lastKey = key;

      setText(title, v.title);
      for (const s of STATUSES) setClass(el, `mg-${s}`, v.status === s);
      const sandbox = v.kind === 'sandbox';
      setShown(status, v.statusText !== '');
      setText(status, v.statusText);
      setShown(note, v.note !== '' && !sandbox);
      setText(note, v.note);
      setShown(headNote, sandbox && v.note !== '');
      setText(headNote, v.note);
      setShown(bars, v.bars.length > 0);
      setShown(subs, v.subObjectives.length > 0);

      if (
        renderKeyed(bars, v.bars.map((b) => b.id).join(','), () => {
          barEls = [];
          return v.bars.map((b) => {
            const fill = h('i');
            const num = h('span', 'mg-num', { testid: `goal-num-${b.id}` });
            barEls.push({ fill, num });
            return h('div', 'mg-barrow', { tip: b.label, testid: `goal-bar-${b.id}` }, [h('span', 'mh-bar', null, [fill]), num]);
          });
        })
      ) {
        /* rebuilt */
      }
      v.bars.forEach((b, i) => {
        const r = barEls[i];
        if (!r) return;
        setStyle(r.fill, 'transform', `scaleX(${(b.target > 0 ? Math.min(1, Math.max(0, b.value / b.target)) : 0).toFixed(3)})`);
        setText(r.num, b.text);
      });

      const next = v.subObjectives.findIndex((s) => !s.done);
      renderKeyed(subs, v.subObjectives.map((s) => `${s.id}:${s.done ? 1 : 0}:${s.label}:${s.progress === undefined ? '' : Math.round(s.progress * 100)}`).join('|') + `#${next}`, () =>
        v.subObjectives.map((s, i) =>
          h('div', `mg-sub${s.done ? ' mg-done' : ''}${i === next ? ' mg-next' : ''}`, { tip: s.hint, testid: `goal-sub-${s.id}` }, [
            h('span', 'mg-box', null, [icon('check')]),
            h('span', undefined, null, s.label),
            !s.done && s.progress !== undefined && s.progress > 0 ? h('span', 'mg-subpct', null, `${Math.round(s.progress * 100)}%`) : null,
          ]),
        ),
      );
    },
    dispose() {
      el.remove();
      style.remove();
    },
  };
}
