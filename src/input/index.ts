import {
  ISO,
  Mat,
  ORDER_PING_SECONDS,
  clamp,
  v3,
  v3clone,
  v3copy,
  type ActiveTool,
  type AppContext,
  type BeaconKind,
  type CameraPose,
  type CreatureId,
  type CreatureRole,
  type CutPlane,
  type EntityId,
  type FrameInfo,
  type InputLayer,
  type OrderKind,
  type PossessActions,
  type RayHit,
  type Vec3,
  type ViewExtA5,
  type ViewStateA5,
} from '../core';
import { getCreature } from '../sim/data/creatures';
import { getCaste, getSpecies } from '../sim/data/species';
import { registerInputApi, type InputApi, type InputHint, type InputSettings, type SelectMode } from './api';
import { CameraBlend, PossessRig, RtsRig, SlabRig, applyPose, resolvePose } from './cameras';
import { Keymap, chordDigit, chordOf, type ActionId } from './keybinds';
import { contextOrder, type OrderTarget } from './orders';
import { Picker } from './picking';
import { BRUSH_SIZES, beaconUnderCursor, brushCenter, hopCandidates, nextBrushSize, stampSpacing } from './tools';
import { ControlGroups, boxPick, combineSelection, cycleId, isDrag, pointPick, selectMode } from './selection';

export { getInputApi } from './api';
export type { InputApi, InputHint, InputSettings, SelectMode } from './api';
export { ACTIONS, Keymap, formatChord, formatKeys } from './keybinds';
export type { ActionId } from './keybinds';

/**
 * Input layer (§5.4): cameras, selection, contextual orders, paint tools, beacons, possession.
 *
 *  - Single writer of `app.view` (and its A5 extension `viewExt(view)`).
 *  - Talks to the sim only through `app.command(...)` (§5.1).
 *  - Every key goes through the central `Keymap` (see keybinds.ts for the table).
 *  - Camera smoothing runs on real time, so it keeps working while the sim clock is frozen or
 *    paused; `snapCamera()` / `setCameraPose()` make shots deterministic.
 */

const MILITARY: readonly string[] = ['soldier', 'major', 'nasute'];
const IDLE_BEHAVIORS: readonly string[] = ['', 'idle', 'wander'];
const SPEEDS = [1, 2, 4] as const;
const creatureRole = (def: CreatureId): CreatureRole => getCreature(def).role;
const NO_ACTIONS = (): PossessActions => ({ bite: false, dig: false, pickup: false, trail: false, recruit: false });

/**
 * M3: the opening view. The map's authored `cameraStart` looks at the DEFAULT nest site; a colony
 * that settles elsewhere at init (termites move under the deadwood) gets the same view moved onto
 * its own nest, and on outdoor maps a view whose line of sight to the nest mouth is blocked (a
 * grass stem right in front of the lens) is swung around the nest to the first clear bearing.
 */
function startPose(sim: AppContext['sim']): CameraPose {
  const base = sim.map.cameraStart;
  const col = sim.colonies.find((c) => c.id === sim.playerColony);
  if (!col || sim.options.fixture === 'wander' || sim.map.cameraMode !== 'rts') return base;
  const w = sim.world;
  const focus = col.entrances.length > 0 && col.entrances[0] >= 0 ? w.cellCenter(col.entrances[0], v3()) : col.nestPos;
  let [tx, ty, tz] = base.target;
  let ox = base.pos[0] - tx;
  const oy = base.pos[1] - ty;
  let oz = base.pos[2] - tz;
  const moved = Math.hypot(focus.x - tx, focus.z - tz) > 8;
  if (moved) {
    tx = focus.x;
    ty = Math.max(ty, focus.y);
    tz = focus.z;
  }
  const blocked = (dx: number, dz: number): number => {
    const len = Math.hypot(dx, oy, dz);
    let hits = 0;
    for (let d = 4; d < len; d += 1) {
      const x = tx + (dx * d) / len;
      const y = ty + 1.5 + (oy * d) / len;
      const z = tz + (dz * d) / len;
      if (w.inBounds(Math.floor(x), Math.floor(y), Math.floor(z)) && w.sample(x, y, z) >= ISO) hits++;
    }
    return hits;
  };
  let best = blocked(ox, oz);
  if (best === 0 && !moved) return base;
  if (best > 0) {
    const x0 = ox;
    const z0 = oz;
    for (const deg of [30, -30, 60, -60, 90, -90, 135, -135, 180]) {
      const a = (deg * Math.PI) / 180;
      const dx = x0 * Math.cos(a) - z0 * Math.sin(a);
      const dz = x0 * Math.sin(a) + z0 * Math.cos(a);
      const h = blocked(dx, dz);
      if (h < best) {
        best = h;
        ox = dx;
        oz = dz;
        if (h === 0) break;
      }
    }
  }
  return { ...base, pos: [tx + ox, ty + oy, tz + oz], target: [tx, ty, tz] };
}

