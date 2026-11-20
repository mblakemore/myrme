/**
 * HUD stylesheet (injected once by `createUi`). Everything is sized in `em`; the root font-size
 * is set from the viewport height (≈11.5px at 540 → 14px at 1080) so the HUD stays crisp and
 * proportionate at 960×540 and 1920×1080.
 */
export const HUD_CSS = `
.myrme-hud {
  --mh-bg: rgba(14, 19, 17, .72);
  --mh-bg-solid: rgba(16, 22, 19, .93);
  --mh-bg-hi: rgba(255, 255, 255, .07);
  --mh-border: rgba(214, 236, 200, .14);
  --mh-border-hi: rgba(214, 236, 200, .32);
  --mh-text: #e9efe4;
  --mh-dim: #9aa898;
  --mh-accent: #9fd86b;
  --mh-accent-ink: #15220c;
  --mh-amber: #f0b54a;
  --mh-red: #ef6f61;
  --mh-blue: #6cc3f2;
  --mh-violet: #b99cf0;
  --mh-radius: .55em;
  position: fixed; inset: 0; z-index: 10; pointer-events: none; overflow: hidden;
  font: 400 12px/1.35 Inter, "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif;
  font-variant-numeric: tabular-nums; color: var(--mh-text);
  -webkit-font-smoothing: antialiased; user-select: none; -webkit-user-select: none;
}
.myrme-hud *, .myrme-hud *::before, .myrme-hud *::after { box-sizing: border-box; }
.myrme-hud .mh-hidden { display: none !important; }
.myrme-hud .mh-icon { width: 1.25em; height: 1.25em; flex: none; display: block; }
.myrme-hud .mh-dim { color: var(--mh-dim); }
.myrme-hud .mh-row { display: flex; align-items: center; gap: .45em; }
.myrme-hud .mh-grow { flex: 1 1 auto; min-width: 0; }

.myrme-hud .mh-panel {
  pointer-events: auto; background: var(--mh-bg); border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius); box-shadow: 0 .3em 1.2em rgba(0, 0, 0, .35), inset 0 1px 0 rgba(255, 255, 255, .05);
  backdrop-filter: blur(9px) saturate(1.15); -webkit-backdrop-filter: blur(9px) saturate(1.15);
}
.myrme-hud .mh-panel-head {
  display: flex; align-items: center; gap: .45em; padding: .4em .7em; font-weight: 600; letter-spacing: .04em;
  text-transform: uppercase; font-size: .82em; color: var(--mh-dim); border-bottom: 1px solid var(--mh-border);
}
.myrme-hud .mh-panel-head.mh-click { cursor: pointer; }
.myrme-hud .mh-panel-head.mh-click:hover { color: var(--mh-text); }
.myrme-hud .mh-panel-head .mh-chev { margin-left: auto; transition: transform .15s; width: 1em; height: 1em; }
.myrme-hud .mh-collapsed > .mh-panel-head { border-bottom-color: transparent; }
.myrme-hud .mh-collapsed > .mh-panel-head .mh-chev { transform: rotate(-90deg); }
.myrme-hud .mh-collapsed > .mh-panel-body { display: none; }
.myrme-hud .mh-panel-body { padding: .55em .7em .65em; }

.myrme-hud .mh-btn {
  pointer-events: auto; appearance: none; font: inherit; color: var(--mh-text); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: .35em;
  background: var(--mh-bg-hi); border: 1px solid var(--mh-border); border-radius: .4em; padding: .3em .6em;
  transition: background .12s, border-color .12s, color .12s, transform .06s; outline: none;
}
.myrme-hud .mh-btn:hover { background: rgba(255, 255, 255, .14); border-color: var(--mh-border-hi); }
.myrme-hud .mh-btn:active { transform: translateY(1px); }
.myrme-hud .mh-btn:focus-visible { border-color: var(--mh-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--mh-accent) 45%, transparent); }
.myrme-hud input:focus-visible, .myrme-hud select:focus-visible, .myrme-hud [tabindex]:focus-visible { outline: 2px solid var(--mh-accent); outline-offset: 2px; }
.myrme-hud .mh-btn.mh-on { background: var(--mh-accent); border-color: var(--mh-accent); color: var(--mh-accent-ink); }
.myrme-hud .mh-btn[disabled] { opacity: .4; cursor: default; }

.myrme-hud .mh-kbd {
  display: inline-block; min-width: 1.5em; padding: 0 .35em; text-align: center; font-size: .82em; line-height: 1.45;
  border: 1px solid var(--mh-border-hi); border-bottom-width: 2px; border-radius: .3em; background: rgba(0, 0, 0, .35);
  color: var(--mh-text); white-space: nowrap;
}
.myrme-hud .mh-chip {
  display: inline-flex; align-items: center; gap: .3em; padding: .1em .5em .1em .35em; border-radius: 1em;
  background: var(--mh-bg-hi); border: 1px solid transparent; white-space: nowrap;
}
.myrme-hud button.mh-chip { pointer-events: auto; appearance: none; font: inherit; color: inherit; cursor: pointer; }
.myrme-hud button.mh-chip:hover { border-color: var(--mh-border-hi); }
.myrme-hud .mh-bar { height: .5em; border-radius: .3em; background: rgba(0, 0, 0, .45); overflow: hidden; flex: 1 1 auto; min-width: 2em; }
.myrme-hud .mh-bar > i { display: block; height: 100%; width: 100%; transform-origin: 0 50%; background: var(--mh-accent); border-radius: inherit; transition: transform .2s; }
.myrme-hud .mh-bar.mh-energy > i { background: var(--mh-amber); }
.myrme-hud .mh-bar.mh-low > i { background: var(--mh-red); }

/* ---- top bar ---- */
.myrme-hud .mh-top {
  position: absolute; left: .6em; right: .6em; top: .5em; height: 2.5em; padding: 0 .35em 0 .8em;
  display: flex; align-items: center; gap: 1.1em; white-space: nowrap;
}
.myrme-hud .mh-top .mh-group { display: flex; align-items: center; gap: .5em; }
.myrme-hud .mh-top .mh-sep { width: 1px; align-self: stretch; margin: .5em 0; background: var(--mh-border); }
.myrme-hud .mh-stat { display: inline-flex; align-items: center; gap: .3em; }
.myrme-hud .mh-stat b { font-weight: 600; font-size: 1.08em; }
.myrme-hud .mh-stat.mh-food { color: var(--mh-amber); }
.myrme-hud .mh-stat.mh-pop { color: var(--mh-accent); }
.myrme-hud .mh-stat.mh-brood { color: #e6dfc8; }
.myrme-hud .mh-stat.mh-garden { color: #cfe3a8; }
.myrme-hud .mh-stat.mh-garden b { text-transform: capitalize; }
.myrme-hud .mh-stat.mh-cautionc { color: var(--mh-amber); }
.myrme-hud .mh-stat.mh-warnc { color: var(--mh-red); }
.myrme-hud .mh-top .mh-clock { color: #f4e2a8; }
.myrme-hud .mh-top .mh-clock.mh-night { color: #a9c0f0; }
.myrme-hud .mh-top .mh-weather { color: var(--mh-blue); }
.myrme-hud .mh-speed { display: flex; gap: .2em; margin-left: auto; }
.myrme-hud .mh-speed .mh-btn { min-width: 2.3em; height: 1.8em; padding: 0 .4em; font-weight: 600; }
.myrme-hud .mh-speed .mh-btn .mh-icon { width: 1.05em; height: 1.05em; }
.myrme-hud .mh-speed .mh-btn.mh-on.mh-paused { background: var(--mh-amber); border-color: var(--mh-amber); }

/* ---- docks / slots ---- */
.myrme-hud .mh-slot { display: flex; pointer-events: none; }
.myrme-hud .mh-slot > * { pointer-events: auto; }
.myrme-hud .mh-dock-tl { position: absolute; left: .6em; top: 3.5em; flex-direction: column; align-items: flex-start; gap: .45em; max-width: 24em; }
.myrme-hud .mh-dock-tr { position: absolute; right: .6em; top: 3.5em; flex-direction: column; align-items: flex-end; gap: .45em; max-width: 24em; }
.myrme-hud .mh-slot-goal, .myrme-hud .mh-slot-topLeft, .myrme-hud .mh-slot-topRight { flex-direction: column; gap: .45em; }
.myrme-hud .mh-slot-topRight { align-items: flex-end; }
.myrme-hud .mh-slot-left { position: absolute; left: .6em; top: 50%; transform: translateY(-50%); flex-direction: column; gap: .45em; }
.myrme-hud .mh-slot-right { position: absolute; right: .6em; bottom: 5.1em; flex-direction: column; align-items: flex-end; gap: .45em; }
.myrme-hud .mh-slot-bottomRight { flex-direction: row; align-items: flex-end; gap: .45em; }
.myrme-hud .mh-slot-overlay { position: absolute; inset: 0; }
.myrme-hud .mh-slot-overlay > * { pointer-events: none; }
.myrme-hud .mh-slot-modal { position: absolute; inset: 0; align-items: center; justify-content: center; }
.myrme-hud .mh-slot-modal.mh-open { pointer-events: auto; background: rgba(4, 8, 6, .5); }
.myrme-hud .mh-dialog { max-width: 94%; max-height: 90%; overflow: auto; background: var(--mh-bg-solid); }
.myrme-hud .mh-bottom { position: absolute; left: .6em; right: .6em; bottom: .6em; display: flex; align-items: flex-end; gap: .6em; pointer-events: none; }

/* ---- goal ---- */
.myrme-hud .mh-goal { padding: .3em .7em; display: flex; align-items: center; gap: .5em; color: var(--mh-text); }
.myrme-hud .mh-goal .mh-icon { color: var(--mh-amber); }
.myrme-hud .mh-goal .mh-bar { width: 6em; flex: none; }
.myrme-hud .mh-goal.mh-won { border-color: var(--mh-accent); }
.myrme-hud .mh-goal.mh-lost { border-color: var(--mh-red); }

/* ---- alerts ---- */
.myrme-hud .mh-alerts { display: flex; flex-direction: column; align-items: flex-end; gap: .35em; pointer-events: none; }
.myrme-hud .mh-alert {
  pointer-events: auto; display: flex; align-items: center; gap: .5em; padding: .35em .7em .35em .55em; max-width: 23em;
  border-left: .25em solid var(--mh-blue); animation: mh-in .25s ease-out; transition: opacity .6s;
}
.myrme-hud .mh-alert.mh-jump { cursor: pointer; }
.myrme-hud .mh-alert.mh-jump:hover { border-color: var(--mh-border-hi); border-left-color: inherit; background: rgba(30, 40, 34, .85); }
.myrme-hud .mh-alert.mh-fade { opacity: 0; }
.myrme-hud .mh-alert .mh-icon { color: var(--mh-blue); }
.myrme-hud .mh-alert.mh-sev-good { border-left-color: var(--mh-accent); } .myrme-hud .mh-alert.mh-sev-good .mh-icon { color: var(--mh-accent); }
.myrme-hud .mh-alert.mh-sev-warn { border-left-color: var(--mh-amber); } .myrme-hud .mh-alert.mh-sev-warn .mh-icon { color: var(--mh-amber); }
.myrme-hud .mh-alert.mh-sev-danger { border-left-color: var(--mh-red); } .myrme-hud .mh-alert.mh-sev-danger .mh-icon { color: var(--mh-red); }
.myrme-hud .mh-alert .mh-count { color: var(--mh-dim); font-size: .85em; }
@keyframes mh-in { from { opacity: 0; transform: translateX(1.2em); } to { opacity: 1; transform: none; } }

/* ---- minimap ---- */
.myrme-hud .mh-minimap { padding: .3em; flex: none; line-height: 0; position: relative; }
.myrme-hud .mh-minimap canvas { display: block; border-radius: .35em; cursor: crosshair; background: #0b100d; }
.myrme-hud .mh-minimap .mh-mm-label { position: absolute; left: .7em; top: .55em; font-size: .75em; line-height: 1.2; color: rgba(255,255,255,.6); text-transform: uppercase; letter-spacing: .08em; pointer-events: none; text-shadow: 0 1px 2px #000; }

/* ---- selection panel ---- */
.myrme-hud .mh-selwrap { width: 19em; flex: none; display: flex; align-items: flex-end; pointer-events: none; }
.myrme-hud .mh-sel { width: 100%; padding: .55em .7em .6em; }
.myrme-hud .mh-sel .mh-title { display: flex; align-items: center; gap: .45em; font-weight: 600; font-size: 1.08em; margin-bottom: .35em; }
.myrme-hud .mh-sel .mh-title .mh-icon { color: var(--mh-accent); }
.myrme-hud .mh-sel .mh-badge { margin-left: auto; font-size: .78em; font-weight: 600; padding: .05em .5em; border-radius: .9em; background: rgba(159, 216, 107, .18); color: var(--mh-accent); }
.myrme-hud .mh-sel .mh-badge.mh-bad { background: rgba(239, 111, 97, .2); color: var(--mh-red); }
.myrme-hud .mh-kv { display: grid; grid-template-columns: 4.6em 1fr; align-items: center; column-gap: .5em; row-gap: .22em; }
.myrme-hud .mh-kv > span:nth-child(odd) { color: var(--mh-dim); font-size: .9em; }
.myrme-hud .mh-kv .mh-val { display: flex; align-items: center; gap: .45em; min-width: 0; }
.myrme-hud .mh-kv .mh-val > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.myrme-hud .mh-queue { display: flex; flex-wrap: wrap; align-items: center; gap: .25em; min-height: 1.5em; }
.myrme-hud .mh-task { padding: 0 .45em; border-radius: .3em; background: var(--mh-bg-hi); font-size: .9em; white-space: nowrap; }
.myrme-hud .mh-task.mh-player { background: rgba(159, 216, 107, .2); color: var(--mh-accent); }
.myrme-hud .mh-task.mh-cur { outline: 1px solid var(--mh-border-hi); }
.myrme-hud .mh-arrow { color: var(--mh-dim); font-size: .85em; }
.myrme-hud .mh-chips { display: flex; flex-wrap: wrap; gap: .3em; margin: .1em 0 .45em; }
.myrme-hud .mh-actions { display: flex; gap: .3em; margin-top: .55em; }
.myrme-hud .mh-actions .mh-btn { flex: 1 1 auto; min-width: 0; padding: .3em .35em; font-size: .9em; white-space: nowrap; overflow: hidden; }
.myrme-hud .mh-actions .mh-btn.mh-icononly { flex: 0 0 auto; padding: .3em .45em; }
.myrme-hud .mh-actions .mh-btn .mh-icon { width: 1.05em; height: 1.05em; }
.myrme-hud .mh-actions .mh-btn.mh-danger:hover { border-color: var(--mh-red); color: var(--mh-red); }

/* ---- toolbar ---- */
.myrme-hud .mh-toolwrap { margin: 0 auto; display: flex; flex-direction: column; align-items: center; gap: .4em; pointer-events: none; min-width: 0; }
.myrme-hud .mh-toolhint { padding: .25em .8em; font-size: .92em; white-space: nowrap; color: var(--mh-text); }
.myrme-hud .mh-toolbar { display: flex; align-items: stretch; gap: .2em; padding: .35em; }
.myrme-hud .mh-tool {
  width: 2.5em; height: 3.1em; padding: .25em 0 .1em; flex-direction: column; gap: .05em; border-radius: .45em; position: relative;
  --tool: var(--mh-accent);
}
.myrme-hud .mh-tool .mh-icon { width: 1.45em; height: 1.45em; color: var(--tool); }
.myrme-hud .mh-tool .mh-hint { font-size: .68em; line-height: 1.1; color: var(--mh-dim); letter-spacing: .02em; }
.myrme-hud .mh-tool.mh-on { background: color-mix(in srgb, var(--tool) 26%, transparent); border-color: var(--tool); color: var(--mh-text); }
.myrme-hud .mh-tool.mh-on .mh-hint { color: var(--mh-text); }
.myrme-hud .mh-tool.mh-small { width: 1.7em; }
.myrme-hud .mh-tool.mh-small .mh-icon { width: 1em; height: 1em; color: var(--mh-text); }
.myrme-hud .mh-brush { display: flex; flex-direction: column; align-items: center; justify-content: center; width: 2.2em; font-size: .9em; line-height: 1.15; }
.myrme-hud .mh-brush b { font-weight: 600; }
.myrme-hud .mh-brush span { font-size: .72em; color: var(--mh-dim); }
.myrme-hud .mh-toolbar .mh-sep { width: 1px; margin: .3em .2em; background: var(--mh-border); }
.myrme-hud .mh-b-gather { --tool: var(--mh-amber); }
.myrme-hud .mh-b-dig { --tool: #c9a57a; }
.myrme-hud .mh-b-rally { --tool: var(--mh-accent); }
.myrme-hud .mh-b-attack { --tool: var(--mh-red); }
.myrme-hud .mh-b-avoid { --tool: var(--mh-violet); }
.myrme-hud .mh-t-phero { --tool: var(--mh-violet); }
.myrme-hud .mh-t-cut { --tool: var(--mh-blue); }
.myrme-hud .mh-t-erase { --tool: var(--mh-red); }
.myrme-hud .mh-t-neutral { --tool: var(--mh-text); }

/* ---- quick panel ---- */
.myrme-hud .mh-quick { width: 15.5em; }
.myrme-hud .mh-slider { display: grid; grid-template-columns: 4.2em 1fr 2.6em; align-items: center; gap: .5em; margin: .12em 0; }
.myrme-hud .mh-slider label { color: var(--mh-dim); font-size: .92em; }
.myrme-hud .mh-slider output { text-align: right; font-size: .9em; }
.myrme-hud .mh-quick .mh-subhead { margin: .55em 0 .2em; padding-top: .45em; border-top: 1px solid var(--mh-border); color: var(--mh-dim); font-size: .8em; text-transform: uppercase; letter-spacing: .05em; }
.myrme-hud input[type=range] {
  pointer-events: auto; -webkit-appearance: none; appearance: none; width: 100%; height: 1.2em; background: transparent; margin: 0; cursor: pointer; --fill: 50%; --col: var(--mh-accent);
}
.myrme-hud input[type=range]::-webkit-slider-runnable-track { height: .36em; border-radius: .2em; background: linear-gradient(to right, var(--col) var(--fill), rgba(0, 0, 0, .5) var(--fill)); }
.myrme-hud input[type=range]::-moz-range-track { height: .36em; border-radius: .2em; background: linear-gradient(to right, var(--col) var(--fill), rgba(0, 0, 0, .5) var(--fill)); }
.myrme-hud input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: .95em; height: .95em; margin-top: -.3em; border-radius: 50%; background: #f2f6ee; border: 2px solid var(--col); box-shadow: 0 1px 3px rgba(0, 0, 0, .5); }
.myrme-hud input[type=range]::-moz-range-thumb { width: .8em; height: .8em; border-radius: 50%; background: #f2f6ee; border: 2px solid var(--col); }
.myrme-hud input[type=range]:focus { outline: none; }
.myrme-hud input[type=range]:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 3px color-mix(in srgb, var(--col) 45%, transparent); }
.myrme-hud .mh-slider.mh-s-forage input { --col: var(--mh-amber); }
.myrme-hud .mh-slider.mh-s-dig input { --col: #c9a57a; }
.myrme-hud .mh-slider.mh-s-nurse input { --col: #e6dfc8; }
.myrme-hud .mh-slider.mh-s-defend input { --col: var(--mh-red); }

/* ---- possession ---- */
.myrme-hud .mh-possess { position: absolute; left: 50%; bottom: .6em; transform: translateX(-50%); width: 34em; max-width: 96%; padding: .55em .8em .6em; }
.myrme-hud .mh-possess .mh-title { display: flex; align-items: center; gap: .45em; font-weight: 600; font-size: 1.08em; }
.myrme-hud .mh-possess .mh-title .mh-icon { color: var(--mh-amber); }
.myrme-hud .mh-possess .mh-title .mh-viewmode { margin-left: auto; font-weight: 400; font-size: .85em; color: var(--mh-dim); }
.myrme-hud .mh-possess .mh-bars { display: grid; grid-template-columns: auto 1fr auto 1fr; align-items: center; gap: .35em .6em; margin: .4em 0; }
.myrme-hud .mh-possess .mh-bars > span { color: var(--mh-dim); font-size: .9em; }
.myrme-hud .mh-possess .mh-facts { display: flex; flex-wrap: wrap; gap: .25em 1.1em; font-size: .95em; }
.myrme-hud .mh-possess .mh-facts span b { font-weight: 500; }
.myrme-hud .mh-possess .mh-facts .mh-on { color: var(--mh-accent); }
.myrme-hud .mh-possess .mh-resume { margin-top: .35em; display: flex; flex-wrap: wrap; align-items: center; gap: .25em; font-size: .95em; }
.myrme-hud .mh-possess .mh-hints { margin-top: .5em; padding-top: .45em; border-top: 1px solid var(--mh-border); display: flex; flex-wrap: wrap; gap: .3em .9em; font-size: .88em; color: var(--mh-dim); }
.myrme-hud .mh-possess .mh-hints span { white-space: nowrap; }
.myrme-hud .mh-capture { position: absolute; left: 50%; top: 58%; transform: translateX(-50%); padding: .35em .9em; display: flex; align-items: center; gap: .5em; pointer-events: none; }
.myrme-hud .mh-reticle { position: absolute; left: 50%; top: 50%; width: .55em; height: .55em; margin: -.275em; border-radius: 50%; border: 1px solid rgba(255, 255, 255, .8); box-shadow: 0 0 2px rgba(0, 0, 0, .8); }
.myrme-hud .mh-dragbox { position: absolute; left: 0; top: 0; border: 1px solid var(--mh-accent); background: rgba(159, 216, 107, .12); border-radius: 2px; will-change: transform, width, height; }

/* ---- tooltip ---- */
.myrme-hud .mh-tooltip { position: absolute; left: 0; top: 0; padding: .3em .6em; max-width: 20em; font-size: .93em; pointer-events: none; background: var(--mh-bg-solid); z-index: 5; will-change: transform; }
.myrme-hud .mh-tooltip .mh-tt-title { font-weight: 600; display: flex; align-items: center; gap: .4em; }
.myrme-hud .mh-tooltip .mh-tt-title.mh-hostile { color: var(--mh-red); }
.myrme-hud .mh-tooltip .mh-tt-sub { color: var(--mh-dim); }
.myrme-hud .mh-tooltip .mh-tt-verb { margin-top: .15em; color: var(--mh-accent); display: flex; align-items: center; gap: .35em; }
.myrme-hud .mh-tooltip .mh-bar { width: 7em; margin: .2em 0 .1em; }

/* ---- help ---- */
.myrme-hud .mh-help { width: 68em; padding: 0; display: flex; flex-direction: column; overflow: hidden; }
.myrme-hud .mh-help .mh-help-scroll { overflow-y: auto; min-height: 0; flex: 1 1 auto; overscroll-behavior: contain; }
.myrme-hud .mh-help .mh-panel-head, .myrme-hud .mh-help .mh-help-foot { flex: none; }
.myrme-hud .mh-help .mh-panel-head { font-size: .95em; padding: .6em 1em; }
.myrme-hud .mh-help .mh-help-body { columns: 3; column-gap: 1.6em; padding: .8em 1em .4em; }
.myrme-hud .mh-help section { break-inside: avoid; margin-bottom: .9em; }
.myrme-hud .mh-help h4 { margin: 0 0 .3em; font-size: .8em; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--mh-accent); }
.myrme-hud .mh-help .mh-hrow { display: flex; align-items: baseline; gap: .5em; padding: .1em 0; }
.myrme-hud .mh-help .mh-hrow > span:first-child { flex: 1 1 auto; color: var(--mh-text); font-size: .93em; }
.myrme-hud .mh-help .mh-hkeys { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .2em; flex: none; max-width: 60%; }
.myrme-hud .mh-help .mh-help-foot { display: flex; align-items: center; gap: 1.2em; padding: .55em 1em; border-top: 1px solid var(--mh-border); color: var(--mh-dim); font-size: .92em; }
.myrme-hud .mh-help label { pointer-events: auto; display: inline-flex; align-items: center; gap: .4em; cursor: pointer; color: var(--mh-text); }
.myrme-hud .mh-help input[type=checkbox] { accent-color: var(--mh-accent); width: 1.1em; height: 1.1em; margin: 0; }
.myrme-hud .mh-x { margin-left: auto; width: 1.9em; height: 1.9em; padding: 0; }
@media (max-width: 900px) { .myrme-hud .mh-help .mh-help-body { columns: 2; } }

@media (prefers-reduced-motion: reduce) {
  .myrme-hud *, .myrme-hud *::before, .myrme-hud *::after { animation-duration: .001s !important; animation-iteration-count: 1 !important; transition-duration: .001s !important; }
}
.myrme-hud.mh-reduced *, .myrme-hud.mh-reduced *::before, .myrme-hud.mh-reduced *::after { animation-duration: .001s !important; animation-iteration-count: 1 !important; transition-duration: .001s !important; }

/* ---- debug ---- */
.myrme-hud .mh-debug { position: absolute; left: .6em; top: 8.6em; padding: .45em .7em; font: 400 .9em/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; pointer-events: none; color: #cfe6c2; }
`;

let styleEl: HTMLStyleElement | null = null;
let styleRefs = 0;
const extraCss: string[] = [];

/** Register more CSS to ship in the shared HUD stylesheet (shell screens). Call before the first acquire. */
export function registerHudCss(css: string): void {
  if (extraCss.includes(css)) return;
  extraCss.push(css);
  if (styleEl) styleEl.textContent = HUD_CSS + extraCss.join('\n');
}

/**
 * Ref-counted injection of the HUD stylesheet: the in-game HUD and the app shell (menu, loading
 * screen) share one `<style>` element. Returns the release function.
 */
export function acquireHudStyles(): () => void {
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.dataset.myrme = 'hud';
    styleEl.textContent = HUD_CSS + extraCss.join('\n');
    document.head.appendChild(styleEl);
  }
  styleRefs++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--styleRefs <= 0) {
      styleRefs = 0;
      styleEl?.remove();
      styleEl = null;
    }
  };
}
