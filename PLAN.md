# Myrme — Project Plan

> A 3D ant-colony survival/strategy game in three.js. Command the colony as a swarm, as squads, or
> crawl inside any single ant in 1st/3rd person. Procedural outdoor worlds and stylised ant-farm
> habitats (gel, sand, formicarium). Real-colony pressures: scent trails, brood care, weather,
> predators, rival colonies, zombie fungus. Play as ants — or termites.

Status: **v2 — executed.** M0–M3 are complete (469 unit tests, 50 e2e tests, build green). Nothing
on the §3 cut list was cut. Open issues are listed in README.md "Known limitations". Revision
history and the gap review are in §16.

Contents: 1 Vision · 2 Player experience · 3 Scope & cut order · 4 Stack · 5 Architecture ·
6 Locked decisions · 7 Content · 8 Milestones · 9 Ownership · 10 Subagent protocol · 11 Testing ·
12 Performance · 13 Risks · 14 Definition of done · 15 Acceptance per stream · 16 History

---

## 1. Vision & pillars

1. **Ant scale is the spectacle.** Grass stems are towers, raindrops are meteors, a gel farm is a
   glowing blue cathedral. Macro-photography look: bokeh, clearcoat chitin, light through leaves.
2. **A colony that lives without you.** Ants forage, dig, nurse, haul corpses and fight on their
   own through pheromones and task allocation. The player nudges, prioritises, and intervenes.
3. **Zoom from swarm to single ant.** Colony priorities → group orders → individual orders →
   possess one ant and do the job yourself, then release it back to its queued tasks.
4. **Real myrmecology, dramatised.** Trails, alarm pheromone, necrophoresis, trophallaxis, brood
   stages, Ophiocordyceps "zombie" fungus, aphid herding, floods, antlion pits, nuptial flights.

## 2. Player experience

**Minute to minute.** You start with a queen, a handful of workers and a starter chamber. Scouts
wander; one finds a dead caterpillar and lays a trail; you watch the trail thicken. You paint a
dig designation to add a nursery, drop a *Gather* beacon on a distant seed pile, bump the
"nurse" priority when larvae go hungry. An alert: a jumping spider near the entrance — you
box-select soldiers and right-click it, or possess a soldier and lead the charge yourself, biting
at its legs. Rain starts: trails wash out, the lower gallery floods, you order brood hauled
upward. A forager returns stumbling and erratic — fungus. Exile it before it climbs.

**Lose:** the queen is dead and no queen-destined brood remains. **Win (per map goal):**
- Outdoor maps: raise population to the map target and launch a **nuptial flight** (winged
  alates gather and take off — the victory moment), and/or eliminate the rival colony.
- Farm maps: zen/sandbox goals (excavate X% of the gel, reach population N) with **keeper
  events** as the source of food, pressure and "weather": food drops through the lid, a water
  dropper (local flood), the desk lamp (heat gradient), glass taps (panic/alarm), and a tube
  opened to a neighbouring farm (rival invasion).
- Sandbox mode always available: no goal, director intensity slider.

**Threat director.** Scales threats with colony size and elapsed days: scouts → single predators
→ raids → boss (mantis) → fungus season. Difficulty = director budget multiplier.

**Onboarding.** Six contextual hints, each dismissed by doing the thing: move camera → select
ants → order to food → paint a dig → possess & release → open colony panel.

**Faction twists (mechanical, enforced by capability flags):**
| Faction | Twist |
|---|---|
| Black garden ant | Balanced; herds aphids on plant stems for steady honeydew. |
| Fire ant | Fast, venomous, cheap soldiers; **rafts** — survives floods by linking bodies. |
| Leafcutter | Cannot eat forage directly: leaves → fungus garden chamber → food. Garden can sicken. |
| **Termite** | Eats wood/leaf litter voxels; **builds** mud tubes/walls (`fill`); king + queen; nasute soldiers spray glue; workers take damage in open sun unless under cover. |

## 3. Scope tiers & cut order

| Tier | Milestone | Contents |
|---|---|---|
| **Skeleton** | M0 | Voxel world, mesher, crawling ants on floors/walls/ceilings on Meadow + Gel Farm, instanced rendering, RTS camera, select, possess, cutaway, test harness. |
| **MVP** | M1 | All six maps; full autonomous colony loop (forage, trails, brood, digging, hauling, necrophoresis); orders, beacons, possession with actions; HUD; full visual pipeline; garden ant faction. |
| **Target** | M2 | Combat, predators, rival colonies, director, goals/win/lose; weather, flooding, temperature; zombie fungus; fire ant / leafcutter / termite factions; aphids; keeper events; VFX; menus, tutorial, settings, audio. |
| **Stretch** | — | Save/load, photo mode, seasons, generative music, worker-thread sim. |

