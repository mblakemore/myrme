/**
 * Map preview thumbnails for the new-game cards: a real miniature of the generated world — the
 * actual generator runs (`small` world) for the chosen seed and the voxels are projected to a
 * shaded image. Outdoor maps: top-down relief with hill-shading; farm maps: the view through the
 * front pane (gel / sand strata, tunnels and chambers as dark openings).
 *
 * Rendering is synchronous but cheap (≤ ~0.25 s per outdoor map); `ThumbQueue` spreads the work
 * over idle slices so the menu stays responsive, and caches by map + seed.
 */
import { ISO, MATERIALS, Mat, type MapGenResult, type MapId, type SpeciesId } from '../core';
import { getMap } from '../world/maps';

const THUMB_W = 752;
const THUMB_H = 252;
/** Supersampling of the top-down relief (output pixels per voxel column). */
const TOP_SS = 3;

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Cheap stable per-pixel grain in [-1, 1]. */
function grain(x: number, y: number): number {
  let n = (x * 374761393 + y * 668265263) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  return (((n ^ (n >>> 16)) >>> 0) / 4294967295) * 2 - 1;
}

type Tints = Partial<Record<number, readonly number[]>>;
function tintsOf(map: MapGenResult): Tints {
  return (map as { extras?: { materialTints?: Tints } }).extras?.materialTints ?? {};
}
function matColor(m: number, tints: Tints): readonly number[] {
  return tints[m] ?? MATERIALS[m]?.color ?? MATERIALS[Mat.Soil].color;
}

/**
 * Top-down hill-shaded relief of an outdoor world, `TOP_SS` pixels per column: heights and ground
 * colours are interpolated between columns so the miniature reads as terrain, not as pixels.
 */
function paintTop(map: MapGenResult): ImageData {
  const w = map.world;
  const { sx, sy, sz, density, material } = w;
  const tints = tintsOf(map);
  const height = new Float32Array(sx * sz);
  const mat = new Uint8Array(sx * sz);
  let minH = sy;
  let maxGround = 0;
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      let y = sy - 1;
      for (; y >= 0; y--) if (density[x + sx * (z + sz * y)] >= ISO) break;
      const i = x + sx * z;
      const d = y >= 0 ? density[x + sx * (z + sz * y)] : ISO;
      height[i] = y + Math.min(1, (d - ISO) / 64 + 0.5);
      mat[i] = y >= 0 ? material[x + sx * (z + sz * y)] : Mat.Soil;
      if (height[i] < minH) minH = height[i];
      if (mat[i] !== Mat.Plant && mat[i] !== Mat.Wood && height[i] > maxGround) maxGround = height[i];
    }
  }
  // relief is shaded from a softened height field so voxel plants / rocks read as rounded forms
  const soft = new Float32Array(sx * sz);
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      let sum = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) sum += height[Math.min(sx - 1, Math.max(0, x + dx)) + sx * Math.min(sz - 1, Math.max(0, z + dz))] * (dx === 0 && dz === 0 ? 4 : dx === 0 || dz === 0 ? 2 : 1);
      soft[x + sx * z] = sum / 16;
    }
  }
  height.set(soft);
  const K = TOP_SS;
  const W = sx * K;
  const Hh = sz * K;
  const img = new ImageData(W, Hh);
  const px = img.data;
  const range = Math.max(4, maxGround - minH);
  const cx = (x: number): number => (x < 0 ? 0 : x > sx - 1 ? sx - 1 : x);
  const cz = (z: number): number => (z < 0 ? 0 : z > sz - 1 ? sz - 1 : z);
  /** Bilinear height at fractional column coordinates. */
  const H = (fx: number, fz: number): number => {
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const tz = fz - z0;
    const a = height[cx(x0) + sx * cz(z0)];
    const b = height[cx(x0 + 1) + sx * cz(z0)];
    const c = height[cx(x0) + sx * cz(z0 + 1)];
    const d = height[cx(x0 + 1) + sx * cz(z0 + 1)];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  };
  const col = [0, 0, 0];
  for (let pz = 0; pz < Hh; pz++) {
    const fz = (pz + 0.5) / K - 0.5;
    const z0 = Math.floor(fz);
    const tz = fz - z0;
    for (let pxl = 0; pxl < W; pxl++) {
      const fx = (pxl + 0.5) / K - 0.5;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      // ground colour: bilinear blend of the four neighbouring columns' materials
      col[0] = col[1] = col[2] = 0;
      for (let k = 0; k < 4; k++) {
        const wgt = (k & 1 ? tx : 1 - tx) * (k & 2 ? tz : 1 - tz);
        const c = matColor(mat[cx(x0 + (k & 1)) + sx * cz(z0 + (k >> 1))], tints);
        col[0] += c[0] * wgt;
        col[1] += c[1] * wgt;
        col[2] += c[2] * wgt;
      }
      const h0 = H(fx, fz);
      // light from the upper left; soft relief
      const slope = H(fx - 1, fz - 1) - H(fx + 1, fz + 1);
      const light = Math.min(1.5, Math.max(0.45, 0.92 + slope * 0.12));
      const lift = 0.78 + 0.38 * Math.min(1.25, (h0 - minH) / range);
      // soft drop shadow of tall plants / logs / rocks onto the ground to the lower right
      const over = Math.max(H(fx - 1.5, fz - 1.5) - h0 - 1.2, (H(fx - 3.5, fz - 3.5) - h0 - 3.5) * 0.8);
      const shade = 1 - 0.34 * Math.min(1, Math.max(0, over * 0.5));
      const g = 1 + grain(pxl, pz) * 0.045;
      const k = light * lift * shade * g * 255;
      const o = (pxl + W * pz) * 4;
      px[o] = clamp255(Math.pow(col[0], 0.85) * k);
      px[o + 1] = clamp255(Math.pow(col[1], 0.85) * k);
      px[o + 2] = clamp255(Math.pow(col[2], 0.85) * k * 0.97);
      px[o + 3] = 255;
    }
  }
  return img;
}

