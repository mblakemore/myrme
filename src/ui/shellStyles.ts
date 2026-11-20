/**
 * Stylesheet of the B5 shell: title menu, new-game flow, loading screen, pause menu, settings,
 * end screens, tutorial coach marks. Shipped inside the shared HUD `<style>` (see `styles.ts`
 * `registerHudCss`); everything is scoped under `.myrme-hud` so the HUD variables apply, sized in
 * `em`, and prefixed `ms-`.
 */
export const SHELL_CSS = `
/* ================= shared bits ================= */
.myrme-hud .mh-slot-modal > :not(:last-child) { display: none; }
.myrme-hud.ms-world-lost .mh-slot-modal.mh-open { background: rgba(6, 6, 8, .62); backdrop-filter: grayscale(.92) brightness(.72) contrast(1.05); -webkit-backdrop-filter: grayscale(.92) brightness(.72) contrast(1.05); }
.myrme-hud .ms-topmenu { min-width: 2.3em; height: 1.8em; padding: 0 .4em; margin-left: .35em; }
.myrme-hud .ms-topmenu .mh-icon { width: 1.05em; height: 1.05em; }
.myrme-hud .ms-col { display: flex; flex-direction: column; gap: .35em; align-items: flex-start; }
.myrme-hud .ms-danger:hover { border-color: var(--mh-red); color: var(--mh-red); }

.myrme-hud .ms-wordmark {
  font-weight: 200; letter-spacing: .46em; margin-right: -.46em; line-height: 1; color: #f3f7ee; white-space: nowrap;
  text-shadow: 0 .04em .5em rgba(0, 0, 0, .55);
}
.myrme-hud .ms-wordmark b { font-weight: 600; color: var(--mh-accent); }
.myrme-hud .ms-wordmark-sm { font-size: 1.5em; font-weight: 300; letter-spacing: .38em; margin-right: -.38em; }

/* segmented control / switch / slider rows (settings + new game) */
.myrme-hud .ms-seg { display: inline-flex; gap: 0; border-radius: .45em; background: rgba(0, 0, 0, .3); padding: .16em; border: 1px solid var(--mh-border); }
.myrme-hud .ms-seg .mh-btn { border: 1px solid transparent; background: transparent; border-radius: .32em; padding: .28em .8em; color: var(--mh-dim); }
.myrme-hud .ms-seg .mh-btn:hover { color: var(--mh-text); background: var(--mh-bg-hi); }
.myrme-hud .ms-seg .mh-btn.mh-on { background: var(--mh-accent); color: var(--mh-accent-ink); font-weight: 600; }
.myrme-hud .ms-seg .mh-btn[disabled].mh-on { opacity: .75; }
.myrme-hud .ms-switch { pointer-events: auto; position: relative; display: inline-block; width: 2.6em; height: 1.4em; cursor: pointer; }
.myrme-hud .ms-switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; width: 100%; height: 100%; }
.myrme-hud .ms-switch i { position: absolute; inset: 0; border-radius: 1em; background: rgba(0, 0, 0, .45); border: 1px solid var(--mh-border-hi); transition: background .15s, border-color .15s; pointer-events: none; }
.myrme-hud .ms-switch i::after { content: ''; position: absolute; left: .16em; top: 50%; width: .95em; height: .95em; margin-top: -.475em; border-radius: 50%; background: #dfe6d8; transition: transform .15s; }
.myrme-hud .ms-switch input:checked + i { background: color-mix(in srgb, var(--mh-accent) 70%, transparent); border-color: var(--mh-accent); }
.myrme-hud .ms-switch input:checked + i::after { transform: translateX(1.18em); background: #fff; }
.myrme-hud .ms-switch input:focus-visible + i { box-shadow: 0 0 0 2px color-mix(in srgb, var(--mh-accent) 55%, transparent); }
.myrme-hud .ms-slider { display: grid; grid-template-columns: minmax(8em, 15em) 3.4em; align-items: center; gap: .7em; }
.myrme-hud .ms-slider output { text-align: right; color: var(--mh-text); }

/* ================= settings ================= */
.myrme-hud .ms-settings { width: 52em; max-width: 96%; height: 34em; max-height: 92%; padding: 0; display: flex; flex-direction: column; overflow: hidden; }
.myrme-hud .ms-settings > .mh-panel-head { font-size: .95em; padding: .6em 1em; flex: none; }
.myrme-hud .ms-tabs { display: flex; gap: .25em; padding: .55em 1em 0; border-bottom: 1px solid var(--mh-border); flex: none; }
.myrme-hud .ms-tabs .mh-btn { border-radius: .4em .4em 0 0; border-bottom-color: transparent; background: transparent; color: var(--mh-dim); padding: .38em .95em; margin-bottom: -1px; }
.myrme-hud .ms-tabs .mh-btn:hover { color: var(--mh-text); }
.myrme-hud .ms-tabs .mh-btn.mh-on { background: var(--mh-bg-hi); color: var(--mh-text); border-color: var(--mh-border); border-bottom-color: transparent; box-shadow: inset 0 2px 0 var(--mh-accent); }
.myrme-hud .ms-set-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: .5em 1em .8em; overscroll-behavior: contain; }
.myrme-hud .ms-set-row { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 1.5em; padding: .62em 0; border-bottom: 1px solid rgba(214, 236, 200, .07); }
.myrme-hud .ms-set-row:last-child { border-bottom: 0; }
.myrme-hud .ms-set-label { display: flex; flex-direction: column; gap: .12em; min-width: 0; }
.myrme-hud .ms-set-label small, .myrme-hud .ms-set-note { color: var(--mh-dim); font-size: .88em; }
.myrme-hud .ms-set-control { display: flex; justify-content: flex-end; }
.myrme-hud .ms-set-foot { display: flex; align-items: center; gap: 1em; padding: .55em 1em; border-top: 1px solid var(--mh-border); flex: none; font-size: .92em; }
.myrme-hud .ms-set-foot .mh-btn { padding: .35em 1.4em; font-weight: 600; }
/* keys */
.myrme-hud .ms-keys-head { display: flex; align-items: center; gap: 1em; padding: .25em 0 .5em; }
.myrme-hud .ms-keys-note { flex: 1 1 auto; color: var(--mh-dim); font-size: .9em; }
.myrme-hud .ms-keys-note.ms-warn { color: var(--mh-amber); }
.myrme-hud .ms-key-conflict { display: flex; align-items: center; gap: .6em; padding: .45em .7em; margin-bottom: .5em; border-radius: .45em; border: 1px solid var(--mh-amber); background: rgba(240, 181, 74, .12); }
.myrme-hud .ms-key-conflict .mh-icon { color: var(--mh-amber); }
.myrme-hud .ms-key-groups { columns: 2; column-gap: 1.6em; }
.myrme-hud .ms-key-group { break-inside: avoid; margin-bottom: .9em; }
.myrme-hud .ms-key-group h4 { margin: 0 0 .25em; font-size: .78em; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--mh-accent); }
.myrme-hud .ms-key-row { display: grid; grid-template-columns: 1fr 4.7em 4.7em 1.5em; align-items: center; gap: .3em; padding: .12em 0; }
.myrme-hud .ms-key-label { font-size: .93em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.myrme-hud .ms-key-label small { display: none; }
.myrme-hud .ms-key { padding: .18em .3em; font-size: .88em; min-width: 0; white-space: nowrap; overflow: hidden; border-bottom-width: 2px; background: rgba(0, 0, 0, .3); }
.myrme-hud .ms-key.ms-empty { color: var(--mh-dim); border-style: dashed; border-bottom-width: 1px; background: transparent; }
.myrme-hud .ms-key.ms-unbound { color: var(--mh-amber); border-color: var(--mh-amber); }
.myrme-hud .ms-key.ms-capturing { border-color: var(--mh-accent); color: var(--mh-accent); background: rgba(159, 216, 107, .14); animation: ms-pulse 1s ease-in-out infinite; }
.myrme-hud .ms-key-reset { padding: 0; width: 1.7em; height: 1.6em; opacity: 0; font-size: .95em; }
.myrme-hud .ms-key-row.ms-custom .ms-key-reset { opacity: 1; }
.myrme-hud .ms-key-row.ms-custom .ms-key-label { color: var(--mh-accent); }
@keyframes ms-pulse { 50% { opacity: .55; } }

/* ================= pause ================= */
.myrme-hud .ms-pause { width: 21em; padding: 1.5em 1.5em 1.3em; text-align: center; }
.myrme-hud .ms-pause-title { display: flex; flex-direction: column; align-items: center; gap: .5em; }
.myrme-hud .ms-pause-state { font-size: .8em; letter-spacing: .3em; text-transform: uppercase; color: var(--mh-amber); margin-right: -.3em; }
.myrme-hud .ms-pause-info { margin: .7em 0 1.1em; font-size: .88em; }
.myrme-hud .ms-menu-list { display: flex; flex-direction: column; gap: .4em; }
.myrme-hud .ms-menu-item { justify-content: space-between; padding: .55em .9em; font-size: 1.04em; text-align: left; }
.myrme-hud .ms-menu-item .mh-kbd { background: rgba(0, 0, 0, .2); }
.myrme-hud .ms-menu-item.ms-armed { border-color: var(--mh-red); color: var(--mh-red); font-size: .92em; }

/* ================= end screens ================= */
.myrme-hud .ms-end-banner { position: absolute; left: 0; right: 0; top: 24%; display: flex; justify-content: center; animation: ms-banner 1.1s ease-out both; }
.myrme-hud .ms-end-banner span { padding: .35em 1.6em .4em; font-size: 2.1em; font-weight: 300; letter-spacing: .16em; text-transform: uppercase; color: #f6f9f0; text-shadow: 0 .05em .6em rgba(0, 0, 0, .7); border-top: 1px solid rgba(255, 255, 255, .35); border-bottom: 1px solid rgba(255, 255, 255, .35); background: linear-gradient(90deg, transparent, rgba(10, 16, 12, .55) 20%, rgba(10, 16, 12, .55) 80%, transparent); }
.myrme-hud .ms-end-banner.ms-end-won span { color: #f7efc9; }
.myrme-hud .ms-end-banner.ms-end-lost span { color: #d9d4d2; letter-spacing: .22em; }
@keyframes ms-banner { from { opacity: 0; transform: translateY(.8em); letter-spacing: .3em; } to { opacity: 1; transform: none; } }
.myrme-hud .ms-end { width: 35em; max-width: 94%; padding: 1.7em 2em 1.5em; text-align: center; animation: ms-rise .5s ease-out both; }
@keyframes ms-rise { from { opacity: 0; transform: translateY(1em); } to { opacity: 1; transform: none; } }
.myrme-hud .ms-end-won { border-color: rgba(240, 214, 130, .45); box-shadow: 0 .5em 3em rgba(0, 0, 0, .5), 0 0 5em rgba(240, 200, 90, .12), inset 0 1px 0 rgba(255, 255, 255, .08); }
.myrme-hud .ms-end-lost { border-color: rgba(200, 200, 205, .22); background: rgba(17, 17, 19, .95); }
.myrme-hud .ms-end-kicker { font-size: .78em; letter-spacing: .32em; text-transform: uppercase; margin-right: -.32em; color: var(--mh-amber); }
.myrme-hud .ms-end-lost .ms-end-kicker { color: #9d9a9a; }
.myrme-hud .ms-end-title { margin: .35em 0 .25em; font-size: 2.05em; font-weight: 300; letter-spacing: .03em; line-height: 1.15; }
.myrme-hud .ms-end-lost .ms-end-title { color: #d8d5d3; }
.myrme-hud .ms-end-line { margin: 0 auto 1.2em; max-width: 26em; color: var(--mh-dim); }
.myrme-hud .ms-end-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: .55em; margin-bottom: 1em; }
.myrme-hud .ms-end-stat { display: flex; flex-direction: column; gap: .05em; padding: .55em .4em .5em; border-radius: .45em; background: rgba(255, 255, 255, .045); border: 1px solid rgba(214, 236, 200, .08); }
.myrme-hud .ms-end-stat b { font-size: 1.55em; font-weight: 500; line-height: 1.15; }
.myrme-hud .ms-end-won .ms-end-stat b { color: #f4e2a8; }
.myrme-hud .ms-end-stat span { font-size: .8em; color: var(--mh-dim); text-transform: uppercase; letter-spacing: .07em; }
.myrme-hud .ms-end-chart { display: flex; flex-direction: column; gap: .2em; margin-bottom: 1.1em; font-size: .8em; }
.myrme-hud .ms-end-spark { width: 100%; height: 3.4em; display: block; }
.myrme-hud .ms-end-spark-line { fill: none; stroke: var(--mh-accent); stroke-width: 1.2; vector-effect: non-scaling-stroke; }
.myrme-hud .ms-end-spark-area { fill: rgba(159, 216, 107, .13); stroke: none; }
.myrme-hud .ms-end-lost .ms-end-spark-line { stroke: #a9a6a4; }
.myrme-hud .ms-end-lost .ms-end-spark-area { fill: rgba(200, 200, 200, .08); }
.myrme-hud .ms-end-actions { display: flex; justify-content: center; gap: .6em; flex-wrap: wrap; }
.myrme-hud .ms-end-actions .mh-btn { padding: .5em 1.3em; font-size: 1.02em; }

/* ================= tutorial coach marks ================= */
.myrme-hud .mh-slot-overlay > .ms-coach { pointer-events: auto; }
.myrme-hud .ms-coach { position: absolute; left: 50%; top: 4.1em; transform: translateX(-50%); width: 27em; max-width: 60%; padding: .6em .9em .55em; border-left: .25em solid var(--mh-accent); animation: ms-coach-in .3s ease-out; }
@keyframes ms-coach-in { from { opacity: 0; transform: translate(-50%, -.5em); } to { opacity: 1; transform: translate(-50%, 0); } }
.myrme-hud .ms-coach-head { display: flex; align-items: center; gap: .6em; }
.myrme-hud .ms-coach-kicker { font-size: .76em; letter-spacing: .1em; text-transform: uppercase; color: var(--mh-accent); font-weight: 600; }
.myrme-hud .ms-coach-dots { margin-left: auto; display: inline-flex; gap: .3em; }
.myrme-hud .ms-coach-dots i { width: .5em; height: .5em; border-radius: 50%; background: rgba(255, 255, 255, .16); }
.myrme-hud .ms-coach-dots i.ms-on { background: var(--mh-accent); }
.myrme-hud .ms-coach-dots i.ms-cur { background: transparent; box-shadow: inset 0 0 0 2px var(--mh-accent); }
.myrme-hud .ms-coach-title { font-size: 1.14em; font-weight: 600; margin: .12em 0 .15em; }
.myrme-hud .ms-coach-body { color: #d5ddcf; line-height: 1.55; }
.myrme-hud .ms-coach-body .mh-kbd { margin: 0 .12em; }
.myrme-hud .ms-coach-foot { display: flex; align-items: center; gap: .9em; margin-top: .4em; }
.myrme-hud .ms-coach-link { pointer-events: auto; appearance: none; background: none; border: 0; padding: 0; font: inherit; font-size: .88em; color: var(--mh-dim); cursor: pointer; text-decoration: underline; text-underline-offset: .2em; }
.myrme-hud .ms-coach-link:hover { color: var(--mh-text); }
.myrme-hud .ms-coach.ms-coach-tip { border-left-color: var(--mh-amber); }
.myrme-hud .ms-coach.ms-coach-tip .ms-coach-kicker { color: var(--mh-amber); }
.myrme-hud .ms-coach.ms-coach-done { border-left-color: var(--mh-accent); }
.myrme-hud .ms-coach.ms-coach-done .ms-coach-title::before { content: '✓ '; color: var(--mh-accent); }
.myrme-hud .ms-coach-ring { position: absolute; left: 0; top: 0; border-radius: .7em; border: 2px solid var(--mh-accent); box-shadow: 0 0 0 .3em rgba(159, 216, 107, .18), 0 0 1.4em rgba(159, 216, 107, .45); animation: ms-ring 1.6s ease-in-out infinite; pointer-events: none; }
@keyframes ms-ring { 50% { box-shadow: 0 0 0 .6em rgba(159, 216, 107, .06), 0 0 2em rgba(159, 216, 107, .25); } }

/* ================= app shell: menu, new game, loading ================= */
.myrme-shell { z-index: 20; }
.myrme-shell .ms-layer { position: absolute; inset: 0; display: none; }
.myrme-shell .ms-layer.ms-show { display: flex; }
.myrme-shell .ms-veil { position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity .6s; background:
  radial-gradient(120% 90% at 78% 50%, transparent 35%, rgba(6, 10, 8, .5) 100%),
  linear-gradient(90deg, rgba(7, 11, 9, .9) 0%, rgba(7, 11, 9, .66) 30%, rgba(7, 11, 9, .12) 62%, transparent 100%); }
.myrme-shell .ms-veil.ms-show { opacity: 1; pointer-events: auto; }
.myrme-shell .ms-veil.ms-strong { background: rgba(7, 11, 9, .8); backdrop-filter: blur(7px) saturate(.9); -webkit-backdrop-filter: blur(7px) saturate(.9); }
.myrme-shell .ms-veil.ms-solid { background: radial-gradient(90% 80% at 50% 45%, #17211a 0%, #0b0f0d 75%); }

/* ---- title ---- */
.myrme-shell .ms-title { flex-direction: column; justify-content: center; align-items: flex-start; padding: 0 0 2.5em 8.5%; pointer-events: auto; }
.myrme-shell .ms-brand { position: relative; animation: ms-rise .9s ease-out both; }
.myrme-shell .ms-brand .ms-wordmark { display: block; font-size: 6.6em; }
.myrme-shell .ms-brand .ms-wordmark span { display: inline-block; animation: ms-letter 1.1s cubic-bezier(.2, .7, .2, 1) both; }
.myrme-shell .ms-brand .ms-wordmark span:nth-child(2) { animation-delay: .07s; }
.myrme-shell .ms-brand .ms-wordmark span:nth-child(3) { animation-delay: .14s; }
.myrme-shell .ms-brand .ms-wordmark span:nth-child(4) { animation-delay: .21s; }
.myrme-shell .ms-brand .ms-wordmark span:nth-child(5) { animation-delay: .28s; }
@keyframes ms-letter { from { opacity: 0; transform: translateY(.18em); } to { opacity: 1; transform: none; } }
.myrme-shell .ms-trail { display: block; width: 41em; height: 5.2em; margin: -.9em 0 0 -.6em; overflow: visible; }
.myrme-shell .ms-trail .ms-trail-path { fill: none; stroke: var(--mh-accent); stroke-width: 2.2; stroke-linecap: round; stroke-dasharray: .1 9; opacity: .75; }
.myrme-shell .ms-trail .ms-trail-glow { fill: none; stroke: var(--mh-accent); stroke-width: 7; stroke-linecap: round; opacity: .1; filter: blur(3px); }
.myrme-shell .ms-trail .ms-ant { fill: #0d120e; stroke: rgba(233, 239, 228, .55); stroke-width: .5; }
.myrme-shell .ms-trail .ms-ant line { stroke: #0d120e; stroke-width: .9; stroke-linecap: round; }
.myrme-shell .ms-trail .ms-ant .ms-ant-legs { stroke: rgba(233, 239, 228, .7); stroke-width: .6; fill: none; }
.myrme-shell .ms-tagline { margin: -.2em 0 2em .15em; font-size: 1.12em; letter-spacing: .2em; text-transform: uppercase; color: #c9d4c2; text-shadow: 0 1px .6em rgba(0, 0, 0, .7); }
.myrme-shell .ms-tagline b { color: var(--mh-accent); font-weight: 500; }
.myrme-shell .ms-main-list { display: flex; flex-direction: column; gap: .5em; width: 19em; animation: ms-rise .9s .25s ease-out both; }
.myrme-shell .ms-main-item { justify-content: flex-start; gap: .8em; padding: .7em 1.1em; font-size: 1.16em; background: rgba(14, 19, 17, .55); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border-color: rgba(214, 236, 200, .18); text-align: left; }
.myrme-shell .ms-main-item small { display: block; font-size: .72em; color: var(--mh-dim); font-weight: 400; margin-top: .1em; }
.myrme-shell .ms-main-item:hover { transform: translateX(.25em); background: rgba(30, 42, 34, .75); }
.myrme-shell .ms-main-item.mh-on { background: var(--mh-accent); font-weight: 600; }
.myrme-shell .ms-main-item.mh-on small { color: rgba(21, 34, 12, .75); }
.myrme-shell .ms-main-item.mh-on:hover { background: #b4e884; }
.myrme-shell .ms-main-item > span { flex: 1 1 auto; }
.myrme-shell .ms-footnote { position: absolute; left: 8.5%; bottom: 1.6em; font-size: .86em; color: rgba(201, 212, 194, .6); letter-spacing: .04em; }
.myrme-shell .ms-footnote-r { left: auto; right: 2em; text-align: right; }

/* ---- new game ---- */
.myrme-shell .ms-newgame { flex-direction: column; align-items: center; justify-content: center; padding: 1.1em 2em 1em; pointer-events: auto; }
/* the new-game pages scale with the viewport beyond the HUD font so they fill a 1080p+ screen instead of floating in it */
.myrme-shell .ms-ng { font-size: max(1em, min(2.1vh, 1.18vw)); width: 100%; max-width: 78em; display: flex; flex-direction: column; min-height: 0; max-height: 100%; animation: ms-rise .35s ease-out both; }
.myrme-shell .ms-ng-head { display: flex; align-items: flex-end; gap: 1.5em; margin-bottom: .8em; flex: none; }
.myrme-shell .ms-ng-head h2 { margin: 0; font-size: 1.9em; font-weight: 300; letter-spacing: .04em; white-space: nowrap; flex: none; }
.myrme-shell .ms-ng-head p { margin: 0 0 .25em; color: var(--mh-dim); flex: 1 1 auto; }
.myrme-shell .ms-steps { display: flex; gap: .4em; margin-bottom: .2em; flex: none; }
.myrme-shell .ms-step { display: inline-flex; align-items: center; gap: .45em; padding: .22em .8em .22em .3em; border-radius: 1.2em; border: 1px solid var(--mh-border); color: var(--mh-dim); background: rgba(0, 0, 0, .25); font: inherit; cursor: pointer; pointer-events: auto; }
.myrme-shell .ms-step i { font-style: normal; width: 1.5em; height: 1.5em; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: rgba(255, 255, 255, .08); font-size: .85em; font-weight: 600; }
.myrme-shell .ms-step.ms-cur { color: var(--mh-text); border-color: var(--mh-accent); }
.myrme-shell .ms-step.ms-cur i { background: var(--mh-accent); color: var(--mh-accent-ink); }
.myrme-shell .ms-step.ms-past i { background: rgba(159, 216, 107, .25); color: var(--mh-accent); }
.myrme-shell .ms-ng-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: .2em .2em .4em; margin: 0 -.2em; }
.myrme-shell .ms-ng-foot { display: flex; align-items: center; gap: .7em; margin-top: .7em; flex: none; }
.myrme-shell .ms-ng-foot .mh-btn { padding: .5em 1.4em; font-size: 1.05em; }
.myrme-shell .ms-ng-foot .ms-ng-sum { flex: 1 1 auto; color: var(--mh-dim); text-align: right; padding-right: .5em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.myrme-shell .ms-ng-foot .ms-ng-sum b { color: var(--mh-text); font-weight: 500; }
.myrme-shell .ms-go { font-weight: 600; min-width: 11em; }

.myrme-shell .ms-cards { display: grid; gap: .8em; }
.myrme-shell .ms-cards-map { grid-template-columns: repeat(3, 1fr); }
.myrme-shell .ms-cards-faction { grid-template-columns: repeat(4, 1fr); }
.myrme-shell .ms-card {
  pointer-events: auto; appearance: none; font: inherit; color: var(--mh-text); text-align: left; cursor: pointer; position: relative;
  display: flex; flex-direction: column; padding: 0; overflow: hidden; border-radius: .7em; border: 1px solid var(--mh-border);
  background: rgba(16, 22, 19, .82); transition: transform .15s, border-color .15s, box-shadow .15s, background .15s; outline: none;
}
.myrme-shell .ms-card:hover { transform: translateY(-.15em); border-color: var(--mh-border-hi); background: rgba(24, 33, 28, .9); }
.myrme-shell .ms-card:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--mh-accent) 55%, transparent); }
.myrme-shell .ms-card.ms-sel { border-color: var(--mh-accent); box-shadow: 0 0 0 1px var(--mh-accent), 0 .5em 2em rgba(0, 0, 0, .45), 0 0 2.2em rgba(159, 216, 107, .14); }
.myrme-shell .ms-card.ms-sel::after { content: '✓'; position: absolute; right: .6em; top: .55em; width: 1.5em; height: 1.5em; border-radius: 50%; background: var(--mh-accent); color: var(--mh-accent-ink); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: .85em; }
.myrme-shell .ms-thumb { display: block; width: 100%; aspect-ratio: 376 / 126; background: #0c120f; object-fit: cover; image-rendering: auto; }
.myrme-shell .ms-card-body { padding: .6em .85em .75em; display: flex; flex-direction: column; gap: .28em; flex: 1 1 auto; }
.myrme-shell .ms-card-title { display: flex; align-items: baseline; gap: .6em; font-size: 1.14em; font-weight: 600; }
.myrme-shell .ms-tag { font-size: .66em; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; padding: .1em .55em; border-radius: 1em; background: rgba(108, 195, 242, .16); color: var(--mh-blue); white-space: nowrap; }
.myrme-shell .ms-tag.ms-tag-out { background: rgba(159, 216, 107, .15); color: var(--mh-accent); }
.myrme-shell .ms-tag.ms-tag-easy { background: rgba(159, 216, 107, .15); color: var(--mh-accent); }
.myrme-shell .ms-tag.ms-tag-medium { background: rgba(240, 181, 74, .16); color: var(--mh-amber); }
.myrme-shell .ms-tag.ms-tag-hard { background: rgba(239, 111, 97, .16); color: var(--mh-red); }
.myrme-shell .ms-card-desc { color: #c3ccbd; font-size: .93em; line-height: 1.4; }
.myrme-shell .ms-cards-map .ms-card-desc { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.myrme-shell .ms-cards-map .ms-card-goal span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.myrme-shell .ms-cards-map .ms-card-goal { min-width: 0; }
.myrme-shell .ms-cards-map .ms-card-body { min-width: 0; padding-top: .45em; padding-bottom: .55em; }
.myrme-shell .ms-card-goal { margin-top: auto; padding-top: .35em; display: flex; align-items: flex-start; gap: .4em; color: #f1dca0; font-size: .9em; }
.myrme-shell .ms-card-goal .mh-icon { color: var(--mh-amber); width: 1.05em; height: 1.05em; margin-top: .12em; }
/* faction cards */
.myrme-shell .ms-portrait { height: 7.2em; display: flex; align-items: center; justify-content: center; position: relative; background: radial-gradient(80% 120% at 50% 110%, color-mix(in srgb, var(--tint) 42%, transparent), transparent 70%), linear-gradient(180deg, rgba(255, 255, 255, .03), transparent); border-bottom: 1px solid var(--mh-border); }
.myrme-shell .ms-portrait svg { height: 5.6em; width: auto; filter: drop-shadow(0 .3em .5em rgba(0, 0, 0, .55)); }
.myrme-shell .ms-twist { color: var(--mh-accent); font-size: .93em; }
.myrme-shell .ms-traits { margin: .15em 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: .28em; font-size: .88em; color: #c3ccbd; line-height: 1.35; }
.myrme-shell .ms-traits li { padding-left: .95em; position: relative; }
.myrme-shell .ms-traits li::before { content: ''; position: absolute; left: .1em; top: .52em; width: .35em; height: .35em; border-radius: 50%; background: var(--mh-accent); opacity: .8; }
.myrme-shell .ms-traits li.ms-weak::before { background: var(--mh-red); }
.myrme-shell .ms-statbars { margin-top: auto; padding-top: .55em; display: grid; grid-template-columns: auto 1fr; gap: .22em .6em; align-items: center; font-size: .8em; color: var(--mh-dim); }
.myrme-shell .ms-statbars .mh-bar { height: .38em; }
/* setup */
.myrme-shell .ms-setup { display: grid; grid-template-columns: 1.25fr 1fr; gap: 1.2em; align-items: start; }
.myrme-shell .ms-form { padding: .4em 1.1em .6em; }
.myrme-shell .ms-form .ms-set-row { grid-template-columns: 8.5em 1fr; gap: 1em; align-items: start; padding: .75em 0; }
.myrme-shell .ms-form .ms-set-control { justify-content: flex-start; flex-direction: column; align-items: flex-start; gap: .4em; }
.myrme-shell .ms-form .ms-set-label { padding-top: .3em; }
.myrme-shell .ms-seed { display: flex; gap: .4em; align-items: center; }
.myrme-shell .ms-seed input { pointer-events: auto; font: inherit; font-variant-numeric: tabular-nums; color: var(--mh-text); width: 9em; padding: .32em .6em; border-radius: .4em; border: 1px solid var(--mh-border-hi); background: rgba(0, 0, 0, .35); user-select: text; -webkit-user-select: text; }
.myrme-shell .ms-summary { overflow: hidden; }
.myrme-shell .ms-summary .ms-card-body { gap: .45em; }
.myrme-shell .ms-sum-row { display: flex; gap: .6em; align-items: baseline; }
.myrme-shell .ms-sum-row > span:first-child { color: var(--mh-dim); width: 5.2em; flex: none; font-size: .9em; }
.myrme-shell .ms-menu-settings { align-items: center; justify-content: center; pointer-events: auto; }

/* ---- loading ---- */
.myrme-shell .ms-loading { flex-direction: column; align-items: center; justify-content: center; gap: 1.1em; pointer-events: auto; background: radial-gradient(90% 80% at 50% 42%, #18231b 0%, #0a0e0c 78%); opacity: 0; transition: opacity .45s; }
.myrme-shell .ms-loading.ms-in { opacity: 1; }
.myrme-shell .ms-loading .ms-wordmark { font-size: 2.6em; font-weight: 300; }
.myrme-shell .ms-load-what { font-size: 1.05em; letter-spacing: .18em; text-transform: uppercase; color: #c9d4c2; }
.myrme-shell .ms-load-what b { color: var(--mh-accent); font-weight: 500; }
.myrme-shell .ms-march { position: relative; width: 18em; height: 1.2em; overflow: hidden; -webkit-mask-image: linear-gradient(90deg, transparent, #000 18%, #000 82%, transparent); mask-image: linear-gradient(90deg, transparent, #000 18%, #000 82%, transparent); }
.myrme-shell .ms-march i { position: absolute; left: -36em; top: 50%; width: 72em; height: .34em; margin-top: -.17em; background-image: radial-gradient(circle, var(--mh-accent) 0 .15em, transparent .17em); background-size: 1.5em .34em; animation: ms-march 1.1s linear infinite; will-change: transform; opacity: .85; }
@keyframes ms-march { to { transform: translateX(1.5em); } }
.myrme-shell .ms-tip { max-width: 32em; text-align: center; color: var(--mh-dim); line-height: 1.55; min-height: 3.2em; padding: 0 1em; }
.myrme-shell .ms-tip b { display: block; font-size: .76em; letter-spacing: .14em; text-transform: uppercase; color: var(--mh-amber); font-weight: 600; margin-bottom: .2em; }
.myrme-shell .ms-toast { position: absolute; left: 50%; bottom: 2em; transform: translateX(-50%); padding: .5em 1.1em; border-left: .25em solid var(--mh-red); pointer-events: auto; max-width: 80%; }

#app { transition: opacity 1.1s ease-out; }

@media (max-aspect-ratio: 4/3) {
  .myrme-shell .ms-cards-faction { grid-template-columns: repeat(2, 1fr); }
  .myrme-shell .ms-setup { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .myrme-shell .ms-march i { animation: none; }
  #app { transition: none; }
}
`;