**Cut order if a wave runs long (first cut first):** desert biome → wasp → formicarium map →
fire-ant rafts → forest biome → mantis boss → leafcutters → audio music layer. Never cut:
termites, gel farm, possession, fungus, rain.

## 4. Tech stack

- TypeScript (strict), Vite, **three.js pinned exact** (0.187.x), **`postprocessing` pinned exact**
  (6.39.x, peer-compatible), `simplex-noise`, `lil-gui` (debug only). Vanilla TS + CSS UI.
- Vitest (unit + soak), Playwright + cached Chromium (smoke + screenshots). The build box has AMD
  GPUs: try hardware GL in headless Chromium first, fall back to SwiftShader. M0 proves which
  works, including float render targets.
- Assets 100% procedural at runtime (geometry builders, canvas/DataTexture generators, shader
  noise, WebAudio synthesis). No binary assets. Node 22 / npm.

## 5. Architecture

```
src/
  core/     contracts.ts + contracts/<stream>.ts, rng, math, events, constants
  world/    VoxelWorld, mesher, raycast, nav, pheromones, water, generators/, maps.ts
  sim/      Simulation, spatial hash, systems/, behaviors/, data/ (species, creatures, balance)
  render/   Renderer (pipeline skeleton), shared uniforms, modules/ (one scene module per file)
  assets/   procedural textures + geometry builders
  input/    cameras, selection, commands, keybinds
  ui/       HUD, panels, menus, minimap, tutorial, settings
  audio/    synth engine, ambience, sfx
  game/     Game orchestrator, loop, debug API (window.__myrme)
tools/      check.mjs (scoped gate), shots.mjs (screenshots)
tests/e2e/  Playwright specs
```

### 5.1 Hard rules
- `core/`, `world/`, `sim/` never import three.js or touch DOM/window. They run in Node.
- Deterministic sim: fixed **30 Hz** step, seeded RNG, no `Math.random`/`Date.now`/`performance`
  in sim or world. Same seed + same command stream ⇒ same `stateHash`.
- One-way flow: input → `sim.command(cmd)` → sim → readable state + per-tick event buffer →
  render/ui/audio. Nothing outside `sim/` mutates sim state.
- Registries (systems, behaviors, maps, species, creatures, render modules) are **explicit list
  files pre-populated by M0 with stubs** for every planned entry, so wave agents fill files in and
  never edit a registry.
- All tuning numbers live in `sim/data/balance.ts` (sectioned per stream).

### 5.2 Simulation model
- Entities are plain objects in arrays with a spatial hash. Ids are never reused; removal is by
  tombstone, swept at end of tick.
- **Brain = behavior registry.** A `Behavior { id, priority band, score(ant, ctx), run(ant, ctx, dt) }`
  per file in `sim/behaviors/`. Each think (staggered, every 0.2–0.5 s) the top-scoring behavior
  runs; it may push/pop the ant's task queue. Bands: `forced` (infected, possessed-suspended) >
  `player` (orders) > `survival` (flee, fight, flood escape) > `duty` (colony job board) > `idle`.
- **Colony job board** (dig designations, haul food, feed larvae/queen, carry brood, carry
  corpse to midden, guard, patrol, build) allocated by response thresholds per caste/age and the
  player's priority sliders.
- **Player orders** are tasks with `source:'player'`. **Possession** sets `possessed=true`: the
  brain is skipped, the queue is untouched; release resumes it. Possession works on any own-colony
  ant including the queen (with a warning). If the possessed ant dies the camera falls back to RTS
  on the corpse with an alert.
- **Lifecycle:** queen lays (rate ∝ stored food) → egg → larva (must be fed) → pupa → adult;
  caste chosen by colony ratio setting. Old age, starvation, desiccation, drowning, combat, fungus.

### 5.3 Rendering pipeline
- `Renderer` (M0-owned skeleton) owns canvas, composer, quality struct, shared uniforms
  (`uTime, uWind, uWetness, uSunDir, uSunColor, uCutPlane, uPheroVision`), layers, and a
  `RenderModule { id; init(ctx); update(ctx, frame); dispose() }` list. Streams add **modules**,
  not pipeline edits; postfx parameters are driven through a typed `look` object.
