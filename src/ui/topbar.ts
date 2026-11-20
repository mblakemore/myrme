import { b3StateOf, forecastLabel, weatherLabel, type CasteId, type WeatherKind } from '../core';
import { getSpecies } from '../sim/data/species';
import type { HudComponent, HudContext } from './context';
import { fmtNum, h, humanize, renderKeyed, setClass, setShown, setText } from './dom';
import { casteIcon, icon } from './icons';

const CASTE_ORDER: readonly CasteId[] = ['queen', 'king', 'worker', 'major', 'soldier', 'nasute', 'alate'];
const WEATHER_ICON: Record<WeatherKind, string> = { clear: 'sun', cloudy: 'cloud', rain: 'rain', storm: 'rain', heat: 'temp', cold: 'temp', wind: 'wind' };

function stat(cls: string, ic: string, testid: string, tip: string): { el: HTMLElement; val: HTMLElement } {
  const val = h('b', undefined, { testid }, '0');
  return { el: h('span', `mh-stat ${cls}`, { tip }, [icon(ic), val]), val };
}

/** Top bar: stores, population by caste, brood by stage, clock, weather, speed controls. */
export function createTopBar(ctx: HudContext): HudComponent {
  const { app } = ctx;
  const food = stat('mh-food', 'food', 'food', 'Stored food');
  const leaves = stat('mh-food', 'leaf', 'store-leaves', 'Leaves awaiting the fungus garden');
  const wood = stat('mh-food', 'wood', 'store-wood', 'Wood pulp');
  const mud = stat('mh-food', 'drop', 'store-mud', 'Building mud');
  // faction extra (leafcutters): fungus garden status — the colony's only food source
  const garden = stat('mh-garden', 'fungus', 'store-garden', 'Fungus garden');
  const popTotal = stat('mh-pop', 'ant', 'pop-total', 'Population');
  const castes = h('span', 'mh-group');
  const eggs = stat('mh-brood', 'egg', 'brood-eggs', 'Eggs');
  const larvae = stat('mh-brood', 'larva', 'brood-larvae', 'Larvae');
  const pupae = stat('mh-brood', 'pupa', 'brood-pupae', 'Pupae');

  const clockIcon = h('span', 'mh-row');
  const clockText = h('span', undefined, { testid: 'clock' });
  const clock = h('span', 'mh-stat mh-clock', { tip: 'Day and time of day' }, [clockIcon, clockText]);
  const weatherIcon = h('span', 'mh-row');
  const weatherText = h('span', undefined, { testid: 'weather' });
  const weather = h('span', 'mh-stat mh-weather', { tip: 'Weather' }, [weatherIcon, weatherText]);

  const mkSpeed = (label: string | null, testid: string, tip: string, onClick: () => void): HTMLButtonElement => {
    const b = h('button', 'mh-btn', { testid, tip, type: 'button' }, label ? label : [icon('pause')]);
    ctx.d.on(b, 'click', () => {
      onClick();
      b.blur();
    });
    return b;
  };
  const setSpeed = (s: 1 | 2 | 4): void => {
    const api = ctx.api();
    if (api) {
      api.setPaused(false);
      api.setSpeed(s);
    } else {
      app.command({ type: 'pause', paused: false });
      app.command({ type: 'setSpeed', speed: s });
    }
  };
  const pauseTip = (): string => {
    const k = ctx.hint('game.pause');
    return `Pause${k ? ` (${k})` : ''}`;
  };
  let keysSeen = ctx.keysVersion();
  const bPause = mkSpeed(null, 'speed-pause', pauseTip(), () => {
    const api = ctx.api();
    if (api) api.setPaused(!app.sim.paused);
    else app.command({ type: 'pause', paused: !app.sim.paused });
  });
  bPause.classList.add('mh-paused');
  const b1 = mkSpeed('1×', 'speed-1', 'Normal speed', () => setSpeed(1));
  const b2 = mkSpeed('2×', 'speed-2', 'Double speed', () => setSpeed(2));
  const b4 = mkSpeed('4×', 'speed-4', 'Quadruple speed', () => setSpeed(4));

  const sep = (): HTMLElement => h('span', 'mh-sep');
  const el = h('div', 'mh-panel mh-top', { testid: 'topbar' }, [
    h('span', 'mh-group', null, [food.el, leaves.el, garden.el, wood.el, mud.el]),
    sep(),
    h('span', 'mh-group', null, [popTotal.el, castes]),
    sep(),
    h('span', 'mh-group', null, [eggs.el, larvae.el, pupae.el]),
    sep(),
    clock,
    weather,
    h('span', 'mh-speed', null, [bPause, b1, b2, b4]),
  ]);

  const casteVals = new Map<string, HTMLElement>();
  let lastClockIcon = '';
  let lastWeatherIcon = '';
  const counts: Partial<Record<CasteId, number>> = {};

  return {
    el,
    update() {
      const sim = app.sim;
      const colony = ctx.colony();
      const st = colony?.stores;
      if (keysSeen !== ctx.keysVersion()) {
        keysSeen = ctx.keysVersion();
        bPause.dataset.tip = pauseTip();
      }
      setText(food.val, fmtNum(Math.floor(st?.food ?? 0)));
      setClass(food.el, 'mh-warnc', !!colony && (st?.food ?? 0) <= 0 && sim.tick > 60);
      // faction stores are always shown for the factions that use them (even at 0), never for others
      const caps = colony ? getSpecies(colony.species).caps : null;
      setShown(leaves.el, !!caps?.farmsFungus || (st?.leaves ?? 0) > 0);
      setText(leaves.val, fmtNum(Math.floor(st?.leaves ?? 0)));
      setShown(wood.el, !!caps?.eatsWood || (st?.wood ?? 0) > 0);
      setText(wood.val, fmtNum(Math.floor(st?.wood ?? 0)));
      setShown(mud.el, !!caps?.canFill || (st?.mud ?? 0) > 0);
      setText(mud.val, fmtNum(Math.floor(st?.mud ?? 0)));
      setShown(garden.el, !!caps?.farmsFungus);
      if (caps?.farmsFungus && colony) {
        let health = 1;
        let mould = 0;
        let biomass = 0;
        let n = 0;
        let worst = 'healthy';
        for (const g of b3StateOf(sim).gardens) {
          if (g.colony !== colony.id) continue;
          n++;
          health = Math.min(health, g.health);
          mould = Math.max(mould, g.mould);
          biomass += g.biomass;
          if (g.status === 'collapsed' || (g.status === 'sick' && worst !== 'collapsed') || (g.status === 'founding' && worst === 'healthy')) worst = g.status;
        }
        const label = n === 0 ? 'none' : worst === 'healthy' ? `${Math.round(health * 100)}%` : worst === 'founding' ? 'new' : worst;
        setText(garden.val, label);
        setClass(garden.el, 'mh-warnc', n > 0 && (worst === 'sick' || worst === 'collapsed'));
        setClass(garden.el, 'mh-cautionc', n > 0 && worst !== 'sick' && worst !== 'collapsed' && mould > 0.1);
        const tip = n === 0 ? 'Fungus garden — not founded yet (bring leaves home)' : `Fungus garden — ${worst}, health ${Math.round(health * 100)}%, mould ${Math.round(mould * 100)}%, ${fmtNum(Math.floor(biomass))} fungus`;
        if (garden.el.dataset.tip !== tip) garden.el.dataset.tip = tip;
      }

      // population: trust the colony's counts, fall back to counting when they are empty
      let total = colony?.population.total ?? 0;
      let by: Partial<Record<CasteId, number>> = colony?.population.byCaste ?? {};
      let hasBy = false;
      for (const k in by) {
        hasBy = true;
        break;
      }
      if (!hasBy || total === 0) {
        for (const k of CASTE_ORDER) counts[k] = 0;
        total = 0;
        const pc = sim.playerColony;
        for (const a of sim.ants) {
          if (!a.alive || a.colony !== pc) continue;
          total++;
          counts[a.caste] = (counts[a.caste] ?? 0) + 1;
        }
        by = counts;
      }
      setText(popTotal.val, String(total));
      let key = '';
      for (const c of CASTE_ORDER) if ((by[c] ?? 0) > 0) key += c + ',';
      renderKeyed(castes, key, () => {
        casteVals.clear();
        const species = colony ? getSpecies(colony.species) : getSpecies(sim.options.faction);
        const out: Node[] = [];
        for (const c of CASTE_ORDER) {
          if (!((by[c] ?? 0) > 0)) continue;
          const v = h('span', undefined, { testid: `pop-${c}` }, '0');
          casteVals.set(c, v);
          out.push(h('span', 'mh-chip', { tip: species.castes[c]?.name ?? humanize(c) }, [icon(casteIcon(c)), v]));
        }
        return out;
      });
      for (const [c, v] of casteVals) setText(v, String(by[c as CasteId] ?? 0));

      setText(eggs.val, String(colony?.population.eggs ?? 0));
      setText(larvae.val, String(colony?.population.larvae ?? 0));
      setText(pupae.val, String(colony?.population.pupae ?? 0));

      // clock
      const w = sim.weather;
      // `?tod=` (A3's look debug, `globalThis.__myrmeLook`) overrides what the sky shows: follow it
      const forced = (globalThis as { __myrmeLook?: { timeOfDay?: number | null } }).__myrmeLook?.timeOfDay;
      const rawTod = typeof forced === 'number' && Number.isFinite(forced) ? forced : w.timeOfDay;
      const tod = ((rawTod % 1) + 1) % 1;
      const mins = Math.floor(tod * 24 * 60);
      const night = tod < 0.23 || tod > 0.79;
      const ci = night ? 'moon' : 'sun';
      if (ci !== lastClockIcon) {
        lastClockIcon = ci;
        clockIcon.replaceChildren(icon(ci));
      }
      setClass(clock, 'mh-night', night);
      // round to 10 minutes so the text changes rarely
      const m10 = Math.floor(mins / 10) * 10;
      setText(clockText, `Day ${Math.floor(w.day || 0) + 1} · ${String(Math.floor(m10 / 60)).padStart(2, '0')}:${String(m10 % 60).padStart(2, '0')}`);
      const wi = WEATHER_ICON[w.kind] ?? 'cloud';
      if (wi !== lastWeatherIcon) {
        lastWeatherIcon = wi;
        weatherIcon.replaceChildren(icon(wi));
      }
      // B2's phase label ("Thunderstorm", "Drizzle", "Indoors"…) where the weather system provides one
      setText(weatherText, `${weatherLabel(w)} ${Number.isFinite(w.temperature) ? Math.round(w.temperature) : '–'}°`);
      const fc = forecastLabel(w);
      const wTip = fc ? `Weather — ${fc}` : 'Weather';
      if (weather.dataset.tip !== wTip) weather.dataset.tip = wTip;

      setClass(bPause, 'mh-on', sim.paused);
      setClass(b1, 'mh-on', !sim.paused && sim.speed === 1);
      setClass(b2, 'mh-on', !sim.paused && sim.speed === 2);
      setClass(b4, 'mh-on', !sim.paused && sim.speed === 4);
    },
  };
}
