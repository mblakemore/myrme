# Myrme

**Play in the browser:** https://mblakemore.github.io/myrme/ (needs WebGL2; use the `medium`
quality preset on integrated graphics).

Myrme is a 3D ant-colony survival/strategy game written in TypeScript on three.js. You steer a
colony as a swarm (priorities, beacons, dig designations), as squads (RTS selection and orders),
or by crawling inside a single ant in first or third person — across procedural outdoor worlds
and stylised ant-farm habitats (gel, sand, formicarium). The colony lives on its own through
scent trails, brood care and task allocation while weather, predators, rival colonies and a
zombie fungus push back; you can play as three ant species or as termites.

The design, locked technical decisions and work split are in [PLAN.md](PLAN.md).

## Quick start

```bash
npm install
npm run dev            # Vite dev server → open the printed URL (title menu)
npm run build          # typecheck + production bundle in dist/
npm run test           # all unit + soak tests (vitest, headless, no browser)
npm run check          # full typecheck + all unit tests
npm run check -- src/sim src/world/nav   # scoped gate: only diagnostics/tests under those prefixes
npm run e2e            # Playwright specs in tests/e2e (port from $MYRME_PORT, default 5199)
npm run shots -- --port 5200             # deterministic screenshot set → shots/*.png
```

Opening the dev URL with no parameters shows the title menu (map → faction → setup: seed,
difficulty, goal/sandbox mode, map size). Any of the direct-boot URL parameters below skips the
menu, e.g. `http://127.0.0.1:5173/?map=gelFarm&faction=fireAnt&seed=7`.

## How to play

You start with a queen, a few workers and a starter chamber. The colony forages, digs, nurses
and fights by itself; you nudge it. All keys below are the defaults from
`src/input/keybinds.ts` and can be rebound in Settings → Keys. `F1` or `?` shows the in-game
key list.

**Camera (map view).** `W A S D` / arrow keys pan · mouse wheel zooms towards the cursor ·
RMB-drag orbits · MMB-drag pans · `Q` / `E` rotate · `.` focus the selection · `H` jump to the
nest (double-tap `H` also opens the cutaway on it) · `Y` follow the selected ant · `G` flip to the other glass pane (farm maps, which use a
constrained "slab" camera facing the pane).