- Chain: N8-style SSAO → bloom → DoF → god rays → colour grade → vignette/CA/grain → SMAA.
  **DoF policy:** gentle tilt-shift in RTS at close zoom; strong macro DoF only in possession
  and photo poses. Presets low/med/high/ultra, dynamic resolution, `?quality=`.
- **Shadows:** one texel-snapped shadow map fitted to the camera focus region (no cascades).
- **Terrain:** mesher output wrapped in BufferGeometry; triplanar procedural PBR with material
  weights, wetness, micro-normals. Underground gets a soft fill light.
- **Ants:** parametric procedural geometry (species × caste), chitin PBR; `InstancedMesh` with
  vertex-shader tripod gait from per-instance speed/phase, matching depth material for shadows,
  manual culling/LOD buckets, carried items, selection rings; 1st-person shows own antennae and
  mandibles.
- **Habitats:** gel rendered **opaque with faked absorption, backlight and inner glow** (no true
  transparency → no sorting/DoF artefacts); analytic glass panes with reflections and smudges;
  out-of-focus desk/room backdrop; LED base.
- **Views:** cutaway (see §6), pheromone vision (desaturated world, glowing channels).
- **FX:** rain streaks, giant droplets + splashes, ripples, lightning, wet sheen, dust motes,
  spores, pheromone motes, bite sparks/acid/glue, dig debris, dew, fireflies.

### 5.4 Input & UI
- **RTS camera:** WASD/edge pan, wheel zoom (canopy → macro), RMB-drag orbit, Q/E rotate. Farm
  maps use a constrained **slab camera** (pan/zoom facing the pane, slight orbit).
- **Selection:** click, drag-box, double-click = same caste on screen, Ctrl+1..9 groups.
- **Orders (RMB, contextual):** move · gather (food) · attack (enemy) · guard · follow; dig-paint
  and (termites) build-paint modes. **Beacons** (hotkeys): Gather, Dig, Rally, Attack, Avoid.
- **Possession:** `F` possess, `V` 1st/3rd, `F`/`Esc` release. WASD on any surface, mouse look
  (pointer lock), LMB bite, RMB dig, `E` pick up/drop, `R` lay trail, `Q` recruit followers,
  Shift sprint.
- **HUD:** food / population by caste / brood, alerts, selection panel with task queue, priority
  sliders, caste ratio, minimap, clock + weather, speed (pause/1×/2×/4×), cutaway + pheromone
  vision toggles, goal tracker. **Menu:** map, faction, seed, difficulty, quality.

