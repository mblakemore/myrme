/**
 * End screens (B5 item 2). Driven by the sim's `win` / `lose` events (B3's `gameEnd` adds the
 * summary; without it the time-series recorder supplies the numbers).
 *
 *  - Win: a banner first, so the finale can play (the nuptial flight gets the longest look), then
 *    the summary card with "Continue in sandbox".
 *  - Lose: sombre card — the world behind it is drained of colour — with retry / menu.
 *
 * The sim is paused while a card is up. `continue` sends B3's `goal` command and resumes.
 */
import { b3Command, type AnySimEvent, type EndSummary, type FrameInfo, type GoalKind } from '../core';
import { fmtNum, h } from './dom';
import type { Feature, FeatureContext } from './features';

const WIN_TITLE: Record<string, { title: string; line: string }> = {
  nuptialFlight: { title: 'The flight is away', line: 'Winged queens and males rise on the warm air. Somewhere, new colonies begin.' },
  population: { title: 'A thriving colony', line: 'The nest hums. Every chamber is full and the trails never rest.' },
  eliminateRival: { title: 'The rival nest has fallen', line: 'Their trails fade from the ground. The territory is yours.' },
  excavate: { title: 'The nest is dug', line: 'Galleries and chambers wind through the whole farm.' },
  survive: { title: 'Still standing', line: 'Whatever came, the colony outlasted it.' },
};
const LOSE_TITLE: Record<string, { title: string; line: string }> = {
  queenDead: { title: 'The queen is dead', line: 'No eggs are laid. The last workers tend an empty chamber.' },
  kingDead: { title: 'The royal pair is broken', line: 'Without both king and queen the mound slowly falls silent.' },
  colonyDead: { title: 'The colony is gone', line: 'Not one ant is left to carry the scent of home.' },
  conceded: { title: 'The colony is abandoned', line: 'The trails go cold.' },
};

/** Seconds the finale plays before the summary card appears. */
const FINALE_SECONDS: Partial<Record<GoalKind, number>> = { nuptialFlight: 6 };
const DEFAULT_FINALE = 1.6;
const LOSE_DELAY = 1.4;

export interface EndScreenFeature extends Feature {
  /** 'won' | 'lost' while a banner or card is up. */
  state(): 'none' | 'won' | 'lost';
}

function fmtDays(days: number, seconds: number): string {
  if (days >= 1) return days >= 10 ? String(Math.round(days)) : days.toFixed(1);
  const m = Math.floor(seconds / 60);
  return `${m} min`;
}

