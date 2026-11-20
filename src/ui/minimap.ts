import { ISO, MATERIALS, v3, type Vec2, type Vec3 } from '../core';
import { getCreature } from '../sim/data/creatures';
import type { HudComponent, HudContext } from './context';
import { h, setStyle } from './dom';
import { frustumOnPlane, makeMiniProjection, miniCanvasSize, tintByHeight, type MiniProjection } from './minimapMath';

const TERRAIN_MIN_INTERVAL_MS = 2000;
const DYNAMIC_INTERVAL_MS = 125; // 8 Hz
const BEACON_COLORS: Record<string, string> = { gather: '#f0b54a', dig: '#c9a57a', rally: '#9fd86b', attack: '#ef6f61', avoid: '#b99cf0' };

export interface MinimapComponent extends HudComponent {
  /** Re-fit the canvas after the HUD font size changed. */
  resize(fontPx: number): void;
}

/**
 * Minimap. Outdoor maps: top-down (x right, z down), terrain coloured by surface material and
 * tinted by height. Farm maps: side-on view of the pane plane, tunnels dark. The terrain layer is
 * cached on an offscreen canvas (rebuilt when `world.version` changed, at most every 2 s); the
 * dynamic layer (ants, food, threats, beacons, camera footprint) is redrawn at 8 Hz.
 */