/** Side-on view through the viewing pane of a farm slab (alpha 0 = nothing in that column). */
function paintSide(map: MapGenResult): ImageData {
  const w = map.world;
  const { sx, sy, sz, density, material } = w;
  const tints = tintsOf(map);
  const alongX = map.flags.slabAxis === 'z';
  const uSize = alongX ? sx : sz;
  const depth = alongX ? sz : sx;
  const at = (u: number, y: number, k: number): number => (alongX ? u : k) + sx * ((alongX ? k : u) + sz * y);
  // which pane shows the nest? the one whose face has carved openings right behind it (a
  // formicarium is carved into one face only; gel / sand slabs look alike from both sides)
  let openFront = 0;
  let openBack = 0;
  for (let y = 0; y < sy; y += 2) {
    for (let u = 0; u < uSize; u += 2) {
      let any = false;
      for (let k = 0; k < depth && !any; k++) any = density[at(u, y, k)] >= ISO;
      if (!any) continue; // empty through and through (air above the fill): not an opening
      if (density[at(u, y, 0)] < ISO) openFront++;
      if (density[at(u, y, depth - 1)] < ISO) openBack++;
    }
  }
  const fromBack = openBack > openFront;
  const reach = Math.min(depth, 7);
  const img = new ImageData(uSize, sy);
  const px = img.data;
  for (let y = 0; y < sy; y++) {
    for (let u = 0; u < uSize; u++) {
      // march from the viewing pane inwards
      let hit = -1;
      let m = 0;
      for (let k = 0; k < depth; k++) {
        const i = at(u, y, fromBack ? depth - 1 - k : k);
        if (density[i] >= ISO) {
          hit = k;
          m = material[i];
          break;
        }
      }
      const o = (u + uSize * (sy - 1 - y)) * 4;
      if (hit < 0) {
        px[o + 3] = 0; // open air: the room shows through
        continue;
      }
      const c = matColor(m, tints);
      // at the pane = lit material; set back = the floor of a tunnel or chamber (darker with depth)
      const d = Math.min(1, hit / reach);
      const tunnel = hit > 0 ? 0.56 - 0.3 * d : 1;
      const glow = m === Mat.Gel ? 1.28 - 0.4 * (1 - y / sy) : 1;
      const g = 1 + grain(u, y) * (m === Mat.Gel ? 0.02 : 0.06);
      const k = tunnel * glow * g * 255;
      let r = Math.pow(c[0], 0.8) * k;
      let gg = Math.pow(c[1], 0.8) * k;
      let b = Math.pow(c[2], 0.8) * k;
      if (hit > 0) {
        // carved hollows read warm and shadowed, never plain grey
        r = r * 0.92 + 10;
        gg = gg * 0.8 + 5;
        b = b * 0.66 + 2;
      }
      px[o] = clamp255(r);
      px[o + 1] = clamp255(gg);
      px[o + 2] = clamp255(b);
      px[o + 3] = 255;
    }
  }
  // contact shading: darken solid pixels next to an opening so chambers get a rim
  const a = new Uint8Array(uSize * sy);
  for (let i = 0; i < a.length; i++) a[i] = px[i * 4 + 3] ? (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3 : 255;
  for (let y = 1; y < sy - 1; y++) {
    for (let u = 1; u < uSize - 1; u++) {
      const i = u + uSize * y;
      if (!px[i * 4 + 3]) continue;
      const up = a[i - uSize];
      const left = a[i - 1];
      const me = a[i];
      // a much brighter neighbour above / left = we are just under an overhang → shadow line
      if (up - me > 40 || left - me > 40) {
        px[i * 4] *= 0.8;
        px[i * 4 + 1] *= 0.8;
        px[i * 4 + 2] *= 0.8;
      }
    }
  }
  return img;
}

/** Render the thumbnail of a generated map into a new canvas (THUMB_W × THUMB_H). */
export function renderMapThumb(map: MapGenResult): HTMLCanvasElement {
  const slab = map.flags.slab;
  const img = slab ? paintSide(map) : paintTop(map);
  const src = document.createElement('canvas');
  src.width = img.width;
  src.height = img.height;
  src.getContext('2d')!.putImageData(img, 0, 0);

  const out = document.createElement('canvas');
  out.width = THUMB_W;
  out.height = THUMB_H;
  const g = out.getContext('2d')!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  if (slab) {
    const env = map.environment;
    const hasGel = (() => {
      const m = map.world.material;
      for (let i = 0; i < m.length; i += 97) if (m[i] === Mat.Gel) return true;
      return false;
    })();
    const rgb = (c: readonly number[], k: number, add = 0): string => `rgb(${Math.round(clamp255(c[0] * k + add))},${Math.round(clamp255(c[1] * k + add))},${Math.round(clamp255(c[2] * k + add))})`;
    // the room: a dim wall gradient, a few out-of-focus lights and a desk the farm stands on
    const wall = g.createLinearGradient(0, 0, 0, THUMB_H);
    wall.addColorStop(0, rgb(env.skyTop, 105, 10));
    wall.addColorStop(0.72, rgb(env.skyHorizon, 120, 16));
    wall.addColorStop(1, rgb(env.skyHorizon, 70, 8));
    g.fillStyle = wall;
    g.fillRect(0, 0, THUMB_W, THUMB_H);
    const bokeh: [number, number, number, string][] = [
      [0.1, 0.3, 0.2, 'rgba(255, 214, 150, .16)'],
      [0.9, 0.22, 0.26, 'rgba(160, 205, 255, .13)'],
      [0.8, 0.62, 0.13, 'rgba(255, 190, 120, .11)'],
      [0.2, 0.7, 0.1, 'rgba(190, 255, 210, .07)'],
    ];
    for (const [bx, by, br, colr] of bokeh) {
      const rg = g.createRadialGradient(bx * THUMB_W, by * THUMB_H, 0, bx * THUMB_W, by * THUMB_H, br * THUMB_H * 2);
      rg.addColorStop(0, colr);
      rg.addColorStop(0.6, colr.replace(/[\d.]+\)$/, '.04)'));
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg;
      g.fillRect(0, 0, THUMB_W, THUMB_H);
    }
    // fit the whole pane (wide farms use the width, tall ones the height), standing on the desk
    const deskY = Math.round(THUMB_H * 0.9);
    const s = Math.min((THUMB_W * 0.92) / img.width, (deskY - THUMB_H * 0.07) / img.height);
    const dw = Math.round(img.width * s);
    const dh = Math.round(img.height * s);
    const dx = Math.round((THUMB_W - dw) / 2);
    const dy = deskY - dh;
    const desk = g.createLinearGradient(0, deskY, 0, THUMB_H);
    desk.addColorStop(0, 'rgba(58, 44, 32, .98)');
    desk.addColorStop(1, 'rgba(24, 18, 14, 1)');
    g.fillStyle = desk;
    g.fillRect(0, deskY, THUMB_W, THUMB_H - deskY);
    if (hasGel) {
      // backlit gel: a halo on the wall and a blue pool of light on the desk
      const halo = g.createRadialGradient(THUMB_W / 2, dy + dh * 0.55, dh * 0.2, THUMB_W / 2, dy + dh * 0.55, dw * 0.9);
      halo.addColorStop(0, 'rgba(90, 170, 255, .32)');
      halo.addColorStop(1, 'rgba(90, 170, 255, 0)');
      g.fillStyle = halo;
      g.fillRect(0, 0, THUMB_W, THUMB_H);
    }
    // glass body (faint, so the air space above the fill reads as part of the farm)
    g.fillStyle = 'rgba(200, 225, 235, .07)';
    g.fillRect(dx, dy, dw, dh);
    g.drawImage(src, dx, dy, dw, dh);
    // floor reflection
    g.save();
    g.globalAlpha = hasGel ? 0.3 : 0.14;
    g.translate(0, deskY * 2);
    g.scale(1, -1);
    g.drawImage(src, 0, img.height * 0.8, img.width, img.height * 0.2, dx, deskY, dw, dh * 0.2);
    g.restore();
    const fade = g.createLinearGradient(0, deskY, 0, THUMB_H);
    fade.addColorStop(0, 'rgba(24, 18, 14, 0)');
    fade.addColorStop(1, 'rgba(24, 18, 14, .95)');
    g.fillStyle = fade;
    g.fillRect(0, deskY, THUMB_W, THUMB_H - deskY);
    // frame, base rail and a diagonal glint across the pane
    g.strokeStyle = 'rgba(225, 238, 242, .6)';
    g.lineWidth = 2.5;
    g.strokeRect(dx - 1, dy - 1, dw + 2, dh + 2);
    g.fillStyle = hasGel ? 'rgba(170, 215, 255, .9)' : 'rgba(40, 44, 46, .95)';
    g.fillRect(dx - 6, deskY - 1, dw + 12, 5);
    g.save();
    g.beginPath();
    g.rect(dx, dy, dw, dh);
    g.clip();
    const glint = g.createLinearGradient(dx, dy, dx + dh * 1.6, dy + dh);
    glint.addColorStop(0.18, 'rgba(255,255,255,0)');
    glint.addColorStop(0.3, 'rgba(255,255,255,.11)');
    glint.addColorStop(0.36, 'rgba(255,255,255,.02)');
    glint.addColorStop(0.42, 'rgba(255,255,255,.07)');
    glint.addColorStop(0.5, 'rgba(255,255,255,0)');
    g.fillStyle = glint;
    g.fillRect(dx, dy, dw, dh);
    g.restore();
  } else {
    // cover: the middle band of the square map, slightly tilted for a diorama feel
    const cols = img.width / TOP_SS;
    const rows = img.height / TOP_SS;
    const sc = Math.max((THUMB_W * 1.12) / cols, (THUMB_H * 1.12) / rows); // output px per column
    g.save();
    g.translate(THUMB_W / 2, THUMB_H / 2);
    g.rotate(-0.12);
    g.drawImage(src, (-cols * sc) / 2, (-rows * sc) / 2, cols * sc, rows * sc);
    g.restore();
    // warm key light from the upper left, cool shade to the lower right
    const sun = g.createLinearGradient(0, 0, THUMB_W, THUMB_H);
    sun.addColorStop(0, 'rgba(255, 226, 170, .16)');
    sun.addColorStop(0.5, 'rgba(255, 226, 170, 0)');
    sun.addColorStop(1, 'rgba(20, 40, 70, .2)');
    g.fillStyle = sun;
    g.fillRect(0, 0, THUMB_W, THUMB_H);
    // markers: food (amber) and the nest entrance (ring)
    const toPx = (x: number, z: number): [number, number] => {
      const lx = (x - cols / 2) * sc;
      const lz = (z - rows / 2) * sc;
      const c = Math.cos(-0.12);
      const sn = Math.sin(-0.12);
      return [THUMB_W / 2 + lx * c - lz * sn, THUMB_H / 2 + lx * sn + lz * c];
    };
    for (const f of map.foodSources) {
      const [fx, fy] = toPx(f.pos.x, f.pos.z);
      g.fillStyle = 'rgba(30, 20, 5, .45)';
      g.beginPath();
      g.arc(fx + 1, fy + 1.5, 4.4, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(248, 196, 84, .98)';
      g.beginPath();
      g.arc(fx, fy, 3.8, 0, Math.PI * 2);
      g.fill();
    }
    for (const sp of map.spawns) {
      if (sp.kind === 'creature') continue;
      const p = sp.entrance ?? sp.pos;
      const [ex, ey] = toPx(p.x, p.z);
      g.strokeStyle = 'rgba(0,0,0,.45)';
      g.lineWidth = 5.5;
      g.beginPath();
      g.arc(ex, ey, 8.5, 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = sp.kind === 'colony' ? 'rgba(255,255,255,.96)' : 'rgba(239,111,97,.96)';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(ex, ey, 8.5, 0, Math.PI * 2);
      g.stroke();
    }
  }
  // vignette
  const v = g.createRadialGradient(THUMB_W / 2, THUMB_H / 2, THUMB_H * 0.35, THUMB_W / 2, THUMB_H / 2, THUMB_W * 0.62);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,.45)');
  g.fillStyle = v;
  g.fillRect(0, 0, THUMB_W, THUMB_H);
  return out;
}

/** Generates and caches thumbnails one per idle slice; `request` paints into the given canvas when ready. */
export class ThumbQueue {
  private readonly cache = new Map<string, HTMLCanvasElement>();
  private readonly waiting: { key: string; map: MapId; seed: number; faction: SpeciesId; targets: HTMLCanvasElement[] }[] = [];
  /** Called once per generated preview world (the menu reads the map goal from it). */
  onGenerated: ((map: MapId, seed: number, gen: MapGenResult) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  request(map: MapId, seed: number, faction: SpeciesId, target: HTMLCanvasElement): void {
    const key = `${map}:${seed}`;
    target.dataset.thumb = key;
    const done = this.cache.get(key);
    if (done) {
      this.blit(done, target);
      return;
    }
    const job = this.waiting.find((j) => j.key === key);
    if (job) {
      if (!job.targets.includes(target)) job.targets.push(target);
    } else this.waiting.push({ key, map, seed, faction, targets: [target] });
    this.schedule();
  }

  private blit(src: HTMLCanvasElement, target: HTMLCanvasElement): void {
    if (target.width !== src.width) target.width = src.width;
    if (target.height !== src.height) target.height = src.height;
    target.getContext('2d')?.drawImage(src, 0, 0);
    target.dataset.ready = '1';
  }

  private schedule(): void {
    if (this.timer !== null || this.disposed || !this.waiting.length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const job = this.waiting.shift();
      if (job && !this.disposed) {
        try {
          const gen = getMap(job.map).generate(job.seed, { faction: job.faction, small: true });
          const canvas = renderMapThumb(gen);
          this.onGenerated?.(job.map, job.seed, gen);
          this.cache.set(job.key, canvas);
          // a target may have been re-requested for another key in the meantime
          for (const t of job.targets) if (t.dataset.thumb === job.key) this.blit(canvas, t);
        } catch {
          /* a generator failure only costs the preview */
        }
      }
      this.schedule();
    }, 40);
  }

  get pending(): number {
    return this.waiting.length;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.waiting.length = 0;
    this.cache.clear();
  }
}