## 6. Locked technical decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Units / axes | y up. 1 voxel = 1 world unit. Worker ant ≈ **0.7 units** long. Cell centre at +0.5. |
| D2 | Cell index | `i = x + sx*(z + sz*y)`. |
| D3 | Density | `Uint8Array` **clamped signed distance**: 128 = surface, ±64 per voxel, solid ≥ 128. Never binary. |
| D4 | Edits | Only spherical brushes, radius ≥ 1.5 (⇒ ~3-voxel tunnels). `dig`/`fill` return `{changedChunks, removedByMaterial}` and bump `world.version`; edits within 1 voxel of a chunk border dirty neighbours; `fill` refuses occupied cells; pheromones cleared in edited cells. |
| D5 | Materials | Air, Soil, Sand, Clay, Rock, Gel, Wood, LeafLitter, Plant, Mud, Fungus. Per-material dig cost + edible flags. |
| D6 | Boundaries | Per-map `boundary: 'glass' \| 'open'`. Out-of-bounds counts as **solid for walkability** but **air for meshing** on glass faces — the slab face is cut flat against the pane and tunnels show as openings. Outdoor: sides + floor closed, sky open. |
| D7 | Farm slabs | Interior **4–5 voxels thick** so every tunnel touches a pane (true 2.5D ant farm). |
| D8 | Mesher | Pure function in `world/mesher.ts`: surface nets on 16³ chunks with 1-cell padding; returns `{positions, normals (global density gradient), indices, matWeights}`. Remesh under a ~4 ms/frame budget, nearest-to-camera first. |
| D9 | Cutaway | Done in the mesher: axis-aligned plane; chunks in front are hidden, the crossed chunk layer is meshed with cells past the plane as air (free capped cross-section); entities/vegetation past the plane discarded via `uCutPlane`. |
| D10 | Raycast | `world.raycast` voxel DDA + refinement; used for picking, dig-paint, camera collision, line of sight. No three.js mesh raycasts against terrain. |
| D11 | Locomotion | One model for every surface walker: continuous position constrained to the isosurface, re-projected each tick; `up` from trilinear gradient → fallback summed solid-neighbour offsets → previous `up`, smoothed. Paths are cell waypoints. Classes: `surface`, `fly` (air steering + raycast avoidance, no A*), `static`. Each mover has a clearance radius (big predators can't enter tunnels — a feature). |
| D12 | Loss of support | If an entity's cell stops being walkable it falls along −y to the next walkable cell (no damage); same for items/corpses. |
| D13 | Pose | `{id, pos, prevPos, up, prevUp, forward, cell}`; renderer interpolates. |
| D14 | Possession input | Tick-stamped `possessInput {move:{x,y}, yawDelta, sprint, actions}` commands; camera yaw accumulates about a slerped local up (never world Euler); 3rd-person boom shortened by voxel raycast; near plane 0.02. |
| D15 | Nav | A* over walkable cells (26-neighbourhood, clearance-aware, expansion cap) through a **budgeted per-tick path queue**; `nearestWalkable`; per-colony BFS home distance field (Uint16, throttled rebuild after edits). Homing uses the field, not a pheromone. |
| D16 | Pheromones | Per-colony channels `food, alarm, death, dig, rally, attack, avoid, trail`. Storage: cell→slot map into pooled Float32Arrays with an active list; evaporate at 2 Hz; **no diffusion** — ants sample three forward sensors. API: `deposit, sample, forEachActive, clearCell`. |
| D17 | Water | Sparse flooded-cell field filled lowest-first from sources (rain at entrances, keeper dropper), draining over time; `isFlooded(cell)`, `depthAt(cell)`. Puddles outdoors come from the same field. |
| D18 | Climbables | Stems, twigs, mushrooms, logs are **voxels** (`Plant`/`Wood`) so ants can climb them (aphid herds, fungus summit). Thin instanced grass/leaf decoration is render-only on top. |
| D19 | Events | Buffered per tick, drained once per render frame (must survive many ticks per frame at 4×). |
| D20 | Defs | `MapDef.generate(seed, opts) → {world, spawns, foodSources, props, cameraMode, environment, boundary, flags, goal}`. `SpeciesDef` = castes + stats + **capability flags** (`canFill, eatsWood, farmsFungus, rafts, herdsAphids, sunSensitive`). |
| D21 | Debug API | `window.__myrme = { ready, step(n), setCamera(pose), freezeTime(b), stateHash(), stats(), sim, command(cmd), select(ids), possess(id), release() }`; URL params `map, faction, seed, quality, autostart, shot`. |
| D22 | Concurrency | Shared working tree (no commits by agents); disjoint path ownership (§9); frozen `core/contracts.ts` during waves with per-stream `core/contracts/<stream>.ts`; scoped gate `npm run check -- <paths>`; browser runs serialised with a file lock inside `tools/shots.mjs`; orchestrator snapshots the tree between waves. |

## 7. Content

**Maps:** Meadow · Forest floor · Desert (outdoor, seeded, `boundary:'open'`) — Gel Farm (backlit
blue gel, the gel is edible) · Sand Farm (colour-strata sand between panes) · Formicarium
(plaster block with pre-carved chambers, tubes, and an open-top outworld tray).

**Fauna:** rival colonies (any faction, AI-run) · jumping spider (hunter) · antlion (pit trap,
static) · ground beetle (tank) · parasitic wasp (flyer) · mantis (boss) · aphids (herdable, on
stems) · caterpillars/worms (prey → food).

**Adversities:** rain (droplet impacts, trail washout, flooding) · heat/drought (desiccation,
midday penalty) · cold nights (slow) · wind (faster trail decay) · scarcity · **zombie fungus**:
spore exposure → incubation → erratic walking → summit climb + death grip → fruiting stalk →
spore burst. Healthy workers smell late-stage infection and haul the victim to the midden;
the player can exile or cull early.

## 8. Milestones

| Milestone | Mode | Exit criteria |
|---|---|---|
| **M0 Skeleton** | 1 agent, then orchestrator contract sign-off | 200 ants wander on floors, walls and ceilings on Meadow and Gel Farm fixtures; instanced; selectable; possessable 1st/3rd; cutaway works; all registries + stubs exist; `npm run check`, `npm run e2e`, `npm run shots` pass; GPU/SwiftShader path proven; determinism hash test passes. The wander sim stays as a fixture (`?fixture=wander`). |
| **M1 Wave A = MVP** | 6 parallel streams | Colony self-sustains 10 sim-minutes on Meadow and Gel Farm in soak tests; all six maps generate; visual pipeline in place; HUD + orders + beacons work. |
| **Contract pass** | orchestrator | Review/extend state + event shapes B streams share (weather, water, infection, combat, goals). |
| **M2 Wave B = Target** | 5 parallel streams | Everything in §3 Target reachable in game; soak tests with threats enabled. |
| **M3 Integration** | orchestrator + targeted fix agents (bounded: two fix rounds) | Scripted playtests, screenshot checklist, perf proxies within budget, README. |

## 9. Ownership

| Stream | Owns | Builds |
|---|---|---|
| **M0** | everything initially; afterwards `core/`, `game/`, `render/Renderer.ts`, `render/shared*`, registries, `tools/`, configs stay orchestrator-owned | Skeleton |
| **A1 Worldgen** | `world/generators/**`, `world/maps.ts` content, `world/noise*` | 6 map generators, voxel plants/props, food-source placement, spawn chambers |
| **A2a Locomotion** | `world/nav*`, `world/pheromones*`, `world/raycast*`, `sim/systems/{movement,paths,pheromone,dig,falling}*` | Hardened crawling, A*, home fields, pheromone store, dig/fill execution |
| **A2b Colony brain** | `sim/behaviors/**` (M1 set), `sim/systems/{brain,colony,brood,jobs,food,orders,possession}*`, `sim/data/species/gardenAnt*` | Behaviors, job board, lifecycle, orders, beacons, possession actions |
| **A3 Environment render** | `render/modules/{terrain,sky,lighting,vegetation,habitat,postlook,cutawayLight}*`, `assets/textures/**` | Materials, sky, day/night, vegetation, gel/glass/room, look tuning |
| **A4 Creature render** | `render/modules/{ants,brood,items,selection,pheromoneViz,particles}*`, `assets/geometry/**` | Ant/termite/insect geometry, instancing, gait shader, fx base |
| **A5 Input/UI** | `input/**`, `ui/**` | Cameras, selection, orders, beacons, HUD, minimap |
| **B1 Threats** | `sim/systems/{combat,creatures,rivals,director}*`, `sim/behaviors/{fight,flee,guard,raid}*`, `sim/data/creatures*` | Combat, predators, rival AI, director |
| **B2 Environment sim** | `sim/systems/{weather,water,temperature,fungus}*`, `world/water*`, `sim/behaviors/{infected,floodEscape,hygiene}*` | Weather, flooding, temperature, fungus cycle |
| **B3 Factions & modes** | `sim/data/species/{fireAnt,leafcutter,termite}*`, `sim/systems/{termiteBuild,fungusGarden,raft,aphids,keeper,goals}*`, matching behaviors | Factions, keeper events, goals/win/lose, nuptial flight |
| **B4 VFX** | `render/modules/{weatherFx,waterFx,fungusFx,combatFx,creatures,keeperFx}*` | Weather/water/fungus/combat visuals, creature models |
| **B5 Shell & audio** | `ui/{menu,tutorial,settings,goals,colonyPanel}*`, `audio/**` | Menus, tutorial, settings, goal UI, audio |

Ports: M0 5200 · A1 5201 · A2a 5202 · A2b 5203 · A3 5204 · A4 5205 · A5 5206 · B1–B5 5211–5215 ·
orchestrator 5199.

## 10. Subagent protocol
1. Read this plan and `src/core/contracts.ts` first. Work only in your owned paths.
2. Need something from another stream? Code against the contract; if the contract lacks it, add
   it to `core/contracts/<your-stream>.ts` and report it — never edit another stream's file.
3. No git commits, no new dependencies unless essential (report them), no edits to registries.
4. Gate: `npm run check -- <your paths>` (typecheck filtered to your paths + your unit tests).
   Other streams' in-flight errors are not yours to fix — mention them, don't touch them.
5. Browser checks only through `npm run shots -- --port <yours> …` (serialised by lock). Look at
   your own screenshots before reporting.
6. Leave the game runnable. Report: what was built, how it was verified (commands + results),
   contract additions, known gaps.

## 11. Testing & verification
- **Unit:** voxel edits, mesher seams (watertight across chunk borders), raycast, nav, pheromone
  decay, brood lifecycle, queue suspend/resume under possession, combat, fungus stages, water.
- **Determinism:** same seed + commands ⇒ identical `stateHash` after 600 ticks.
- **Soak (headless, capped ≤ 60 s wall each):** seeded colony per map; assert survival, growth,
  dug volume, no NaN poses, no entity inside solid, no stuck ants beyond a threshold.
- **E2E (orchestrator-run, serial):** boot each map at `quality=low`, step via debug API, no
  console errors, canvas non-blank, select → order → possess → release.
- **Shots:** fixed tick, frozen time uniforms, 960×540 (plus a few 1920×1080 hero poses), fixed
  camera poses per map. Checklist per shot: terrain reads at ant scale · ants visible, grounded,
  correctly oriented · no cracks/seams/z-fighting · lighting has depth (AO + shadow + rim) ·
  HUD legible · gel glows and tunnels read through the pane.
- **Perf proxies:** `renderer.info` draw calls/triangles, CPU frame ms, sim ms/tick from `stats()`.

## 12. Performance budgets
- 1,000 ants + 200 other entities; sim ≤ 4 ms/tick average; path budget per tick so 4× speed
  stays under ~50% of the main thread.
- ≤ 250 draw calls and ≤ 3 M triangles at "high" on Meadow; map generation ≤ 5 s.
- Memory: Meadow 192×64×192 ≈ 2.4 M cells ≈ 4.7 MB (density+material) + 4.7 MB per home field.

## 13. Risks

| Risk | Mitigation |
|---|---|
| Surface crawling is fiddly | Proven in M0 before fan-out; D3/D4/D11/D12; soak invariants; unstuck fallback. |
| Parallel agents collide | D22: disjoint paths, pre-wired registries, frozen contracts, scoped gate, snapshots. |
| Underground/farm visibility | D6/D7/D9 + slab camera + underground fill light, all in M0. |
| Postfx too heavy / DoF hurts readability | Presets, dynamic resolution, DoF policy (§5.3). |
| Headless rendering unreliable | M0 proves GPU or SwiftShader path; fixed-tick low-res shots; serialised runs. |
| No real game loop | §2 goals, lose condition, director, keeper events, faction twists. |
| Scope explosion | §3 tiers + explicit cut order; every wave leaves the game runnable. |

## 14. Definition of done
- `npm run dev` → menu → every map × faction loads and plays; goals can be won and lost.
- Colony survives autonomously 10+ sim-minutes on Meadow and Gel Farm with threats on.
- All Target features present, minus anything explicitly cut per §3 and listed in the README.
- `npm run check` and `npm run e2e` green; every shot passes the §11 checklist.

## 15. Acceptance per stream
- **A1:** each map generates < 5 s, has a connected walkable region containing spawn + ≥ 1 food
  source, voxel climbables present, farms obey D6/D7; unit tests per generator.
- **A2a:** 1,000 wanderers for 3,000 ticks with zero NaN/inside-solid/permanently-stuck; A* and
  home field tests; dig carves and remeshes; falling works.
- **A2b:** soak: colony grows from 10 workers to 40+ in 10 sim-minutes on Meadow; trails form
  (measurable `food` pheromone between nest and source); orders and possession tests.
- **A3 / A4 / B4:** shots pass the checklist; proxies within §12; no console errors at any preset.
- **A5 / B5:** e2e flows for select/order/possess/release, menu → game → menu, settings persist.
- **B1:** soak with director on: fights resolve, colony can both win and lose encounters.
- **B2:** rain floods low galleries then drains; fungus full cycle test; hygiene removes corpses.
- **B3:** each faction's twist verified by a test (termite fill, leafcutter chain, raft, aphids);
  goals fire win/lose events; keeper events run on farm maps.

## 16. Revision history
- **v1** — initial draft: vision, stack, architecture, content, wave outline.
- **v2** — after independent gap review. Added: player experience, win/lose, director, keeper
  events and faction twists (§2); tier↔milestone mapping and cut order (§3); 22 locked decisions
  (§6) covering density semantics, ant/tunnel scale, farm slab visibility, mesher-based cutaway,
  one locomotion model + possession input, falling, flyers, pooled pheromones, water, climbable
  voxel plants, event buffering; M0 upgraded from stubs to a walking skeleton with exit criteria
  (§8); A2 split, renderer skeleton ownership, explicit ownership + port table (§9); scoped gate
  and serialised browser runs (§10–11); proxy perf budgets (§12); acceptance per stream (§15).