export function createInput(): InputLayer {
  let app!: AppContext;
  let ext!: ViewExtA5;
  let picker!: Picker;
  let rts!: RtsRig;
  let slab!: SlabRig;
  const possess = new PossessRig();
  const blend = new CameraBlend();
  const keymap = new Keymap();
  const groups = new ControlGroups();
  const settings: InputSettings = { edgeScroll: false, mouseSensitivity: 1, invertY: false };
  const down = new Set<string>();
  const disposers: (() => void)[] = [];
  const actionSubs = new Set<(a: ActionId) => void>();
  const escapeStack: (() => boolean)[] = [];

  // ---- camera state ----
  let poseLock: CameraPose | null = null;
  let camUsed = false; // a camera action happened this frame (breaks the pose lock)
  let lastNow = -1;
  let renderTime = 0;
  let groundTimer = 0;
  let savedCut: CutPlane | null = null; // cutaway suspended while possessing

  // ---- pointer state ----
  let wheel = 0;
  let orbitDX = 0;
  let orbitDY = 0;
  let dragPanDX = 0;
  let dragPanDY = 0;
  let mouseYaw = 0;
  let mousePitch = 0;
  let lDown: { x: number; y: number; shift: boolean; ctrl: boolean } | null = null;
  let rDown: { x: number; y: number; moved: boolean } | null = null;
  let mDown = false;
  let painting: { lastX: number; lastY: number; erase: boolean } | null = null;
  let strokeClearAt = -1;
  let lastClick = { time: -1e9, x: 0, y: 0, id: 0 };
  let winMouse = { x: -1, y: -1, inside: false };
  let hoverDirty = true;
  let cursorStyle = '';

  // ---- possession state ----
  let lastPossessPos: Vec3 | null = null;
  let lastPossessId = 0;
  let pendingActions = NO_ACTIONS();
  let actionsPending = false;
  let yawAccum = 0;
  let lastSent = { x: 0, y: 0, sprint: false, tick: -1 };
  let trailOn = false;
  const hopHistory: EntityId[] = [];
  let hopBack = false;
  let lockExitBySelf = false;
  let pingSeq = 1;
  let idleCursor = 0;

  // ---- auto cutaway + opening camera move ----
  const hintSubs = new Set<(hint: InputHint) => void>();
  /** Pending "did that jump land underground?" check (seconds left, where). */
  let autoCutTimer = -1;
  let autoCutPos: Vec3 | null = null;
  /** The enabled cut was switched on automatically (not by the player). */
  let cutIsAuto = false;
  /** The player switched an automatic cut off: stop offering it until they ask (double-tap home). */
  let autoCutDeclined = false;
  let lastHomeTap = -1e9;
  let intro: { t: number; stage: 0 | 1; to: Vec3; from: Vec3; d0: number; d1: number } | null = null;
  const INTRO_HOLD = 1.1;
  const INTRO_MOVE = 3.4;
  const HOME_DOUBLE_TAP_MS = 450;

  const listen = (el: HTMLElement | Window | Document, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions): void => {
    el.addEventListener(type, fn as EventListener, opts);
    disposers.push(() => el.removeEventListener(type, fn as EventListener, opts));
  };

  const isMap = (): boolean => app.view.mode !== 'possess';
  const ownAnt = (id: EntityId) => {
    const a = app.sim.getAnt(id);
    return a && a.alive && a.colony === app.sim.playerColony ? a : undefined;
  };
  const activeCut = (): CutPlane | null => (app.view.cut.enabled ? app.view.cut : null);
  const playerColony = () => app.sim.getColony(app.sim.playerColony);
  const canFill = (): boolean => {
    const c = playerColony();
    return !!c && getSpecies(c.species).caps.canFill;
  };

  // =====================================================================================
  // selection
  // =====================================================================================

  function setSelection(ids: EntityId[], primary = 0): void {
    app.view.selection = ids;
    ext.primaryId = primary && ids.includes(primary) ? primary : (ids[0] ?? 0);
    if (ext.followId && !ids.includes(ext.followId)) ext.followId = 0;
  }

  function applySelect(ids: EntityId[], mode: SelectMode): void {
    const next = combineSelection(app.view.selection, ids, mode);
    setSelection(next, mode === 'replace' ? (ids[0] ?? 0) : ext.primaryId || (ids[0] ?? 0));
  }

  function clickSelect(x: number, y: number, mode: SelectMode, timeMs: number): void {
    const cands = pointPick(picker.ownAnts(), x, y);
    let id = 0;
    for (const c of cands) {
      const a = app.sim.getAnt(c.id);
      if (a && picker.visible(a.pos, a.up)) {
        id = c.id;
        break;
      }
    }
    const dbl = id !== 0 && lastClick.id === id && timeMs - lastClick.time < 340 && Math.hypot(x - lastClick.x, y - lastClick.y) < 8;
    lastClick = dbl ? { time: -1e9, x, y, id: 0 } : { time: timeMs, x, y, id };
    if (dbl) {
      // double-click: every visible ant of the same caste on screen
      const caste = app.sim.getAnt(id)!.caste;
      const same = picker
        .ownAnts()
        .filter((c) => app.sim.getAnt(c.id)?.caste === caste)
        .map((c) => c.id)
        .filter((i) => {
          const a = app.sim.getAnt(i)!;
          return picker.visible(a.pos, a.up);
        });
      applySelect(same, mode === 'toggle' ? 'add' : mode);
      ext.primaryId = id;
      return;
    }
    if (id) {
      applySelect([id], mode);
      if (mode !== 'toggle') ext.primaryId = id;
    } else if (mode === 'replace') setSelection([]);
  }

  function boxSelect(box: { x0: number; y0: number; x1: number; y1: number }, mode: SelectMode): void {
    const ids = boxPick(picker.ownAnts(), box)
      .map((c) => c.id)
      .filter((id) => {
        const a = app.sim.getAnt(id)!;
        return picker.visible(a.pos, a.up);
      });
    applySelect(ids, mode);
  }

  function selectedOwn(): EntityId[] {
    return app.view.selection.filter((id) => ownAnt(id));
  }

  function centroid(ids: readonly EntityId[]): { pos: Vec3; spread: number } | null {
    const c = v3();
    let n = 0;
    for (const id of ids) {
      const a = app.sim.getAnt(id);
      if (!a) continue;
      c.x += a.pos.x;
      c.y += a.pos.y;
      c.z += a.pos.z;
      n++;
    }
    if (!n) return null;
    c.x /= n;
    c.y /= n;
    c.z /= n;
    let spread = 0;
    for (const id of ids) {
      const a = app.sim.getAnt(id);
      if (a) spread = Math.max(spread, Math.hypot(a.pos.x - c.x, a.pos.y - c.y, a.pos.z - c.z));
    }
    return { pos: c, spread };
  }

  // =====================================================================================
  // camera helpers
  // =====================================================================================

  function jumpTo(pos: Vec3, dist?: number): void {
    poseLock = null;
    ext.followId = 0;
    if (app.sim.map.cameraMode === 'rts') {
      rts.lookAt(pos, dist ?? null, activeCut());
      rts.groundY = null;
      groundTimer = 0;
      // once the camera has settled: if the focus turned out to be underground, open the cutaway
      if (!activeCut() && !autoCutDeclined && !app.params.shot) {
        autoCutPos = v3clone(pos);
        autoCutTimer = 0.4;
      }
    } else slab.lookAt(pos, dist ?? null);
  }

  const emitHint = (hint: InputHint): void => {
    for (const fn of [...hintSubs]) fn(hint);
  };

  /** Solid cells in the column above a point (a chamber / tunnel has a roof, the surface has not). */
  function roofAbove(p: Vec3): number {
    const w = app.sim.world;
    const x = Math.floor(p.x);
    const z = Math.floor(p.z);
    let solid = 0;
    for (let y = Math.floor(p.y) + 1; y < w.sy && solid < 3; y++) if (w.inBounds(x, y, z) && w.isSolid(x, y, z)) solid++;
    return solid;
  }

  /**
   * True when `p` is under a roof AND the map camera cannot show it properly: the terrain is in
   * the way, or the boom collapsed and the eye now sits inside the dark tunnel itself.
   */
  function focusBuried(p: Vec3): boolean {
    if (roofAbove(p) < 3) return false;
    const c = app.view.camera.pos;
    if (roofAbove(c) >= 1 || app.view.camera.focusDist < rts.dist * 0.7) return true;
    const dx = p.x - c.x;
    const dy = p.y + 0.3 - c.y;
    const dz = p.z - c.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return false;
    const hit = app.sim.world.raycast(c, v3(dx / len, dy / len, dz / len), len);
    return !!hit && hit.dist < len - 1.5;
  }

  /** Switch the cutaway on for the player, snapped to `p` (the HUD explains it with the `C` key). */
  function autoCut(p: Vec3): void {
    if (app.sim.map.cameraMode !== 'rts' || app.view.mode !== 'rts') return;
    const wasOn = app.view.cut.enabled;
    snapCut(p);
    if (!wasOn) cutIsAuto = true;
    emitHint('autoCut');
  }

  function endIntro(skipped: boolean): void {
    if (!intro) return;
    intro = null;
    emitHint(skipped ? 'introSkip' : 'introEnd');
  }

  function playIntro(): boolean {
    const sim = app.sim;
    if (intro) return true;
    if (sim.map.cameraMode !== 'rts' || app.view.mode !== 'rts' || app.params.shot || app.view.cut.enabled) return false;
    const col = playerColony();
    if (!col) return false;
    const queen = sim.getAnt(col.queenId);
    const to = v3clone(queen && queen.alive ? queen.pos : col.nestPos);
    if (roofAbove(to) < 3) return false;
    intro = { t: 0, stage: 0, to, from: v3(), d0: 0, d1: 0 };
    emitHint('introStart');
    return true;
  }

  /** Advance the opening move (real time). Stage 0 holds the authored start view. */
  function stepIntro(dt: number): void {
    const it = intro;
    if (!it) return;
    it.t += dt;
    if (it.stage === 0) {
      if (it.t < INTRO_HOLD) return;
      const from = v3clone(rts.target);
      const d0 = clamp(rts.dist, 14, 34);
      snapCut(it.to);
      cutIsAuto = true;
      const cut = app.view.cut;
      v3copy(it.to, rts.target); // snapped onto the plane, lifted to chamber height
      rts.lookAt(from, d0, cut);
      v3copy(it.from, rts.target);
      it.d0 = d0;
      it.d1 = clamp(d0 * 0.55, 9, 14);
      it.stage = 1;
      return;
    }
    const k = clamp((it.t - INTRO_HOLD) / INTRO_MOVE, 0, 1);
    const s = k * k * (3 - 2 * k);
    const a = it.from;
    const b = it.to;
    rts.lookAt(v3(a.x + (b.x - a.x) * s, a.y + (b.y - a.y) * s, a.z + (b.z - a.z) * s), it.d0 + (it.d1 - it.d0) * s, app.view.cut);
    if (k >= 1) endIntro(false);
  }

  function focusSelection(): void {
    const c = centroid(app.view.selection);
    if (!c) return;
    const cur = app.sim.map.cameraMode === 'rts' ? rts.dist : slab.dist;
    jumpTo(c.pos, clamp(Math.max(7, c.spread * 2.6), 5, Math.max(cur, 7)));
  }

  function jumpToNest(): void {
    const col = playerColony();
    if (col) jumpTo(col.nestPos, Math.min(app.sim.map.cameraMode === 'rts' ? rts.dist : slab.dist, 26));
  }

  /** `H`: jump to the nest; a quick second tap also opens the cutaway on it. */
  function homeKey(): void {
    const now = performance.now();
    const col = playerColony();
    const double = now - lastHomeTap < HOME_DOUBLE_TAP_MS;
    lastHomeTap = double ? -1e9 : now;
    if (double && col && app.sim.map.cameraMode === 'rts' && app.view.mode === 'rts') {
      autoCutDeclined = false;
      autoCutTimer = -1;
      autoCut(col.nestPos);
    } else jumpToNest();
  }

  /** RTS yaw that looks straight at the exposed face of a vertical cut (orbit yaw 0 = eye on +z). */
  const cutSquareYaw = (cut: CutPlane): number | null => (cut.axis === 'y' ? null : cut.axis === 'z' ? (cut.sign > 0 ? 0 : Math.PI) : (cut.sign * Math.PI) / 2);

  function setCut(enabled: boolean): void {
    const view = app.view;
    if (enabled === view.cut.enabled) return;
    autoCutTimer = -1;
    if (!enabled) {
      view.cut = { ...view.cut, enabled: false };
      rts.onCutToggle(false, false);
      cutIsAuto = false;
      return;
    }
    const f = view.camera.forward;
    const focus = view.camera.focus;
    // hide the half of the world between the camera and its focus, along the dominant view axis
    if (Math.abs(f.y) > 0.92) view.cut = { enabled: true, axis: 'y', pos: Math.round(focus.y) - 4, sign: 1 };
    else if (Math.abs(f.x) > Math.abs(f.z)) view.cut = { enabled: true, axis: 'x', pos: Math.round(focus.x), sign: f.x > 0 ? -1 : 1 };
    else view.cut = { enabled: true, axis: 'z', pos: Math.round(focus.z), sign: f.z > 0 ? -1 : 1 };
    if (view.mode === 'rts' && !poseLock) {
      rts.onCutToggle(true, view.cut.axis !== 'y', cutSquareYaw(view.cut));
      rts.lookAt(rts.target, null, view.cut);
    }
  }

  function moveCut(steps: number): void {
    const c = app.view.cut;
    if (!c.enabled || !steps) return;
    const w = app.sim.world;
    const max = c.axis === 'x' ? w.sx : c.axis === 'y' ? w.sy : w.sz;
    // "]" pushes the plane away from the viewer (hides more), "[" pulls it back
    app.view.cut = { ...c, pos: clamp(c.pos - c.sign * steps, 0, max) };
    if (app.view.mode === 'rts' && !poseLock) rts.lookAt(rts.target, null, app.view.cut);
  }

  /** Put the cut plane just in front of `at` — or the selection, or the nest — and look at it. */
  function snapCut(at?: Vec3): void {
    const view = app.view;
    const c = at ? null : centroid(app.view.selection);
    const p = at ?? (c ? c.pos : playerColony()?.nestPos);
    if (!p) return;
    if (!view.cut.enabled) setCut(true);
    let cut = view.cut;
    if (cut.axis === 'y') {
      // a horizontal slice just above the point
      cut = { ...cut, pos: Math.ceil(p.y + 1), sign: 1 };
    } else {
      const v = cut.axis === 'x' ? p.x : p.z;
      // keep the point itself (and the middle of its tunnel) on the visible side
      cut = { ...cut, pos: cut.sign > 0 ? Math.ceil(v + 0.6) : Math.floor(v - 0.6) };
    }
    view.cut = cut;
    if (app.sim.map.cameraMode === 'rts') {
      poseLock = null;
      ext.followId = 0;
      rts.onCutToggle(true, cut.axis !== 'y', cutSquareYaw(cut));
      // chambers extend above the point (nestPos / an ant sits on the floor): frame the room, not the floor
      rts.lookAt(cut.axis === 'y' ? p : v3(p.x, p.y + 1.6, p.z), Math.min(rts.dist, 19), cut);
    } else jumpTo(p);
  }

  // =====================================================================================
  // orders, tools, beacons
  // =====================================================================================

  function ping(order: OrderKind, pos: Vec3 | null, targetId: EntityId, ids: EntityId[], queued: boolean): void {
    ext.orderPings.push({ seq: pingSeq++, order, pos: pos ? v3clone(pos) : null, targetId, ids, queued, time: renderTime });
    if (ext.orderPings.length > 24) ext.orderPings.shift();
  }

  function orderAt(x: number, y: number, shift: boolean, alt: boolean): void {
    const ids = selectedOwn();
    if (!ids.length) return;
    const sim = app.sim;
    let target: OrderTarget | null = null;
    const hov = picker.entityAt(x, y, 0.6);
    if (hov) {
      const e = hov.entity;
      target = {
        kind: hov.kind,
        id: hov.id,
        pos: e.pos,
        cell: e.cell,
        colony: 'colony' in e ? e.colony : 0,
        creatureRole: undefined,
        itemKind: e.kind === 'item' ? e.itemKind : undefined,
      };
      if (e.kind === 'creature') target.creatureRole = creatureRole(e.def);
    } else {
      const hit = picker.rayAt(x, y);
      if (!hit) return;
      const pos = hit.airCell >= 0 ? sim.world.cellCenter(hit.airCell, v3()) : v3clone(hit.pos);
      target = { kind: 'terrain', id: 0, pos, cell: hit.airCell, colony: 0 };
    }
    const cmd = contextOrder(ids, target, { shift, alt }, sim.playerColony);
    if (!cmd) return;
    app.command(cmd);
    ping(cmd.order, cmd.pos ?? null, cmd.targetId ?? 0, cmd.ids, !!cmd.queue);
  }

  function orderSelection(order: 'stop' | 'exile'): void {
    const ids = selectedOwn();
    if (!ids.length) return;
    app.command({ type: 'order', ids, order });
    ping(order, null, 0, ids, false);
  }

  function setTool(tool: ActiveTool): void {
    if (tool === 'build' && !canFill()) tool = null;
    if (!isMap()) tool = null;
    ext.activeTool = tool;
    app.view.tool = tool === 'dig' || tool === 'build' ? tool : null;
    ext.brush = null;
    ext.beaconPreview = null;
    painting = null;
    if (tool) {
      lDown = null;
      app.view.dragBox = null;
    }
    hoverDirty = true;
  }

  const paintKind = (): 'dig' | 'build' | null => (ext.activeTool === 'dig' || ext.activeTool === 'build' ? ext.activeTool : null);
  const beaconKind = (): BeaconKind | null => (ext.activeTool && ext.activeTool.startsWith('beacon:') ? (ext.activeTool.slice(7) as BeaconKind) : null);

  function brushFor(hit: RayHit | null, erase: boolean): ViewExtA5['brush'] {
    const kind = paintKind();
    if (!hit || !kind) return null;
    const flags = app.sim.map.flags;
    const w = app.sim.world;
    const b = brushCenter(hit, kind, ext.brushRadius, app.view.cut, flags.slab ? { axis: flags.slabAxis, mid: flags.slabAxis === 'z' ? w.sz / 2 : w.sx / 2 } : null);
    if (!b) return null;
    return { kind, center: b.center, normal: v3clone(hit.normal), radius: ext.brushRadius, erase, onCutFace: b.onCutFace };
  }

  function stampAt(x: number, y: number): void {
    if (!painting) return;
    const kind = paintKind();
    if (!kind) return;
    const b = brushFor(picker.rayAt(x, y), painting.erase);
    if (!b) return;
    const min = stampSpacing(b.radius);
    for (const s of ext.stroke) {
      if (Math.hypot(s.center.x - b.center.x, s.center.y - b.center.y, s.center.z - b.center.z) < min) return;
    }
    if (ext.stroke.length >= 400) return;
    ext.stroke.push({ kind, center: b.center, radius: b.radius, erase: b.erase });
    if (kind === 'build') app.command({ type: 'designate', kind, op: b.erase ? 'remove' : 'add', center: v3clone(b.center), radius: b.radius, material: Mat.Mud });
    else app.command({ type: 'designate', kind, op: b.erase ? 'remove' : 'add', center: v3clone(b.center), radius: b.radius });
  }

  /** Stamp along the cursor path so a fast drag leaves no gaps. */
  function paintTo(x: number, y: number): void {
    if (!painting) return;
    const dx = x - painting.lastX;
    const dy = y - painting.lastY;
    const n = Math.min(24, Math.max(1, Math.ceil(Math.hypot(dx, dy) / 10)));
    for (let i = 1; i <= n; i++) stampAt(painting.lastX + (dx * i) / n, painting.lastY + (dy * i) / n);
    painting.lastX = x;
    painting.lastY = y;
  }

  function beaconClick(x: number, y: number, keepTool: boolean): void {
    const kind = beaconKind();
    const col = playerColony();
    if (!kind || !col) return;
    const hit = picker.rayAt(x, y);
    const under = beaconUnderCursor(col.beacons, hit ? hit.pos : null, (p) => (picker.project(p) ? { x: picker.sx, y: picker.sy } : null), x, y);
    if (under) {
      app.command({ type: 'beacon', op: 'remove', id: under });
      return;
    }
    if (!hit) return;
    const pos = hit.airCell >= 0 ? app.sim.world.cellCenter(hit.airCell, v3()) : v3clone(hit.pos);
    app.command({ type: 'beacon', op: 'place', kind, pos });
    if (!keepTool) setTool(null);
  }

  // =====================================================================================
  // possession
  // =====================================================================================

  function requestLock(): void {
    if (app.params.shot || document.pointerLockElement === app.canvas) return;
    try {
      const r = app.canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
      r?.catch?.(() => {});
    } catch {
      /* pointer lock unavailable (headless, iframe policy): arrow keys still turn */
    }
  }

  function exitLock(): void {
    if (document.pointerLockElement === app.canvas) {
      lockExitBySelf = true;
      document.exitPointerLock();
    }
  }

  function possessAnt(id?: EntityId): void {
    let target = id && ownAnt(id) ? id : 0;
    if (!target) target = ownAnt(ext.primaryId)?.id ?? selectedOwn()[0] ?? 0;
    if (!target && ext.pointer.over) {
      // nearest own ant to the cursor
      let bd = 160;
      for (const c of picker.ownAnts()) {
        const d = Math.hypot(c.x - ext.pointer.x, c.y - ext.pointer.y);
        if (d < bd && picker.antVisible(c.id)) {
          bd = d;
          target = c.id;
        }
      }
    }
    if (!target) return;
    if (app.sim.possessedId && app.sim.possessedId !== target) app.command({ type: 'possessStop' });
    app.command({ type: 'possessStart', id: target });
  }

  function release(): void {
    if (app.sim.possessedId) app.command({ type: 'possessStop' });
  }

  function hop(dir: 1 | -1): void {
    const cur = app.sim.getAnt(app.sim.possessedId);
    if (!cur) return;
    let next = 0;
    if (dir < 0) {
      while (hopHistory.length && !next) {
        const id = hopHistory.pop()!;
        if (id !== cur.id && ownAnt(id)) next = id;
      }
      hopBack = next !== 0;
    }
    if (!next) {
      const c = hopCandidates(app.sim.ants, cur, app.sim.playerColony, hopHistory.slice(-6));
      next = c[0] ?? 0;
    }
    if (!next) return;
    app.command({ type: 'possessStop' });
    app.command({ type: 'possessStart', id: next });
  }

  /** Follows `sim.possessedId`: switches view mode and starts the fly-in / fly-out blends. */
  function syncMode(): void {
    const view = app.view;
    const pid = app.sim.possessedId;
    if (pid === view.possessedId) return;
    const prev = view.possessedId;
    view.possessedId = pid;
    const cam = view.camera;
    if (pid) {
      const ant = app.sim.getAnt(pid);
      const far = ant ? Math.hypot(cam.pos.x - ant.pos.x, cam.pos.y - ant.pos.y, cam.pos.z - ant.pos.z) : 10;
      blend.start(cam, prev ? 0.45 : clamp(0.45 + Math.log2(1 + far) * 0.1, 0.5, 1.1));
      if (!prev) {
        // entering possession from the map view
        savedCut = view.cut.enabled ? { ...view.cut } : null;
        if (savedCut) view.cut = { ...view.cut, enabled: false };
        hopHistory.length = 0;
        trailOn = false;
      } else if (!hopBack) {
        hopHistory.push(prev);
        if (hopHistory.length > 16) hopHistory.shift();
      }
      hopBack = false;
      view.mode = 'possess';
      possess.reset();
      poseLock = null;
      ext.followId = 0;
      setTool(null);
      lDown = rDown = null;
      mDown = false;
      view.dragBox = null;
      view.hoverId = 0;
      ext.hoverKind = null;
      ext.hoverHostile = false;
      view.cursorWorld = null;
      pendingActions = NO_ACTIONS();
      actionsPending = false;
      yawAccum = 0;
      lastSent = { x: 0, y: 0, sprint: false, tick: -1 };
      lastPossessId = pid;
      setSelection([pid], pid);
      requestLock();
    } else {
      // back to the map camera at a sensible pose near where the ant is (or died, §5.2)
      view.mode = app.sim.map.cameraMode;
      exitLock();
      if (savedCut) view.cut = savedCut;
      savedCut = null;
      const at = lastPossessPos;
      if (at) {
        if (view.mode === 'rts') {
          const f = cam.forward;
          const horiz = Math.hypot(f.x, f.z);
          if (horiz > 0.2) rts.yaw = nearestAngle(Math.atan2(-f.x, -f.z), rts.yaw);
          rts.pitch = 0.82;
          rts.lookAt(at, clamp(rts.dist, 7, 16), activeCut());
          rts.groundY = null;
          groundTimer = 0;
          rts.snap();
        } else {
          slab.lookAt(at, clamp(slab.dist, 8, 24));
          slab.snap();
        }
      }
      blend.start(cam, 0.7);
      const still = ownAnt(lastPossessId);
      setSelection(still ? [still.id] : [], still ? still.id : 0);
      hoverDirty = true;
    }
  }

  function sendPossessInput(dt: number): void {
    const sim = app.sim;
    const mx = (keymap.held('p.right', down) ? 1 : 0) - (keymap.held('p.left', down) ? 1 : 0);
    const my = (keymap.held('p.forward', down) ? 1 : 0) - (keymap.held('p.back', down) ? 1 : 0);
    const sprint = keymap.held('p.sprint', down);
    const turn = (keymap.held('p.turnRight', down) ? 1 : 0) - (keymap.held('p.turnLeft', down) ? 1 : 0);
    const pitchKeys = (keymap.held('p.lookDown', down) ? 1 : 0) - (keymap.held('p.lookUp', down) ? 1 : 0);
    const sens = settings.mouseSensitivity;
    const yaw = mouseYaw * 0.0028 * sens + turn * 2.4 * dt;
    const pitch = mousePitch * 0.0022 * sens * (settings.invertY ? -1 : 1) + pitchKeys * 1.2 * dt;
    if (sim.paused) {
      // nothing can turn while the sim is stopped; do not bank a spin for later
      possess.addLook(0, pitch);
      yawAccum = 0;
    } else {
      possess.addLook(yaw, pitch);
      yawAccum = clamp(yawAccum + yaw, -3, 3);
    }
    const stateChanged = mx !== lastSent.x || my !== lastSent.y || sprint !== lastSent.sprint;
    const newTick = sim.tick !== lastSent.tick;
    if (stateChanged || actionsPending || (yawAccum !== 0 && newTick)) {
      app.command({ type: 'possessInput', move: { x: mx, y: my }, yawDelta: yawAccum, sprint, actions: pendingActions, tick: sim.tick });
      lastSent = { x: mx, y: my, sprint, tick: sim.tick };
      yawAccum = 0;
      pendingActions = NO_ACTIONS();
      actionsPending = false;
    }
  }

  function possessAction(a: keyof PossessActions): void {
    if (!app.sim.possessedId) return;
    pendingActions[a] = true;
    actionsPending = true;
    if (a === 'trail') trailOn = !trailOn;
  }

  // =====================================================================================
  // actions (keyboard, toolbar)
  // =====================================================================================

  function run(action: ActionId, chord = ''): void {
    const view = app.view;
    const sim = app.sim;
    switch (action) {
      // ---- camera ----
      case 'cam.focus':
        focusSelection();
        break;
      case 'cam.home':
        homeKey();
        break;
      case 'cam.follow': {
        const id = ext.followId ? 0 : (ownAnt(ext.primaryId)?.id ?? selectedOwn()[0] ?? 0);
        ext.followId = id;
        if (id) poseLock = null;
        break;
      }
      case 'cam.flip':
        if (sim.map.cameraMode === 'slab') {
          poseLock = null;
          slab.flip();
          ext.slabSide = slab.side;
        }
        break;
      // ---- view ----
      case 'view.cut':
        // switching an automatic cutaway off = "I do not want this": stop offering it on jumps
        if (view.cut.enabled && cutIsAuto) autoCutDeclined = true;
        setCut(!view.cut.enabled);
        break;
      case 'view.cutBack':
        moveCut(-1);
        break;
      case 'view.cutFwd':
        moveCut(1);
        break;
      case 'view.cutSnap':
        cutIsAuto = false;
        snapCut();
        break;
      case 'view.phero':
        view.pheroVision = !view.pheroVision;
        break;
      // ---- selection ----
      case 'sel.all': {
        const ids = picker.ownAnts().map((c) => c.id).filter((id) => picker.antVisible(id));
        setSelection(ids);
        break;
      }
      case 'sel.soldiers': {
        const ids = sim.ants.filter((a) => a.alive && a.colony === sim.playerColony && MILITARY.includes(a.caste)).map((a) => a.id);
        setSelection(ids);
        break;
      }
      case 'sel.idle': {
        const idle = sim.ants.filter((a) => a.alive && a.colony === sim.playerColony && a.caste === 'worker' && !a.possessed && a.tasks.length === 0 && !a.carrying && IDLE_BEHAVIORS.includes(a.behavior));
        if (!idle.length) break;
        if (chord.includes('Shift+')) setSelection(idle.map((a) => a.id));
        else {
          const next = idle.find((a) => a.id > idleCursor) ?? idle[0];
          idleCursor = next.id;
          setSelection([next.id]);
          jumpTo(next.pos);
        }
        break;
      }
      case 'sel.cycle': {
        const dir = chord.includes('Shift+') ? -1 : 1;
        const sel = selectedOwn();
        if (sel.length > 1) ext.primaryId = cycleId(sel, ext.primaryId, dir);
        else {
          const ids = picker.ownAnts().map((c) => c.id).sort((a, b) => a - b);
          const next = cycleId(ids, sel[0] ?? 0, dir);
          if (next) setSelection([next]);
        }
        break;
      }
      case 'group.recall': {
        const n = chordDigit(chord);
        if (!n) break;
        let ids = groups.members(n, (id) => !!ownAnt(id));
        if (!ids.length) ids = sim.ants.filter((a) => a.alive && a.colony === sim.playerColony && a.group === n).map((a) => a.id);
        const tap = groups.tap(n, performance.now());
        if (!ids.length) break;
        setSelection(ids);
        if (tap === 'focus') focusSelection();
        break;
      }
      case 'group.assign': {
        const n = chordDigit(chord);
        const ids = selectedOwn();
        if (!n) break;
        const dropped = groups.assign(n, ids);
        if (dropped.length) app.command({ type: 'setGroup', ids: dropped, group: 0 });
        if (ids.length) app.command({ type: 'setGroup', ids, group: n });
        break;
      }
      // ---- orders ----
      case 'order.stop':
        orderSelection('stop');
        break;
      // ---- tools ----
      case 'tool.dig':
        setTool(ext.activeTool === 'dig' ? null : 'dig');
        break;
      case 'tool.build':
        setTool(ext.activeTool === 'build' ? null : 'build');
        break;
      case 'tool.brushDown':
        ext.brushRadius = nextBrushSize(ext.brushRadius, -1);
        break;
      case 'tool.brushUp':
        ext.brushRadius = nextBrushSize(ext.brushRadius, 1);
        break;
      case 'tool.erase':
        ext.erase = !ext.erase;
        if (ext.erase && !paintKind()) setTool('dig');
        break;
      case 'beacon.gather':
      case 'beacon.dig':
      case 'beacon.rally':
      case 'beacon.attack':
      case 'beacon.avoid': {
        const t = `beacon:${action.slice(7)}` as ActiveTool;
        setTool(ext.activeTool === t ? null : t);
        break;
      }
      // ---- possession ----
      case 'possess.toggle':
        if (sim.possessedId) release();
        else possessAnt();
        break;
      case 'p.view':
        view.firstPerson = !view.firstPerson;
        break;
      case 'p.pickup':
        possessAction('pickup');
        break;
      case 'p.trail':
        possessAction('trail');
        break;
      case 'p.recruit':
        possessAction('recruit');
        break;
      case 'p.next':
        hop(1);
        break;
      case 'p.prev':
        hop(-1);
        break;
      // ---- game ----
      case 'game.pause':
        app.command({ type: 'pause', paused: !sim.paused });
        break;
      case 'game.faster':
      case 'game.slower': {
        const i = SPEEDS.indexOf(sim.speed as 1 | 2 | 4);
        const next = SPEEDS[clamp((i < 0 ? 0 : i) + (action === 'game.faster' ? 1 : -1), 0, SPEEDS.length - 1)];
        app.command({ type: 'setSpeed', speed: next });
        if (sim.paused && action === 'game.faster') app.command({ type: 'pause', paused: false });
        break;
      }
      case 'cancel':
        cancel();
        break;
      default:
        break; // hold actions, mouse rows and ui.* (handled by subscribers)
    }
    for (const fn of [...actionSubs]) fn(action);
  }

  function cancel(): void {
    for (let i = escapeStack.length - 1; i >= 0; i--) if (escapeStack[i]()) return;
    if (app.sim.possessedId) release();
    else if (painting) {
      painting = null;
    } else if (ext.activeTool) setTool(null);
    else if (ext.followId) ext.followId = 0;
    else setSelection([]);
  }

  // =====================================================================================
  // DOM events
  // =====================================================================================

  const editable = (t: EventTarget | null): boolean => {
    const el = t as HTMLElement | null;
    if (!el || !el.tagName) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
    if (tag !== 'INPUT') return false;
    const type = (el as HTMLInputElement).type;
    return type !== 'range' && type !== 'checkbox' && type !== 'radio' && type !== 'button';
  };

  function onKeyDown(e: KeyboardEvent): void {
    if (editable(e.target)) return;
    const ctx = isMap() ? 'map' : 'possess';
    const chord = chordOf(e);
    const action = keymap.lookup(chord, ctx);
    const hold = keymap.isHoldKey(e.code, ctx);
    if (action || hold || e.code === 'Tab') e.preventDefault();
    if (e.repeat) return;
    if (intro) {
      // any key skips the opening move; the "obvious" skip keys do nothing else
      endIntro(true);
      if (e.code === 'Escape' || e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        return;
      }
    }
    down.add(e.code);
    if (action) run(action, chord);
  }

  function onKeyUp(e: KeyboardEvent): void {
    down.delete(e.code);
  }

  function resetButtons(): void {
    down.clear();
    lDown = rDown = null;
    mDown = false;
    painting = null;
    app.view.dragBox = null;
  }

  function onPointerDown(e: PointerEvent): void {
    const canvas = app.canvas;
    ext.pointer.x = e.offsetX;
    ext.pointer.y = e.offsetY;
    ext.pointer.over = true;
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    if (intro) endIntro(true);
    if (!isMap()) {
      if (document.pointerLockElement !== canvas) requestLock();
      if (e.button === 0) possessAction('bite');
      else if (e.button === 2) possessAction('dig');
      e.preventDefault();
      return;
    }
    try {
      canvas.setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic events have no active pointer */
    }
    if (e.button === 0) {
      if (paintKind()) {
        painting = { lastX: e.offsetX, lastY: e.offsetY, erase: ext.erase || e.altKey };
        ext.stroke = [];
        strokeClearAt = -1;
        stampAt(e.offsetX, e.offsetY);
      } else if (beaconKind()) {
        beaconClick(e.offsetX, e.offsetY, e.shiftKey);
      } else lDown = { x: e.offsetX, y: e.offsetY, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    } else if (e.button === 2) rDown = { x: e.offsetX, y: e.offsetY, moved: false };
    else if (e.button === 1) {
      mDown = true;
      e.preventDefault(); // no browser auto-scroll
    }
  }

  function onPointerMove(e: PointerEvent): void {
    const canvas = app.canvas;
    if (!isMap()) {
      if (document.pointerLockElement === canvas) {
        mouseYaw += e.movementX;
        mousePitch += e.movementY;
      }
      return;
    }
    ext.pointer.x = e.offsetX;
    ext.pointer.y = e.offsetY;
    ext.pointer.over = true;
    hoverDirty = true;
    if (rDown) {
      if (Math.hypot(e.offsetX - rDown.x, e.offsetY - rDown.y) > 5) rDown.moved = true;
      if (rDown.moved) {
        orbitDX += e.movementX;
        orbitDY += e.movementY;
      }
    }
    if (mDown) {
      dragPanDX += e.movementX;
      dragPanDY += e.movementY;
    }
    if (painting) paintTo(e.offsetX, e.offsetY);
    if (lDown) {
      const box = { x0: lDown.x, y0: lDown.y, x1: e.offsetX, y1: e.offsetY };
      if (app.view.dragBox || isDrag(box)) app.view.dragBox = box;
    }
  }

  function onPointerUp(e: PointerEvent): void {
    if (!isMap()) return;
    if (e.button === 0) {
      if (painting) {
        painting = null;
        strokeClearAt = renderTime + 0.5;
      }
      if (lDown) {
        const mode = selectMode(e.shiftKey || lDown.shift, e.ctrlKey || e.metaKey || lDown.ctrl);
        const box = app.view.dragBox;
        if (box) boxSelect(box, mode);
        else clickSelect(e.offsetX, e.offsetY, mode, performance.now());
        lDown = null;
        app.view.dragBox = null;
      }
    } else if (e.button === 2 && rDown) {
      if (!rDown.moved) {
        if (ext.activeTool) setTool(null);
        else orderAt(e.offsetX, e.offsetY, e.shiftKey, e.altKey);
      }
      rDown = null;
    } else if (e.button === 1) mDown = false;
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (!isMap()) return;
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    if (e.ctrlKey || e.metaKey) moveCut(dy > 0 ? -1 : 1);
    else if (e.altKey && paintKind()) ext.brushRadius = nextBrushSize(ext.brushRadius, dy > 0 ? -1 : 1);
    else wheel += dy;
  }

  function onLockChange(): void {
    const locked = document.pointerLockElement === app.canvas;
    if (locked) {
      lockExitBySelf = false;
      return;
    }
    const bySelf = lockExitBySelf;
    lockExitBySelf = false;
    // The browser swallows the Esc that exits pointer lock, so treat a user-driven unlock while
    // the window still has focus as "Esc = release". Losing focus (alt-tab) keeps the possession.
    if (!bySelf && app.sim.possessedId && document.hasFocus() && !document.hidden) release();
  }

  // =====================================================================================
  // per-frame
  // =====================================================================================

  function updateCamera(frame: FrameInfo, dt: number): void {
    const view = app.view;
    const cam = view.camera;
    const sim = app.sim;

    if (view.mode === 'possess') {
      const ant = sim.getAnt(view.possessedId);
      if (!ant) return; // the sim ends the possession next tick
      possess.firstPerson = view.firstPerson;
      sendPossessInput(dt);
      possess.apply(cam, ant, frame.alpha, dt, sim.world, getCaste(ant.species, ant.caste).length);
      lastPossessPos = lastPossessPos ?? v3();
      v3copy(lastPossessPos, ant.pos);
      blend.apply(cam, dt);
      return;
    }

    let ax = (keymap.held('cam.right', down) ? 1 : 0) - (keymap.held('cam.left', down) ? 1 : 0);
    let ay = (keymap.held('cam.forward', down) ? 1 : 0) - (keymap.held('cam.back', down) ? 1 : 0);
    if (down.has('ControlLeft') || down.has('ControlRight') || down.has('MetaLeft') || down.has('MetaRight')) ax = ay = 0; // Ctrl+A etc. are chords
    if (settings.edgeScroll && winMouse.inside && document.hasFocus() && !lDown && !rDown && !mDown) {
      const m = 6;
      if (winMouse.x <= m) ax -= 1;
      else if (winMouse.x >= window.innerWidth - 1 - m) ax += 1;
      if (winMouse.y <= m) ay += 1;
      else if (winMouse.y >= window.innerHeight - 1 - m) ay -= 1;
    }
    const rot = (keymap.held('cam.rotateRight', down) ? 1 : 0) - (keymap.held('cam.rotateLeft', down) ? 1 : 0);
    const used = camUsed || ax !== 0 || ay !== 0 || wheel !== 0 || orbitDX !== 0 || orbitDY !== 0 || dragPanDX !== 0 || dragPanDY !== 0 || rot !== 0 || ext.followId !== 0;
    if (intro) {
      if (used || view.mode !== 'rts') endIntro(true);
      else stepIntro(dt);
    }
    if (poseLock) {
      if (!used) {
        applyPose(cam, poseLock);
        blend.apply(cam, dt);
        return;
      }
      poseLock = null;
    }
    const manualPan = ax !== 0 || ay !== 0 || dragPanDX !== 0 || dragPanDY !== 0;
    if (manualPan) ext.followId = 0;
    const follow = ext.followId ? sim.getAnt(ext.followId) : undefined;
    if (ext.followId && !follow) ext.followId = 0;
    const anchor = wheel !== 0 && ext.pointer.over ? picker.rayAt(ext.pointer.x, ext.pointer.y)?.pos ?? null : null;
    const vh = Math.max(1, app.viewport().height);

    if (view.mode === 'rts') {
      const cut = activeCut();
      // world units per pixel at the focus distance (grab-pan)
      const perPx = (2 * rts.dist * Math.tan((45 * Math.PI) / 360)) / vh;
      if (ax || ay) rts.pan(ax, ay, rts.dist * 0.95 * dt, cut);
      if (dragPanDX || dragPanDY) {
        const fore = cut && cut.axis !== 'y' ? 1 : 1 / Math.max(0.35, Math.sin(rts.pitch));
        rts.pan(-dragPanDX * perPx, dragPanDY * perPx * fore, 1, cut);
      }
      if (wheel) rts.zoomAt(Math.exp(wheel * 0.0012), follow ? null : anchor, cut);
      rts.orbit(-orbitDX * 0.005 + rot * 1.7 * dt, orbitDY * 0.005);
      if (follow) {
        rts.lookAt(follow.pos, null, null);
        rts.groundY = null;
      } else if (cut) {
        rts.groundY = null;
      } else {
        groundTimer -= dt;
        if (groundTimer <= 0 || manualPan || wheel) {
          groundTimer = 0.08;
          rts.groundY = groundBelow(rts.target);
        }
      }
      rts.update(dt, cut);
      rts.apply(cam);
      if (autoCutTimer >= 0 && autoCutPos) {
        autoCutTimer -= dt;
        if (cut || follow || intro || Math.hypot(rts.target.x - autoCutPos.x, rts.target.z - autoCutPos.z) > 2.5) autoCutTimer = -1;
        else if (autoCutTimer < 0 && focusBuried(autoCutPos)) autoCut(autoCutPos);
      }
    } else {
      const perPx = (2 * slab.dist * Math.tan((40 * Math.PI) / 360)) / vh;
      if (ax || ay) slab.pan(ax, ay, slab.dist * 0.85 * dt);
      if (dragPanDX || dragPanDY) slab.pan(-dragPanDX * perPx, dragPanDY * perPx, 1);
      if (wheel) slab.zoomAt(Math.exp(wheel * 0.0012), follow ? null : anchor);
      slab.orbit(-orbitDX * 0.004 + rot * 0.8 * dt, orbitDY * 0.004);
      if (follow) slab.lookAt(follow.pos, null);
      slab.update(dt);
      slab.apply(cam);
    }
    blend.apply(cam, dt);
  }

  /** Height of the visible ground under the RTS focus (local: starts just above the focus). */
  function groundBelow(t: Vec3): number | null {
    const w = app.sim.world;
    const DOWN = { x: 0, y: -1, z: 0 };
    const x = clamp(t.x, 0.01, w.sx - 0.01);
    const z = clamp(t.z, 0.01, w.sz - 0.01);
    let hit = w.raycast({ x, y: Math.min(t.y + 6, w.sy + 2), z }, DOWN, w.sy + 8, { visual: true });
    if (hit && hit.dist < 0.05) hit = w.raycast({ x, y: w.sy + 2, z }, DOWN, w.sy + 8, { visual: true });
    return hit ? hit.pos.y : null;
  }

  function updateHover(): void {
    const view = app.view;
    if (!isMap()) return;
    const busy = !!rDown?.moved || mDown || !!view.dragBox;
    if (!ext.pointer.over || busy) {
      view.hoverId = 0;
      ext.hoverKind = null;
      ext.hoverHostile = false;
      if (!ext.pointer.over) {
        view.cursorWorld = null;
        ext.brush = null;
        ext.beaconPreview = null;
      }
      return;
    }
    const { x, y } = ext.pointer;
    const hit = picker.rayAt(x, y);
    view.cursorWorld = hit ? hit.pos : null;
    const sim = app.sim;
    if (paintKind()) {
      view.hoverId = 0;
      ext.hoverKind = null;
      ext.hoverHostile = false;
      ext.beaconPreview = null;
      ext.brush = brushFor(hit, painting ? painting.erase : ext.erase || down.has('AltLeft') || down.has('AltRight'));
      return;
    }
    ext.brush = null;
    const bk = beaconKind();
    if (bk) {
      const col = playerColony();
      const under = col ? beaconUnderCursor(col.beacons, hit ? hit.pos : null, (p) => (picker.project(p) ? { x: picker.sx, y: picker.sy } : null), x, y) : 0;
      const ub = under && col ? col.beacons.find((b) => b.id === under) : undefined;
      ext.beaconPreview = ub ? { kind: ub.kind, pos: v3clone(ub.pos), radius: ub.radius, removeId: ub.id } : hit ? { kind: bk, pos: v3clone(hit.pos), radius: 6, removeId: 0 } : null;
      view.hoverId = 0;
      ext.hoverKind = null;
      ext.hoverHostile = false;
      return;
    }
    ext.beaconPreview = null;
    const hov = picker.entityAt(x, y);
    view.hoverId = hov ? hov.id : 0;
    ext.hoverKind = hov ? hov.kind : null;
    let hostile = false;
    if (hov) {
      const e = hov.entity;
      if (e.kind === 'ant') hostile = e.colony !== sim.playerColony;
      else if (e.kind === 'creature') hostile = e.colony !== sim.playerColony && creatureRole(e.def) !== 'prey' && creatureRole(e.def) !== 'herd';
    }
    ext.hoverHostile = hostile;
  }

  function updateCursor(): void {
    let c = 'default';
    if (isMap()) {
      if (mDown) c = 'grabbing';
      else if (ext.activeTool) c = 'crosshair';
      else if (app.view.hoverId) c = ext.hoverHostile && app.view.selection.length ? 'crosshair' : 'pointer';
    }
    if (c !== cursorStyle) {
      cursorStyle = c;
      app.canvas.style.cursor = c;
    }
  }

  const api: InputApi = {
    keymap,
    settings,
    trigger: (a) => run(a, keymap.keysOf(a)[0] ?? ''),
    onAction(fn) {
      actionSubs.add(fn);
      return () => actionSubs.delete(fn);
    },
    pushEscape(fn) {
      escapeStack.push(fn);
      return () => {
        const i = escapeStack.indexOf(fn);
        if (i >= 0) escapeStack.splice(i, 1);
      };
    },
    jumpTo,
    focusSelection,
    jumpToNest,
    setFollow(id) {
      ext.followId = ownAnt(id) ? id : 0;
      if (ext.followId) poseLock = null;
    },
    flipSlab: () => run('cam.flip'),
    playIntro,
    get introActive() {
      return !!intro;
    },
    onHint(fn) {
      hintSubs.add(fn);
      return () => hintSubs.delete(fn);
    },
    select(ids, mode = 'replace') {
      applySelect(ids.filter((id) => app.sim.getAnt(id)), mode);
    },
    setPrimary(id) {
      if (app.view.selection.includes(id)) ext.primaryId = id;
    },
    groupMembers: (n) => groups.members(n, (id) => !!ownAnt(id)),
    orderSelection,
    setTool,
    setBrushRadius(r) {
      ext.brushRadius = clamp(r, BRUSH_SIZES[0], BRUSH_SIZES[BRUSH_SIZES.length - 1]);
    },
    setErase(e) {
      ext.erase = e;
    },
    setCut,
    moveCut,
    snapCut() {
      cutIsAuto = false;
      snapCut();
    },
    setPheroVision(on) {
      app.view.pheroVision = on;
    },
    possess: possessAnt,
    release,
    get trailOn() {
      return trailOn;
    },
    setSpeed(speed) {
      app.command({ type: 'setSpeed', speed });
      if (app.sim.paused) app.command({ type: 'pause', paused: false });
    },
    setPaused(paused) {
      app.command({ type: 'pause', paused });
    },
  };

  const layer: InputLayer = {
    init(a) {
      app = a;
      const sim = app.sim;
      ext = {
        hoverKind: null,
        hoverHostile: false,
        primaryId: 0,
        activeTool: null,
        brushRadius: 2,
        erase: false,
        brush: null,
        stroke: [],
        beaconPreview: null,
        orderPings: [],
        pointer: { x: 0, y: 0, over: false },
        followId: 0,
        transition: 1,
        slabSide: 1,
      };
      (app.view as ViewStateA5).a5 = ext;
      picker = new Picker(app);
      rts = new RtsRig(sim.world);
      slab = new SlabRig(sim.world, sim.map.flags.slabAxis);
      app.view.mode = sim.map.cameraMode;
      const start = startPose(sim);
      rts.fromPose(start);
      slab.fromPose(start);
      ext.slabSide = slab.side;
      // start exactly on the map's authored pose until the player touches the camera
      poseLock = start;
      applyPose(app.view.camera, poseLock);
      registerInputApi(app.view, api);

      const canvas = app.canvas;
      listen(window, 'keydown', onKeyDown as (e: never) => void);
      listen(window, 'keyup', onKeyUp as (e: never) => void);
      listen(window, 'blur', resetButtons as (e: never) => void);
      listen(document, 'visibilitychange', (() => {
        if (document.hidden) resetButtons();
      }) as (e: never) => void);
      listen(document, 'pointerlockchange', onLockChange as (e: never) => void);
      listen(window, 'mousemove', ((e: MouseEvent) => {
        winMouse = { x: e.clientX, y: e.clientY, inside: true };
      }) as (e: never) => void);
      listen(document, 'mouseleave', (() => {
        winMouse.inside = false;
      }) as (e: never) => void);
      listen(canvas, 'contextmenu', ((e: Event) => e.preventDefault()) as (e: never) => void);
      listen(canvas, 'wheel', onWheel as (e: never) => void, { passive: false });
      listen(canvas, 'pointerdown', onPointerDown as (e: never) => void);
      listen(canvas, 'pointermove', onPointerMove as (e: never) => void);
      listen(canvas, 'pointerup', onPointerUp as (e: never) => void);
      listen(canvas, 'pointercancel', (() => {
        lDown = rDown = null;
        mDown = false;
        painting = null;
        app.view.dragBox = null;
      }) as (e: never) => void);
      listen(canvas, 'pointerleave', (() => {
        if (!lDown && !rDown && !mDown && !painting) {
          ext.pointer.over = false;
          hoverDirty = true;
        }
      }) as (e: never) => void);
      listen(canvas, 'mousedown', ((e: MouseEvent) => {
        if (e.button === 1) e.preventDefault();
      }) as (e: never) => void);
    },

    update(frame) {
      const now = performance.now();
      const dt = lastNow < 0 ? 0 : clamp((now - lastNow) / 1000, 0, 0.1);
      lastNow = now;
      renderTime = frame.time;

      for (const ev of frame.events) {
        // remember where a possessed ant died so the camera falls back onto the corpse (§5.2)
        if (ev.type === 'antDied' && ev.id === app.view.possessedId) lastPossessPos = v3clone(ev.pos);
      }
      syncMode();
      updateCamera(frame, dt);
      ext.transition = blend.progress;

      if (isMap() && (hoverDirty || frame.frame % 3 === 0)) {
        hoverDirty = false;
        updateHover();
      }
      updateCursor();

      // housekeeping: dead ids, expired feedback
      const sel = app.view.selection;
      if (sel.length && frame.frame % 10 === 0) {
        const alive = sel.filter((id) => app.sim.getAnt(id));
        if (alive.length !== sel.length) setSelection(alive, ext.primaryId);
      }
      if (ext.orderPings.length && renderTime - ext.orderPings[0].time > ORDER_PING_SECONDS) ext.orderPings = ext.orderPings.filter((p) => renderTime - p.time <= ORDER_PING_SECONDS);
      if (ext.orderPings.length && renderTime < ext.orderPings[0].time) ext.orderPings = [];
      // a stroke that ended without a pointerup (Esc, tool switch, window blur, pointercancel) must not linger
      if (!painting && ext.stroke.length && strokeClearAt < 0) strokeClearAt = renderTime + 0.5;
      if (strokeClearAt >= 0 && (renderTime >= strokeClearAt || frame.frozen)) {
        // keep the preview until the sim has had a tick to create the real designations
        if (!frame.frozen || !painting) {
          ext.stroke = [];
          strokeClearAt = -1;
        }
      }
      mouseYaw = mousePitch = wheel = orbitDX = orbitDY = dragPanDX = dragPanDY = 0;
      camUsed = false;
    },

    setCameraPose(pose) {
      if (pose === null) {
        poseLock = null;
        return;
      }
      const p = resolvePose(app.sim.map, pose);
      if (!p) throw new Error(`unknown camera pose: ${String(pose)}`);
      intro = null;
      autoCutTimer = -1;
      poseLock = p;
      ext.followId = 0;
      rts.fromPose(p);
      slab.fromPose(p);
      ext.slabSide = slab.side;
      blend.finish();
      if (p.cut !== undefined) app.view.cut = p.cut ? { ...p.cut } : { ...app.view.cut, enabled: false };
      if (app.view.mode !== 'possess') applyPose(app.view.camera, p);
      hoverDirty = true;
    },

    snapCamera() {
      syncMode();
      blend.finish();
      ext.transition = 1;
      const view = app.view;
      if (view.mode === 'possess') {
        const ant = app.sim.getAnt(view.possessedId);
        if (ant) {
          possess.firstPerson = view.firstPerson;
          possess.apply(view.camera, ant, 1, 0, app.sim.world, getCaste(ant.species, ant.caste).length);
        }
      } else if (poseLock) applyPose(view.camera, poseLock);
      else if (view.mode === 'rts') {
        const follow = ext.followId ? app.sim.getAnt(ext.followId) : undefined;
        if (follow) rts.lookAt(follow.pos, null, null);
        else if (!activeCut()) rts.groundY = groundBelow(rts.target);
        rts.update(0, activeCut());
        rts.apply(view.camera);
      } else {
        const follow = ext.followId ? app.sim.getAnt(ext.followId) : undefined;
        if (follow) slab.lookAt(follow.pos, null);
        slab.update(0);
        slab.apply(view.camera);
      }
      hoverDirty = true;
    },

    select(ids) {
      setSelection(ids.filter((id) => app.sim.getAnt(id)));
    },

    dispose() {
      for (const d of disposers) d();
      disposers.length = 0;
      actionSubs.clear();
      hintSubs.clear();
      intro = null;
      escapeStack.length = 0;
      if (app) {
        exitLock();
        app.canvas.style.cursor = '';
        registerInputApi(app.view, null);
        delete (app.view as ViewStateA5).a5;
      }
    },
  };
  return layer;
}

/** The representation of `angle` closest to `ref` (so a damped yaw takes the short way round). */
function nearestAngle(angle: number, ref: number): number {
  const d = Math.atan2(Math.sin(angle - ref), Math.cos(angle - ref));
  return ref + d;
}