export function createEndScreen(ctx: FeatureContext): EndScreenFeature {
  const { app, hud } = ctx;
  let state: 'none' | 'won' | 'lost' = 'none';
  let pending: { result: 'won' | 'lost'; reason: string; summary: EndSummary | null; at: number } | null = null;
  let banner: HTMLElement | null = null;
  let modal: { close(): void } | null = null;
  let continued = false;

  const setPaused = (p: boolean): void => {
    const api = ctx.input();
    if (api) api.setPaused(p);
    else app.command({ type: 'pause', paused: p });
  };

  function stat(testid: string, label: string, value: string): HTMLElement {
    return h('div', 'ms-end-stat', null, [h('b', undefined, { testid }, value), h('span', undefined, null, label)]);
  }

  function sparkline(values: number[]): SVGSVGElement | null {
    if (values.length < 3) return null;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 24');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'ms-end-spark');
    const max = Math.max(1, ...values);
    const n = values.length;
    let dPath = '';
    for (let i = 0; i < n; i++) dPath += `${i === 0 ? 'M' : 'L'}${((i / (n - 1)) * 100).toFixed(2)} ${(22 - (values[i] / max) * 20).toFixed(2)}`;
    const area = document.createElementNS(NS, 'path');
    area.setAttribute('d', `${dPath}L100 24L0 24Z`);
    area.setAttribute('class', 'ms-end-spark-area');
    const line = document.createElementNS(NS, 'path');
    line.setAttribute('d', dPath);
    line.setAttribute('class', 'ms-end-spark-line');
    svg.append(area, line);
    return svg;
  }

  function showCard(result: 'won' | 'lost', reason: string, given: EndSummary | null): void {
    banner?.remove();
    banner = null;
    if (modal) return;
    // B3's summary when it carries data, else the recorder's
    const rec = ctx.recorder.summary(app.sim);
    const sum: EndSummary = given && (given.peakPopulation > 0 || given.seconds > 0) ? { ...given, peakPopulation: Math.max(given.peakPopulation, rec.peakPopulation) } : rec;
    const won = result === 'won';
    const text = (won ? WIN_TITLE : LOSE_TITLE)[reason] ?? (won ? { title: 'Victory', line: app.sim.goal.def.label } : { title: 'The colony has fallen', line: 'The trails go cold.' });
    setPaused(true);

    const btn = (testid: string, label: string, onClick: () => void, primary = false): HTMLButtonElement => {
      const b = h('button', `mh-btn${primary ? ' mh-on' : ''}`, { type: 'button', testid }, label);
      b.addEventListener('click', () => {
        ctx.audio?.ui(primary ? 'confirm' : 'click');
        onClick();
      });
      return b;
    };
    const buttons: HTMLElement[] = [];
    if (won) {
      buttons.push(
        btn(
          'end-continue',
          'Continue in sandbox',
          () => {
            continued = true;
            app.command(b3Command({ type: 'goal', op: 'continue' }));
            closeCard(true);
          },
          true,
        ),
      );
    }
    if (ctx.shell.hasMenu) {
      buttons.push(btn('end-retry', won ? 'Play again' : 'Try again', () => { closeCard(false); ctx.shell.restart(); }, !won));
      buttons.push(btn('end-menu', 'Main menu', () => { closeCard(false); ctx.shell.quitToMenu(); }));
    } else if (!won) {
      buttons.push(btn('end-watch', 'Keep watching', () => closeCard(true), true));
    }

    const spark = sparkline(ctx.recorder.values('population'));
    const el = h('div', `mh-panel mh-dialog ms-end ${won ? 'ms-end-won' : 'ms-end-lost'}`, { testid: won ? 'end-win' : 'end-lose', role: 'dialog', 'aria-label': text.title }, [
      h('div', 'ms-end-kicker', null, won ? 'Goal complete' : 'Colony lost'),
      h('h2', 'ms-end-title', { testid: 'end-title' }, text.title),
      h('p', 'ms-end-line', null, text.line),
      h('div', 'ms-end-stats', null, [
        stat('end-days', sum.days >= 1 ? 'days' : 'survived', fmtDays(sum.days, sum.seconds)),
        stat('end-peak', 'peak population', fmtNum(sum.peakPopulation)),
        stat('end-food', 'food gathered', fmtNum(Math.round(sum.foodGathered))),
        sum.alatesLaunched > 0 ? stat('end-alates', 'alates flown', fmtNum(sum.alatesLaunched)) : stat('end-dug', 'voxels dug', fmtNum(sum.dugVoxels)),
        stat('end-kills', 'kills', fmtNum(sum.kills)),
        stat('end-deaths', 'losses', fmtNum(sum.deaths)),
      ]),
      spark ? h('div', 'ms-end-chart', null, [spark as unknown as Node, h('span', 'mh-dim', null, 'Population over time')]) : null,
      h('div', 'ms-end-actions', null, buttons),
    ]);
    hud.root.classList.toggle('ms-world-lost', !won);
    modal = hud.openModal(el, {
      dismissible: false,
      onClose: () => {
        modal = null;
        hud.root.classList.remove('ms-world-lost');
      },
    });
    (buttons[0] as HTMLButtonElement | undefined)?.focus({ preventScroll: true });
  }

  function closeCard(resume: boolean): void {
    modal?.close();
    state = 'none';
    if (resume) setPaused(false);
  }

  function onEnd(result: 'won' | 'lost', reason: string, summary: EndSummary | null, frame: FrameInfo): void {
    if (state !== 'none' || (result === 'won' && continued)) return;
    state = result;
    const delay = frame.frozen ? 0 : result === 'won' ? (FINALE_SECONDS[app.sim.goal.def.kind] ?? DEFAULT_FINALE) : LOSE_DELAY;
    pending = { result, reason, summary, at: performance.now() + delay * 1000 };
    // release the possessed ant / close the pause menu so the finale is visible
    if (app.sim.possessedId) ctx.input()?.release();
    const text = result === 'won' ? (WIN_TITLE[reason]?.title ?? 'Victory') : (LOSE_TITLE[reason]?.title ?? 'The colony has fallen');
    banner = h('div', `ms-end-banner ${result === 'won' ? 'ms-end-won' : 'ms-end-lost'}`, { testid: 'end-banner' }, [h('span', undefined, null, text)]);
    hud.slot('overlay').append(banner);
  }

  return {
    state: () => state,
    frame(frame) {
      if (frame.events.length) {
        let result: 'won' | 'lost' | null = null;
        let reason = '';
        let summary: EndSummary | null = null;
        for (const e of frame.events as readonly AnySimEvent[]) {
          if (e.type === 'win') {
            result = 'won';
            reason = e.reason;
          } else if (e.type === 'lose') {
            result = 'lost';
            reason = e.reason;
          } else if (e.type === 'gameEnd') {
            result = result ?? e.result;
            reason = reason || e.reason;
            summary = e.summary;
          }
        }
        if (result) onEnd(result, reason, summary, frame);
      }
      if (pending && performance.now() >= pending.at) {
        const p = pending;
        pending = null;
        showCard(p.result, p.reason, p.summary);
      }
    },
    dispose() {
      pending = null;
      banner?.remove();
      modal?.close();
      hud.root.classList.remove('ms-world-lost');
    },
  };
}