export function createMinimap(ctx: HudContext): MinimapComponent {
  const { app } = ctx;
  const sim = app.sim;
  const world = sim.world;
  const slab = sim.map.flags.slab || sim.map.cameraMode === 'slab';
  const slabAxis = sim.map.flags.slabAxis ?? 'z';

  const canvas = h('canvas', undefined, { testid: 'minimap-canvas' });
  const label = h('span', 'mh-mm-label', null, slab ? 'side view' : '');
  const el = h('div', 'mh-panel mh-minimap', { testid: 'minimap' }, [canvas, label]);
  const g = canvas.getContext('2d');
  const terrain = document.createElement('canvas');
  const tg = terrain.getContext('2d');

  let proj: MiniProjection | null = null;
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let mirror = false;
  let terrainVersion = -1;
  let terrainAt = -1e9;
  let terrainDirty = true;
  let lastDraw = -1e9;
  const _m: Vec2 = { x: 0, y: 0 };
  const _w: Vec3 = v3();
  const _poly: Vec3[] = [];
  const _rgb: [number, number, number] = [0, 0, 0];

  const wantMirror = (): boolean => {
    if (!slab) return false;
    const side = ctx.ext()?.slabSide ?? 1;
    // camera on the +axis side: slab axis z shows +x to the right, slab axis x shows +z to the left
    return slabAxis === 'z' ? side < 0 : side > 0;
  };

  function layout(fontPx: number): void {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const maxW = (slab ? 20 : 13) * fontPx;
    const maxH = (slab ? 11 : 13) * fontPx;
    const s = miniCanvasSize(world, slab, slabAxis, maxW, maxH);
    cssW = s.w;
    cssH = s.h;
    canvas.width = Math.max(8, Math.round(cssW * dpr));
    canvas.height = Math.max(8, Math.round(cssH * dpr));
    setStyle(canvas, 'width', `${cssW}px`);
    setStyle(canvas, 'height', `${cssH}px`);
    mirror = wantMirror();
    proj = makeMiniProjection(world, { slab, slabAxis, w: canvas.width, h: canvas.height, mirror });
    terrainDirty = true;
    lastDraw = -1e9;
  }

  function buildTerrain(): void {
    if (!proj || !tg) return;
    // one texel per world cell (never more texels than canvas pixels)
    const tw = Math.max(1, Math.min(Math.ceil(proj.uSize), canvas.width));
    const th = Math.max(1, Math.min(Math.ceil(proj.vSize), canvas.height));
    terrain.width = tw;
    terrain.height = th;
    const img = tg.createImageData(tw, th);
    const data = img.data;
    const { sx, sy, sz } = world;
    const den = world.density;
    const mat = world.material;
    const mid = Math.min((slabAxis === 'z' ? sz : sx) - 1, Math.floor(proj.depth));
    for (let j = 0; j < th; j++) {
      for (let i = 0; i < tw; i++) {
        let u = Math.min(proj.uSize - 1, Math.floor(((i + 0.5) / tw) * proj.uSize));
        if (proj.mirror) u = Math.floor(proj.uSize) - 1 - u;
        if (u < 0) u = 0;
        const v = Math.min(proj.vSize - 1, Math.floor(((j + 0.5) / th) * proj.vSize));
        const o = (j * tw + i) * 4;
        let r = 11;
        let gg = 16;
        let b = 13;
        if (proj.mode === 'top') {
          const x = u;
          const z = v;
          let top = -1;
          for (let y = sy - 1; y >= 0; y--) {
            if (den[x + sx * (z + sz * y)] >= ISO) {
              top = y;
              break;
            }
          }
          if (top >= 0) {
            const m = MATERIALS[mat[x + sx * (z + sz * top)]] ?? MATERIALS[1];
            tintByHeight(m.color, top / Math.max(1, sy - 1), _rgb);
            r = _rgb[0];
            gg = _rgb[1];
            b = _rgb[2];
          }
        } else {
          const y = sy - 1 - v;
          const x = proj.uAxis === 'x' ? u : mid;
          const z = proj.uAxis === 'x' ? mid : u;
          const idx = x + sx * (z + sz * y);
          if (den[idx] >= ISO) {
            const m = MATERIALS[mat[idx]] ?? MATERIALS[1];
            tintByHeight(m.color, 0.25 + 0.35 * (y / Math.max(1, sy - 1)), _rgb);
            r = _rgb[0];
            gg = _rgb[1];
            b = _rgb[2];
          } else {
            r = 16;
            gg = 20;
            b = 24;
          }
        }
        data[o] = r;
        data[o + 1] = gg;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    }
    tg.putImageData(img, 0, 0);
  }

  function dot(p: Vec3, r: number): void {
    proj!.toMap(p, _m);
    g!.rect(_m.x - r, _m.y - r, r * 2, r * 2);
  }

  function draw(): void {
    if (!g || !proj) return;
    const p = proj;
    const W = canvas.width;
    const H = canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#0b100d';
    g.fillRect(0, 0, W, H);
    g.imageSmoothingEnabled = true;
    g.drawImage(terrain, p.ox, p.oy, p.uSize * p.scale, p.vSize * p.scale);
    const px = dpr;
    const view = app.view;
    const pc = sim.playerColony;

    // nest
    const colony = ctx.colony();
    if (colony) {
      p.toMap(colony.nestPos, _m);
      g.beginPath();
      g.arc(_m.x, _m.y, 4 * px, 0, Math.PI * 2);
      g.fillStyle = 'rgba(159,216,107,.25)';
      g.fill();
      g.lineWidth = 1.5 * px;
      g.strokeStyle = '#d9f5c0';
      g.stroke();
      // beacons
      for (const b of colony.beacons) {
        p.toMap(b.pos, _m);
        g.beginPath();
        g.moveTo(_m.x, _m.y - 3.5 * px);
        g.lineTo(_m.x + 3.5 * px, _m.y);
        g.lineTo(_m.x, _m.y + 3.5 * px);
        g.lineTo(_m.x - 3.5 * px, _m.y);
        g.closePath();
        g.fillStyle = BEACON_COLORS[b.kind] ?? '#fff';
        g.fill();
        g.lineWidth = px;
        g.strokeStyle = 'rgba(0,0,0,.7)';
        g.stroke();
      }
    }

    // food
    g.beginPath();
    for (const f of sim.foodSources) if (f.alive && f.amount > 0) dot(f.pos, 1.6 * px);
    for (const c of sim.creatures) if (c.alive && getCreature(c.def).role === 'prey') dot(c.pos, 1.2 * px);
    g.fillStyle = '#f0b54a';
    g.fill();

    // own ants (workers, then bigger castes)
    g.beginPath();
    for (const a of sim.ants) if (a.alive && a.colony === pc && (a.caste === 'worker' || a.caste === 'alate')) dot(a.pos, 0.8 * px);
    g.fillStyle = '#e4f7d2';
    g.fill();
    g.beginPath();
    for (const a of sim.ants) if (a.alive && a.colony === pc && a.caste !== 'worker' && a.caste !== 'alate') dot(a.pos, a.caste === 'queen' || a.caste === 'king' ? 1.9 * px : 1.35 * px);
    g.fillStyle = '#9fd86b';
    g.fill();

    // threats
    g.beginPath();
    for (const a of sim.ants) if (a.alive && a.colony !== pc) dot(a.pos, 1.0 * px);
    for (const c of sim.creatures) {
      if (!c.alive) continue;
      const role = getCreature(c.def).role;
      if (role !== 'prey' && role !== 'herd') dot(c.pos, 2.2 * px);
    }
    g.fillStyle = '#ef6f61';
    g.fill();

    // selection
    if (view.selection.length) {
      g.beginPath();
      let n = 0;
      for (const id of view.selection) {
        const a = sim.getAnt(id);
        if (!a) continue;
        dot(a.pos, 1.3 * px);
        if (++n > 400) break;
      }
      g.fillStyle = '#ffffff';
      g.fill();
    }
    if (view.possessedId) {
      const a = sim.getAnt(view.possessedId);
      if (a) {
        p.toMap(a.pos, _m);
        g.beginPath();
        g.arc(_m.x, _m.y, 3 * px, 0, Math.PI * 2);
        g.fillStyle = '#f0b54a';
        g.fill();
        g.lineWidth = px;
        g.strokeStyle = '#fff';
        g.stroke();
      }
    }

    // camera footprint
    const vp = app.viewport();
    const aspect = vp.width / Math.max(1, vp.height);
    const cam = view.camera;
    const maxDist = Math.max(world.sx, world.sy, world.sz) * 1.5;
    if (p.mode === 'top') frustumOnPlane(cam, aspect, 'y', cam.focus.y, maxDist, _poly);
    else frustumOnPlane(cam, aspect, slabAxis, p.depth, maxDist, _poly);
    g.save();
    g.beginPath();
    g.rect(p.ox, p.oy, p.uSize * p.scale, p.vSize * p.scale);
    g.clip();
    g.beginPath();
    for (let i = 0; i < 4; i++) {
      p.toMap(_poly[i], _m);
      if (i === 0) g.moveTo(_m.x, _m.y);
      else g.lineTo(_m.x, _m.y);
    }
    g.closePath();
    g.fillStyle = 'rgba(255,255,255,.07)';
    g.fill();
    g.lineWidth = 1.25 * px;
    g.strokeStyle = 'rgba(255,255,255,.85)';
    g.stroke();
    g.restore();
  }

  // ---- click / drag to jump ----
  let dragging = false;
  function jump(e: PointerEvent): void {
    if (!proj) return;
    const r = canvas.getBoundingClientRect();
    const mx = ((e.clientX - r.left) / Math.max(1, r.width)) * canvas.width;
    const my = ((e.clientY - r.top) / Math.max(1, r.height)) * canvas.height;
    proj.toWorld(mx, my, _w);
    if (proj.mode === 'top') {
      const x = Math.min(world.sx - 1, Math.max(0, Math.floor(_w.x)));
      const z = Math.min(world.sz - 1, Math.max(0, Math.floor(_w.z)));
      let top = -1;
      for (let y = world.sy - 1; y >= 0; y--) {
        if (world.isSolid(x, y, z)) {
          top = y;
          break;
        }
      }
      _w.y = top + 1;
    }
    ctx.api()?.jumpTo({ x: _w.x, y: _w.y, z: _w.z });
  }
  ctx.d.on(canvas, 'pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragging = true;
    canvas.setPointerCapture?.(e.pointerId);
    jump(e);
    e.preventDefault();
  });
  ctx.d.on(canvas, 'pointermove', (e: PointerEvent) => {
    if (dragging) jump(e);
  });
  const end = (): void => {
    dragging = false;
  };
  ctx.d.on(canvas, 'pointerup', end);
  ctx.d.on(canvas, 'pointercancel', end);
  ctx.d.on(canvas, 'contextmenu', (e: Event) => e.preventDefault());

  return {
    el,
    resize(fontPx) {
      layout(fontPx);
    },
    update(now) {
      if (!proj) return;
      if (wantMirror() !== mirror) {
        mirror = !mirror;
        proj = makeMiniProjection(world, { slab, slabAxis, w: canvas.width, h: canvas.height, mirror });
        terrainDirty = true;
      }
      if (world.version !== terrainVersion && now - terrainAt >= TERRAIN_MIN_INTERVAL_MS) terrainDirty = true;
      if (terrainDirty) {
        terrainDirty = false;
        terrainVersion = world.version;
        terrainAt = now;
        buildTerrain();
        lastDraw = -1e9;
      }
      if (now - lastDraw < DYNAMIC_INTERVAL_MS) return;
      lastDraw = now;
      draw();
    },
  };
}
