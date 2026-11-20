/**
 * In-game pause menu (B5 item 1): Esc when nothing else consumes it. Pauses the sim while open and
 * restores the previous pause state on resume.
 */
import { DIFFICULTY_INTENSITY } from '../core';
import { getSpecies } from '../sim/data/species';
import { getMap } from '../world/maps';
import { h, setText } from './dom';
import type { Feature, FeatureContext } from './features';

export interface PauseMenuFeature extends Feature {
  open(): void;
  close(): void;
  isOpen(): boolean;
}

export function createPauseMenu(ctx: FeatureContext): PauseMenuFeature {
  const { app, hud } = ctx;
  let modal: { close(): void } | null = null;
  let wasPaused = false;

  const setPaused = (p: boolean): void => {
    const api = ctx.input();
    if (api) api.setPaused(p);
    else app.command({ type: 'pause', paused: p });
  };

  function open(): void {
    if (modal) return;
    wasPaused = app.sim.paused;
    setPaused(true);
    ctx.audio?.ui('open');

    const sim = app.sim;
    const mapName = getMap(sim.mapId).name;
    const species = getSpecies(ctx.colony()?.species ?? sim.options.faction).name;
    const diff = ctx.options.difficulty;
    const info = `${mapName} · ${species} · seed ${sim.options.seed}${sim.goal.def.kind === 'sandbox' ? ' · sandbox' : ''}${sim.director.enabled ? ` · threat ×${(sim.director.intensity || DIFFICULTY_INTENSITY[diff]).toFixed(1)}` : ' · peaceful'}`;

    const item = (testid: string, label: string, onClick: () => void, opts: { primary?: boolean; confirm?: string; key?: string } = {}): HTMLButtonElement => {
      const text = h('span', undefined, null, label);
      const b = h('button', `mh-btn ms-menu-item${opts.primary ? ' mh-on' : ''}`, { type: 'button', testid }, [text, opts.key ? h('span', 'mh-kbd', null, opts.key) : null]);
      let armed = false;
      b.addEventListener('click', () => {
        if (opts.confirm && !armed) {
          armed = true;
          setText(text, opts.confirm);
          b.classList.add('ms-armed');
          ctx.audio?.ui('click');
          return;
        }
        ctx.audio?.ui(opts.primary ? 'confirm' : 'click');
        onClick();
      });
      b.addEventListener('pointerleave', () => {
        if (!armed) return;
        armed = false;
        setText(text, label);
        b.classList.remove('ms-armed');
      });
      return b;
    };

    const items: HTMLElement[] = [
      item('pause-resume', 'Resume', () => close(), { primary: true, key: ctx.hint('cancel') || 'Esc' }),
      item('pause-settings', 'Settings', () => ctx.shell.openSettings()),
      item('pause-controls', 'Controls', () => ctx.shell.openSettings('keys')),
      item('pause-codex', 'Field guide', () => ctx.shell.openCodex()),
    ];
    if (ctx.shell.hasMenu) {
      items.push(
        item(
          'pause-restart',
          'Restart colony',
          () => {
            closeSilently();
            ctx.shell.restart();
          },
          { confirm: 'Restart — this colony is lost. Click again' },
        ),
        item(
          'pause-quit',
          'Quit to menu',
          () => {
            closeSilently();
            ctx.shell.quitToMenu();
          },
          { confirm: 'Quit — this colony is lost. Click again' },
        ),
      );
    }

    const el = h('div', 'mh-panel mh-dialog ms-pause', { testid: 'pause-menu', role: 'dialog', 'aria-label': 'Paused' }, [
      h('div', 'ms-pause-title', null, [h('span', 'ms-wordmark ms-wordmark-sm', null, 'MYRME'), h('span', 'ms-pause-state', null, 'Paused')]),
      h('div', 'ms-pause-info mh-dim', { testid: 'pause-info' }, info),
      h('div', 'ms-menu-list', null, items),
    ]);
    modal = hud.openModal(el, {
      onClose: () => {
        modal = null;
        if (!silent) {
          if (!wasPaused) setPaused(false);
          ctx.audio?.ui('close');
        }
        silent = false;
      },
    });
    (items[0] as HTMLButtonElement).focus({ preventScroll: true });
  }

  let silent = false;
  /** Close without resuming (the game is about to be torn down). */
  function closeSilently(): void {
    silent = true;
    modal?.close();
  }

  function close(): void {
    modal?.close();
  }

  return {
    open,
    close,
    isOpen: () => modal !== null,
    dispose() {
      silent = true;
      modal?.close();
    },
  };
}
