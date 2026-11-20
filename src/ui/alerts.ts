import type { AlertCode, FrameInfo, Vec3 } from '../core';
import type { HudComponent, HudContext } from './context';
import { h, renderKeyed, setClass } from './dom';
import { icon } from './icons';
import type { Severity, ToastOptions } from './slots';

const SEVERITY: Record<AlertCode, Severity> = {
  underAttack: 'danger',
  queenInDanger: 'danger',
  queenDead: 'danger',
  possessedDied: 'danger',
  raidIncoming: 'danger',
  starving: 'warn',
  flooding: 'warn',
  infectionSpotted: 'warn',
  predatorNear: 'warn',
  broodHungry: 'warn',
  gardenSick: 'warn',
  info: 'info',
};
const SEV_ICON: Record<Severity, string> = { info: 'info', good: 'goal', warn: 'warn', danger: 'skull' };

/** Sim win / lose reason codes → words (unknown codes are simply left out of the toast). */
const WIN_REASON: Record<string, string> = { nuptialFlight: 'the nuptial flight is away', population: 'the colony is thriving', eliminateRival: 'the rival colony is destroyed', excavate: 'the farm is excavated', survive: 'the colony endured' };
const LOSE_REASON: Record<string, string> = { queenDead: 'the queen is dead', kingDead: 'the royal pair is broken', colonyDead: 'no ants are left', conceded: 'the colony was abandoned' };

const MAX_ALERTS = 5;
const DEFAULT_TTL = 12;
const FADE_MS = 600;
const MERGE_MS = 5000;

interface Entry {
  seq: number;
  key: string;
  text: string;
  severity: Severity;
  pos: Vec3 | null;
  born: number;
  ttlMs: number;
  count: number;
  el: HTMLElement | null;
}

/** Toast text → nodes: a `backticked` run becomes a key cap (`.mh-kbd`). */
function richText(text: string): (string | HTMLElement)[] {
  if (!text.includes('`')) return [text];
  return text.split('`').map((part, i) => (i % 2 ? h('span', 'mh-kbd', null, part) : part)).filter((x) => x !== '');
}

export interface AlertsComponent extends HudComponent {
  push(text: string, opts?: ToastOptions & { key?: string }): void;
}

/**
 * Alerts feed. Sim `alert` events are collected every frame (events are only valid during the
 * frame, D19); the DOM list is rebuilt only when the set of visible entries changes.
 */
export function createAlerts(ctx: HudContext): AlertsComponent {
  const { app } = ctx;
  const el = h('div', 'mh-alerts', { testid: 'alerts' });
  let entries: Entry[] = [];
  let seq = 0;
  let dirty = false;

  function push(text: string, opts: ToastOptions & { key?: string } = {}): void {
    const now = performance.now();
    const key = opts.key ?? text;
    // One line per message: a repeat of anything still on screen refreshes that line instead of
    // adding a second one (a 90-sim-second repeat arrives ~20 s apart at 4×, sooner when a script
    // steps the sim). Only a quick burst counts up the ×N badge.
    const prev = entries.find((e) => e.key === key && now - e.born < e.ttlMs);
    if (prev) {
      if (now - prev.born < MERGE_MS) prev.count++;
      prev.born = now;
      prev.el?.classList.remove('mh-fade');
      if (opts.pos) prev.pos = { ...opts.pos };
      dirty = true;
      return;
    }
    entries.push({ seq: ++seq, key, text, severity: opts.severity ?? 'info', pos: opts.pos ? { ...opts.pos } : null, born: now, ttlMs: (opts.ttl ?? DEFAULT_TTL) * 1000, count: 1, el: null });
    if (entries.length > MAX_ALERTS) entries = entries.slice(entries.length - MAX_ALERTS);
    dirty = true;
  }

  ctx.d.on(el, 'click', (e: MouseEvent) => {
    const node = (e.target as HTMLElement).closest<HTMLElement>('.mh-alert');
    if (!node) return;
    const entry = entries.find((x) => String(x.seq) === node.dataset.seq);
    if (!entry) return;
    if (entry.pos) ctx.api()?.jumpTo(entry.pos);
    else {
      // no location: clicking dismisses
      entries = entries.filter((x) => x !== entry);
      dirty = true;
    }
  });

  function collect(frame: FrameInfo): void {
    const events = frame.events;
    if (!events.length) return;
    const pc = app.sim.playerColony;
    let sawPossessedDied = false;
    let possessionDied = false;
    let diedId = 0;
    // where the possessed ant fell: its `antDied` event of this frame, else its last known position
    const deathPos = (id: number): Vec3 | null => {
      if (id) for (const x of events) if (x.type === 'antDied' && x.id === id) return x.pos;
      return lastPossessPos;
    };
    for (const e of events) {
      switch (e.type) {
        case 'alert':
          if (e.colony !== pc && e.colony !== 0) break;
          if (e.code === 'possessedDied') {
            sawPossessedDied = true;
            push(e.text || e.code, { severity: 'danger', pos: e.pos ?? deathPos(e.id), key: `${e.code}:${e.text}` });
            break;
          }
          push(e.text || e.code, { severity: SEVERITY[e.code] ?? 'info', pos: e.pos, key: `${e.code}:${e.text}` });
          break;
        case 'possession':
          if (e.op === 'stop' && e.reason === 'died') {
            possessionDied = true;
            diedId = e.id;
          }
          break;
        case 'win':
          push(`Victory${WIN_REASON[e.reason] ? ` — ${WIN_REASON[e.reason]}` : ''}`, { severity: 'good', ttl: 30, key: 'win' });
          break;
        case 'lose':
          push(`The colony has fallen${LOSE_REASON[e.reason] ? ` — ${LOSE_REASON[e.reason]}` : ''}`, { severity: 'danger', ttl: 30, key: 'lose' });
          break;
        default:
          break;
      }
    }
    if (possessionDied && !sawPossessedDied) push('The ant you were controlling has died', { severity: 'danger', pos: deathPos(diedId), key: 'possessedDied:local' });
  }

  let lastPossessPos: Vec3 | null = null;
  function trackPossessed(): void {
    const id = app.sim.possessedId;
    const a = id ? app.sim.getAnt(id) : undefined;
    if (a) lastPossessPos = { x: a.pos.x, y: a.pos.y, z: a.pos.z };
    else if (!id && app.view.mode !== 'possess') lastPossessPos = null;
  }

  return {
    el,
    push,
    frame(frame) {
      collect(frame);
      trackPossessed();
    },
    update(now) {
      // expire
      const before = entries.length;
      entries = entries.filter((e) => now - e.born < e.ttlMs);
      if (entries.length !== before) dirty = true;
      if (dirty) {
        dirty = false;
        let key = '';
        for (const e of entries) key += `${e.seq}x${e.count}|`;
        renderKeyed(el, key, () =>
          entries
            .slice()
            .reverse()
            .map((e) => {
              const node = h('div', `mh-panel mh-alert mh-sev-${e.severity}${e.pos ? ' mh-jump' : ''}`, { 'data-seq': e.seq, tip: e.pos ? 'Click to jump there' : undefined }, [
                icon(SEV_ICON[e.severity]),
                h('span', 'mh-grow', null, richText(e.text)),
                e.count > 1 ? h('span', 'mh-count', null, `×${e.count}`) : null,
              ]);
              if (e.el) node.style.animation = 'none'; // already shown once: no slide-in replay
              e.el = node;
              return node;
            }),
        );
      }
      for (const e of entries) if (e.el) setClass(e.el, 'mh-fade', now - e.born > e.ttlMs - FADE_MS);
    },
  };
}
