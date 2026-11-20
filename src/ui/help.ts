import type { HudContext } from './context';
import { h } from './dom';
import { getSettings } from './settingsStore';
import { icon } from './icons';

/**
 * Keybind help overlay content, built from the live keymap (so rebinding shows up). Returns the
 * dialog element; the caller owns showing / hiding it.
 */
export function buildHelp(ctx: HudContext, close: () => void): HTMLElement {
  const api = ctx.api();
  const body = h('div', 'mh-help-body');
  if (api) {
    for (const g of api.keymap.helpRows()) {
      const rows = g.rows.filter((r) => r.keys.length > 0);
      if (!rows.length) continue;
      body.append(
        h('section', undefined, null, [
          h('h4', undefined, null, g.group),
          ...rows.map((r) =>
            h('div', 'mh-hrow', null, [
              h('span', undefined, null, r.label),
              h(
                'span',
                'mh-hkeys',
                null,
                r.keys.map((k) => h('span', 'mh-kbd', null, k)),
              ),
            ]),
          ),
        ]),
      );
    }
  } else {
    body.append(h('div', 'mh-dim', null, 'Key bindings are unavailable.'));
  }

  const x = h('button', 'mh-btn mh-x', { type: 'button', 'aria-label': 'Close' }, [icon('close')]);
  ctx.d.on(x, 'click', close);

  const edge = h('input', undefined, { type: 'checkbox', 'data-testid': 'opt-edge-scroll' });
  edge.checked = !!api?.settings.edgeScroll;
  ctx.d.on(edge, 'change', () => {
    // through the settings store: persisted, and the Game applies it to the input layer
    getSettings().patch('controls', { edgeScroll: edge.checked });
    const a = ctx.api();
    if (a) a.settings.edgeScroll = edge.checked;
    edge.blur();
  });
  const invert = h('input', undefined, { type: 'checkbox', 'data-testid': 'opt-invert-y' });
  invert.checked = !!api?.settings.invertY;
  ctx.d.on(invert, 'change', () => {
    getSettings().patch('controls', { invertY: invert.checked });
    const a = ctx.api();
    if (a) a.settings.invertY = invert.checked;
    invert.blur();
  });

  return h('div', 'mh-panel mh-dialog mh-help', { testid: 'help', role: 'dialog', 'aria-label': 'Keys and help' }, [
    h('div', 'mh-panel-head', null, [icon('help'), h('span', undefined, null, 'Keys & help'), x]),
    h('div', 'mh-help-scroll', null, [body]),
    h('div', 'mh-help-foot', null, [
      h('label', undefined, null, [edge, 'Edge-scroll camera']),
      h('label', undefined, null, [invert, 'Invert mouse Y (possession)']),
      h('span', 'mh-grow'),
      h('span', undefined, null, [h('span', 'mh-kbd', null, ctx.hint('cancel') || 'Esc'), ' close']),
    ]),
  ]);
}