**Selection.** LMB selects (Shift+LMB adds, Ctrl+LMB toggles) · LMB-drag box-selects ·
double-click selects the same caste on screen · `Ctrl+A` all on screen · `F2` all soldiers ·
`F3` or `` ` `` next idle worker (with Shift: all idle) · `Tab` / `Shift+Tab` cycle through the
selection · `Ctrl+1..9` or `Shift+1..9` assign a control group, `1..9` recall it (double-tap to
focus the camera on it).

**Orders.** RMB is contextual: move on ground, gather on food, attack on an enemy, follow on a
nestmate · `Shift+RMB` queues · `Alt+RMB` guards a position or target · `Backspace` stops
(clears the orders, and lifts an exile). The selection panel's **Exile** button sends the selected
ants to the midden for good (never the queen).

**Tools and beacons.** `B` dig brush (paint dig designations; workers excavate them) · `N` build
brush (fill designations — for species that can build, i.e. termites) · `Z` / `X` or
`Alt+Wheel` smaller / larger brush · `R` erase mode. Beacons are dropped pheromone markers the
whole colony reacts to: `U` gather · `I` dig · `O` rally · `J` attack · `K` avoid. An attack
beacon on a rival nest musters a war party; it refuses to march at hopeless odds (an alert says
how many fighters it has against how many defenders), falls back to regroup when the fight
turns, and comes home when the beacon is removed. `Esc`
cancels the active tool, then clears the selection.

**Possession.** `F` possesses the selected ant (or the own ant nearest the cursor) and `F` or
`Esc` releases it back to its queued tasks. While possessing: `W A S D` crawl on any surface
(walls and ceilings included) · mouse look (pointer lock) or `←` / `→` turn and `↑` / `↓` look ·
`Shift` sprint · LMB bite · RMB dig (you get the spoil pellet) · `E` pick up / drop (a dropped
pellet is packed back into the ground in front of you, indoors too) · `R` lay a trail on/off · `Q` recruit
followers · `V` first / third person · `Tab` or `.` hop to the next nestmate, `,` or
`Shift+Tab` to the previous one.

**Cutaway.** `C` toggles an axis-aligned cut through the terrain so you can see the nest ·
`[` / `]` (or `Ctrl+Wheel`) move the cut plane towards / away from the camera · `\` snaps the
cut to the selection or the nest. The cutaway also opens by itself when the camera jumps to
something underground (an alert, a followed ant, double-tap `H`); pressing `C` to close it
declines the automatic cut until the next double-tap `H`. A game started from the menu on an
outdoor map opens with a short camera move from the landscape into the nest (any input skips it).

**Pheromone vision.** `P` desaturates the world and shows the colony's scent channels (food
trails, alarm, death, dig, rally, attack, avoid) as glowing ribbons, with a legend.

**Colony panel.** `L` opens the colony panel: population by caste, brood, stores, job priority
sliders, caste ratios, nest and event log, plus faction-specific extras. The top bar shows food,
population, clock, weather and the goal tracker; alerts appear in a feed and can be clicked to
jump there. The HUD follows the viewport height (about 13 px type at 720p, 17.5 px at
1080p, 26 px at 4K); Settings → Interface size is a multiplier on top.

**Speed.** `Space` pauses · `+` / `−` (also numpad) step the speed through 1× / 2× / 4×.
`F9` toggles the debug overlay.

## Maps and goals

| Map | Kind | Goal (goal mode) |
|---|---|---|
| **Meadow** | outdoor, grass, stems, flowers | Raise 150 ants and launch a nuptial flight |
| **Forest floor** | outdoor, leaf litter, logs, a gully | Destroy the rival colony across the gully |
| **Desert** | outdoor, dunes, heat | Raise 100 ants in the dunes and launch a nuptial flight |
| **Gel Farm** | backlit blue gel between glass panes; the gel is edible | Excavate 25% of the gel |
| **Sand Farm** | colour-strata sand between panes | Grow the colony to 60 ants |
| **Formicarium** | plaster block with pre-carved chambers, tubes and an outworld tray | Grow the colony to 80 ants |

A nuptial flight needs the population target first; the colony then rears winged alates, waits
for flying weather (warm, daylight, not raining), and the alates gather at the entrance and take
off. **You lose** when the queen dies (for termites: the queen *or* the king) and no succession
is possible — an adult alate takes the throne at once, and the colony holds on while
queen-destined brood is alive — or when the last ant dies. After a win you can keep playing.
Sandbox mode removes the win condition (the lose condition stays). Farm maps have a **keeper**
who periodically drops food and water, switches a lamp, taps the glass and opens a tube.

## Factions

| Faction | Castes | Twist |
|---|---|---|
| **Black garden ant** (easy) | queen, worker, soldier, alate | Balanced all-rounders that eat anything they can carry home and herd aphids on plant stems for a steady trickle of honeydew. |
| **Fire ant** (medium) | queen, worker, soldier, alate | Fast, fragile, aggressive; every caste stings with venom (damage over time); when the nest floods the colony links bodies into a living raft carrying queen and brood. |
| **Leafcutter ant** (hard) | queen, minim, media, major, alate | Cannot eat forage: media workers cut leaves and parade them home, minims tend the fungus garden — the only food. Neglect or overload it and mould takes hold. |
| **Termite** | queen, king, worker, soldier, nasute, alate | Eats wood and leaf litter instead of foraging; builds with mud (shelter tubes, breach plugs, a mound, player build designations); desiccates in direct sun; nasutes spray glue; both royals must live. |

## Threats, weather and fungus

- **Fauna:** jumping spider (hunter), antlion (static pit trap), ground beetle (tank), parasitic
  wasp (flyer), mantis (boss), AI-run rival colonies that scout and raid; caterpillars and worms
  are prey, aphids are herdable. A **director** paces threats by difficulty: `peaceful` (no
  threats), `easy` (few, small waves), `normal` (a colony left alone usually survives), `hard`,
  and `brutal` (faster, larger, tougher waves and stronger rivals — an unattended colony usually
  dies within half an hour; raising soldiers and guards is enough to hold in most games).
  Rival colonies keep a home guard, raid only with their surplus and go home when a raid is
  losing.
- **Combat:** bites, stings and sprays with status effects (poison, slow, glue, stun) and
  grappling — many small ants can pin a large enemy. Alarm pheromone recruits defenders; corpses
  are hauled to a midden.
- **Weather:** day/night cycle; clear, cloud, fog, drizzle, rain, storms with lightning,
  cloudbursts, heat waves, cold snaps and wind. Rain washes out trails and floods low galleries
  (water drains over time; brood is evacuated); standing water is avoided by pathfinding, ants
  only drown when the water is over their heads, foragers go out in the lulls (and in the rain
  itself when the stores run low); heat desiccates, cold slows. Farm maps are
  indoors.
- **Faction autonomy:** garden ants adopt aphid herds they find (a herd its owner has not visited
  for about 75 s can be taken over by another colony) and staff them by herd size; termites build
  shelter tubes and their mound by day (builders at the works ignore sun and ordinary rain, a
  finished tube head is a sheltered feeding spot, windfall twigs and litter keep arriving, the
  mound grows with the population); when a fire-ant nest floods, nearby workers, the queen and
  brood board one large raft.
- **Zombie fungus:** spore exposure → incubation → erratic walking → summit climb and death
  grip → fruiting stalk → spore burst. Healthy workers smell late-stage infection and drag the
  victim out; you can exile or cull earlier.

## URL parameters

Any of `map`, `faction`, `seed`, `autostart`, `shot`, `fixture`, `ants`, `frozen` boots straight
into a game; with none of them (or with `menu=1` / `autostart=0`) the title menu is shown.

| Parameter | Values | Meaning |
|---|---|---|
| `map` | `meadow` `forest` `desert` `gelFarm` `sandFarm` `formicarium` | map (default `meadow`) |
| `faction` | `gardenAnt` `fireAnt` `leafcutter` `termite` | player species (default `gardenAnt`) |
| `seed` | integer | world + sim seed (default 1) |
| `quality` | `low` `medium` `high` `ultra` | render preset; overrides the saved graphics setting |
| `difficulty` | `peaceful` `easy` `normal` `hard` `brutal` | director intensity (a direct boot without it leaves the director off) |
| `mode` | `goal` `sandbox` | sandbox = no win condition |
| `size` | `standard` `small` | map size |
| `fixture` | `none` `wander` | `none` = the real game; `wander` = permanent test scene of wandering ants |
| `ants` | 1–5000 | ant count for the `wander` fixture (default 200) |
| `shot` | `1` | screenshot mode: HUD hidden, no dynamic resolution, no audio |
| `frozen` | `1` | start with time frozen (scripted runs begin at exactly tick 0) |
| `tutorial` | `1` | force the onboarding on a direct boot |
| `intro` | `1` / `0` | force / suppress the opening camera move into the nest |
| `tod` | 0–1 | debug: pin the rendered time of day |
| `fxdemo` | name | debug: force an effect demo (see `src/render/modules/fxShared.ts`) |
| `autostart` | `0` | show the menu instead of booting |
| `menu` | `1` / `0` | force / suppress the title menu |
| `attract` | `0` | disable the live game behind the menu |

## Debug API

`window.__myrme` exists while a playable game is running:

- `ready` — map generated, first frame rendered, near chunks meshed
- `step(n)` — run `n` sim ticks synchronously (30 ticks = 1 sim second) and render
- `setCamera(pose | name | null)` — a `{pos, target, fov}` pose or a named pose from the map's `shotPoses`
- `freezeTime(b)`, `renderNow()`, `stateHash()`, `stats()` (sim + render counters: ants, ms/tick, draw calls, triangles, quality, `gpu`)
- `sim` (read-only view of the simulation state), `view` (shared view state: `pheroVision`, `firstPerson`, cut plane, camera…)
- `command(cmd)` — the only way to change the sim: orders, beacons, designations, priorities, possession input, `setSpeed`, `keeper`, `setDirector`, and the debug commands `debugSpawn`, `debugKill`, `debugWeather`, `debugInfect`
- `select(ids)`, `possess(id)`, `release()`
- `audio` (incl. `audio.stats()`), `emit(events)` (inject fabricated sim events into the next frame for UI/audio/render tests), `options`, `params`, `shell`

`window.__myrmeShell` always exists: `screen`, `gamesCreated`, `gamesAlive`, `showMenu(step)`,
`showLoading()`, `openPause()`, `openSettings(tab)`, `openColony(tab)`, `openCodex(entry)`,
`closeAll()`, `startGame(cfg)`, `toMenu()`, `restart()`, `tutorial(op)`, `settings()`.

## Architecture

```
src/core      contracts.ts (all shared types) + contracts/<stream>.ts, rng, math, events, constants
src/world     VoxelWorld, mesher, raycast, nav, pheromones, water, generators/, maps.ts
src/sim       Simulation, systems/ (registry = execution order), behaviors/, data/ (species, creatures, balance)
src/render    Renderer (pipeline, postfx, quality presets), shared.ts, modules/ (registry)
src/assets    procedural geometry / textures (no binary assets)
src/input     cameras, keybinds, selection, orders, tools
src/ui        HUD, colony panel, menu, settings, tutorial, codex, end screens
src/audio     procedural WebAudio: ambience, SFX, music
src/game      App shell (menu ⇄ game), Game orchestrator, loop, URL params, debug API
tools         check.mjs (scoped gate), shots.mjs (screenshots), browser.mjs, gl-probe.mjs, withLock.mjs
tests/e2e     Playwright specs          (unit and soak tests are colocated: src/**/*.test.ts)
```

- **Sim / render separation.** `core/`, `world/` and `sim/` never import three.js or touch the
  DOM; they run in Node (that is how the unit and soak tests run them). The simulation runs at a
  fixed 30 Hz tick; render, UI and audio only read sim state and the per-frame event list, and
  change the sim solely through `command(...)`. The renderer interpolates poses between ticks.
- **Determinism.** One seeded RNG; the same seed and command stream give an identical
  `stateHash()` (tested). Screenshots use frozen time and fixed ticks.
- **World.** A voxel grid of clamped signed-distance density plus material ids, meshed with
  surface nets per 16³ chunk; digging/filling uses spherical brushes. Every walker uses one
  surface-crawling locomotion model; navigation is A* over walkable cells with a per-tick budget
  and a per-colony home distance field. Pheromones are sparse per-colony channels; water is a
  sparse flooded-cell field. The cutaway is produced by the mesher.
- **Registries.** Sim systems (`sim/systems/index.ts`, order = execution order), behaviors,
  species, creatures, maps and render modules (`render/modules/index.ts`) are registered in
  tables, so features are added as modules rather than pipeline edits.
- **Contracts.** Shared types live in `core/contracts.ts`; each development stream added its own
  extension file under `core/contracts/` (e.g. `b2.ts` weather/water/fungus, `b3.ts` factions,
  keeper, goals).
- **Rendering.** Triplanar procedural terrain materials, instanced ants with a vertex-shader
  gait, one fitted shadow map, postprocessing chain (SSAO, bloom, depth of field, god rays,
  colour grade, vignette, SMAA) with low/medium/high/ultra presets; gel is rendered opaque with
  faked absorption and backlight.

## Testing and verification

- **Unit tests** (vitest, colocated): voxel edits, mesher seams, raycast, nav, pheromones, brood
  lifecycle, orders, combat, fungus stages, water, goals, keybinds, UI models, audio DSP.
- **Soak tests** (`*.soak.test.ts`, headless): seeded colonies run for sim-minutes and assert
  survival, growth, no NaN poses, nothing stuck inside solid. Balance was tuned against these.
- **Scoped gate:** `npm run check -- <paths…>` runs `tsc` on the whole project but only reports
  (and fails on) diagnostics whose file path starts with one of the given prefixes, then runs the
  unit tests under those prefixes. Out-of-scope type errors are counted and printed as info.
  `--no-tests` skips the test run.
- **E2E:** `npm run e2e` runs the Playwright specs (boot, HUD, input, views, shell, colony panel,
  audio, a real-game run) under the browser lock.
- **Screenshots:** `npm run shots -- --port <n> [--map --faction --quality --ticks --pose --size
  --out --name --eval --fixture --ants --seed --hud --set --url "k=v&…"]` starts or reuses a Vite dev server on
  the port, takes the exclusive lock `/tmp/myrme-browser.lock` (concurrent runs queue), loads the
  game, waits for `__myrme.ready`, freezes time, steps to a fixed tick, runs the optional
  `--eval` script, applies a named pose (from the map's `shotPoses`) or a JSON pose, and writes
  `shots/<name>.png`. Page console errors are printed and fail the run. Without
  `--map/--pose/--name/--eval` it produces the standard set. Note the tool's default fixture is
  `wander`; pass `--fixture none` for the real game. `shots/` is gitignored — images such as
  `shots/meadow-overview.png`, `shots/gelFarm-front.png` or the integration set under
  `shots/m3/` are generated by `npm run shots`, not checked in.
- **Perf proxies:** `__myrme.stats()` reports draw calls, triangles and sim ms/tick; budgets are
  in PLAN §12.

### Rendering in headless

Measured on the build box (AMD Radeon, Mesa RADV, Playwright 1.61 / Chromium 1228 headless shell)
with `node tools/gl-probe.mjs`:

| Flags | WebGL renderer | Result |
|---|---|---|
| `--use-angle=vulkan --use-gl=angle --enable-gpu --ignore-gpu-blocklist` | ANGLE → Vulkan → **AMD Radeon (RADV)** | **Works. Default.** WebGL2, `EXT_color_buffer_float` + `EXT_color_buffer_half_float`, RGBA16F and RGBA32F render targets complete, float linear filtering, max texture 16384. |
| same + `--enable-features=Vulkan` | same | **Broken:** every frame is scrambled into 128 px tiles (page screenshots and `canvas.toDataURL` alike). Do not add this flag. |
| `--use-angle=gl --use-gl=angle …` | SwiftShader | Silently falls back to software (no EGL display in headless). |
| `--use-angle=swiftshader --enable-unsafe-swiftshader` | SwiftShader (software Vulkan) | Works, identical images, roughly 3–4× slower per shot. **Fallback.** Float targets also supported. |

The choice is hard-coded in `tools/browser.mjs` (`GL_FLAG_SETS`, tried in order; the default set
also carries `--enable-unsafe-swiftshader` so Chromium can fall back on its own). Both the shots
tool and the Playwright config use it. `MYRME_GL=swiftshader npm run shots …` forces software for
A/B comparisons. The game reports the active renderer in `__myrme.stats().gpu`.

## Known limitations

- **Balance is machine-tuned.** Growth rates, threat pacing and faction numbers were tuned
  against headless soak tests, not by human playtesting; difficulty curves may feel off.
- **Audio has never been listened to by a human.** All sound is procedural WebAudio verified
  only through statistics and offline renders; levels are deliberately conservative.
- **Pointer-lock mouse look is untested.** Headless browsers cannot grant pointer lock, so
  possession mouse look was only exercised through the keyboard-turn path and scripted input.
- **Visual effects were verified from headless screenshots only** (frozen time, fixed ticks) —
  motion, timing and frame pacing on a real display have not been reviewed by eye.
- **Performance is measured by proxies** (draw calls, triangles, CPU ms) rather than real frame
  rates on a range of GPUs.
- No save/load, no multiplayer; everything is procedural (no authored art or audio assets).
- **Forest morning fog is rare.** The fog look exists and was checked with fog forced on, but the
  weather machine almost never chooses the fog phase on its own.
- **Fights are loose lines, not formations.** Ants fighting ants now hold at bite range, spread
  around their opponent and flank, but there are no ranks or assigned slots; in a tunnel a fight
  is still a queue.
- **Brutal is harsh and swingy.** Across seeds the same difficulty ranges from a comfortable win
  to an early loss, depending mostly on how close the rival nest is.
- **Plants are stylised voxels.** Puddles have angular outlines.
- **A flooded fire-ant nest re-forms its raft** every 40 seconds or so while the water stays.
- **Termites on the forest map are uneven.** Meadow termite colonies are stable to 40 minutes,
  but forest seeds vary: one seed loses workers that get stuck carrying corpses near the nest and
  starve, another loses heavily to raids. Termite sun deaths cluster when a fight happens at noon.
- **Some starts are poor.** With a rival nest close by and sparse food (e.g. desert seed 3 on
  normal) a colony can sit at a dozen ants for a long time; the director then holds back new
  threats, but rival foragers still contest the food.
- **Raft rendering has artefacts** in the cutaway (a blurred pale blob over the queen and a flat
  brown quad on the water).
