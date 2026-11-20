import * as THREE from 'three';
import { HOME_UNREACHABLE, PHERO_CHANNELS, type FrameInfo } from '../../core';
import { PHERO_MAX } from '../../world/pheromones';
import type { Module, RenderContext } from '../shared';
import { fx } from './fxShared';
import { getEnv } from './skyEnv';
import { PHERO_COLORS } from './particles';

/**
 * Pheromone visualisation (§5.3 views): the colony's scent trails, coloured per channel.
 *
 * Two layers in ONE point-sprite draw call:
 *  - ribbon: one wide, soft, surface-hugging glow per active cell. Neighbouring cells overlap, so
 *    a trail reads as a continuous luminous band at any zoom — at whole-map distance the sprites
 *    are clamped to a few pixels and made denser instead of dissolving into dots.
 *  - motes: a few sparks per cell that rise, drift with the wind and fade.
 * Both ride a travelling brightness pulse whose phase is the cell's distance to the nest (the
 * colony home field), so trails visibly *flow*: food scent streams home, alarm / trail / rally
 * pulses run outwards.
 *
 * Barely-there in the normal view (food / alarm / attack mostly), vivid in pheromone vision
 * (`uPheroVision`; `postlook` adds the bloom). Budgeted: active cells of the player's colony are
 * rescanned a few times per second, nearest the camera focus first (adaptive radius, hard cap);
 * all motion is in the vertex shader on the FX clock, nothing is uploaded between rescans.
 */

const MAX_CELLS = 3000;
const POINTS_PER_CELL = 4; // ribbon + up to 3 motes
const MAX_POINTS = MAX_CELLS * POINTS_PER_CELL;
/** Channel visibility in the normal (non-vision) view. */
// (avoid / death are static blotches around pits and the midden: nearly off outside the vision)
const NORMAL_VIEW = [0.55, 0.9, 0.18, 0.3, 0.7, 0.9, 0.1, 0.3];
/** Pulse direction per channel: +1 flows towards the nest, −1 away from it. */
const FLOW_DIR = [1, -1, 1, -1, -1, -1, -1, -1];

const VERT = /* glsl */ `
attribute vec4 aData; // channel, strength 0..1, seed, kind (0 = ribbon, 1.. = mote index)
attribute float aFlow; // steps to the nest (pulse phase along the trail)
uniform float uClock;
uniform float uPheroVision;
uniform float uPx;
uniform vec3 uColors[${PHERO_CHANNELS}];
uniform float uNormalView[${PHERO_CHANNELS}];
uniform float uNormalGain; // dims the normal-view hint at night (additive glow on a dark scene)
uniform float uFlowDir[${PHERO_CHANNELS}];
uniform vec3 uWind;
varying vec4 vCol;
varying vec3 vWorld;
varying float vKind;
void main() {
  int ch = int(aData.x + 0.5);
  float strength = aData.y;
  float seed = aData.z;
  float kind = aData.w;
  float t = uClock;
  // travelling pulse: a bright crest every ~11 cells
  float wave = 0.5 + 0.5 * sin(aFlow * 0.56 + t * 2.4 * uFlowDir[ch] + float(ch) * 1.7);
  wave *= wave * wave;
  float vis = mix(uNormalView[ch] * uNormalGain * (kind < 0.5 ? 0.6 : 0.3), 1.0, uPheroVision);
  vec3 wp = position;
  float a;
  float size;
  float minPx;
  if (kind < 0.5) {
    size = mix(1.25, 2.1, strength);
    minPx = mix(2.0, 4.5, uPheroVision);
    a = vis * (0.07 + 0.2 * strength) * (0.5 + 1.1 * wave) * mix(0.45, 1.0, uPheroVision);
  } else {
    // each mote lives a short looping life: appear, drift up and sideways, fade
    float period = 2.6 + seed * 2.2;
    float life = fract(t / period + seed * 7.31 + kind * 0.37);
    wp += vec3(sin(t * 0.9 + seed * 40.0), 0.0, cos(t * 0.7 + seed * 31.0)) * 0.12;
    wp.y += life * (0.35 + 0.3 * seed);
    wp.xz += uWind.xy * life * 0.25;
    float fade = smoothstep(0.0, 0.2, life) * (1.0 - smoothstep(0.55, 1.0, life));
    float twinkle = 0.75 + 0.25 * sin(t * 5.0 + seed * 90.0);
    a = vis * fade * twinkle * (0.25 + 0.75 * strength) * (0.6 + 0.9 * wave);
    size = (0.05 + 0.08 * strength) * (0.7 + 0.6 * seed) * mix(0.8, 1.9, uPheroVision);
    minPx = mix(1.2, 2.0, uPheroVision);
  }
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  float px = uPx * size / max(-mv.z, 0.05);
  gl_PointSize = clamp(px, minPx, 240.0);
  if (kind < 0.5) {
    // far away a cell is only a few pixels: trade size for density so the band stays continuous
    a *= mix(3.0, 1.0, smoothstep(4.0, 22.0, px));
    // very close the glow would wash over the whole view
    a *= 1.0 - mix(0.94 * smoothstep(36.0, 120.0, px), 0.75 * smoothstep(150.0, 240.0, px), uPheroVision);
    // normal view: every trail converges on the entrance, where the stacked hints became a green
    // smudge hanging over the hole — the hint is only needed out along the trail
    a *= mix(smoothstep(3.0, 14.0, aFlow), 1.0, uPheroVision);
  } else {
    // sub-pixel motes would alias: let them dissolve (the ribbon carries the trail out there)
    a *= smoothstep(0.5, 1.6, px);
  }
  vCol = vec4(uColors[ch] * (0.65 + 0.75 * strength), a);
  vKind = kind;
  vWorld = wp;
}
`;

const FRAG = /* glsl */ `
uniform vec4 uCutPlane;
varying vec4 vCol;
varying vec3 vWorld;
varying float vKind;
void main() {
  if (dot(uCutPlane.xyz, vWorld) + uCutPlane.w > 0.0) discard;
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  float a;
  if (vKind < 0.5) {
    a = exp(-r * r * 3.4) * (1.0 - smoothstep(0.85, 1.0, r));
  } else {
    a = smoothstep(1.0, 0.0, r);
    a = a * a * 0.7 + smoothstep(0.35, 0.0, r) * 0.6;
  }
  a *= vCol.a;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vCol.rgb * a, 0.0);
}
`;

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export function createPheromoneVizModule(): Module {
  let points: THREE.Points | null = null;
  let pos = new Float32Array(0);
  let data = new Float32Array(0);
  let flow = new Float32Array(0);
  let uPx: THREE.IUniform<number> = { value: 500 };
  const uNormalGain = { value: 1 };
  let lastScanTick = -1000;
  let lastScanFrame = -1000;
  let radius = 260;
  let count = 0;

  return {
    id: 'pheromoneViz',
    init(ctx) {
      const g = new THREE.BufferGeometry();
      pos = new Float32Array(MAX_POINTS * 3);
      data = new Float32Array(MAX_POINTS * 4);
      flow = new Float32Array(MAX_POINTS);
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aData', new THREE.BufferAttribute(data, 4).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aFlow', new THREE.BufferAttribute(flow, 1).setUsage(THREE.DynamicDrawUsage));
      g.setDrawRange(0, 0);
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      uPx = { value: 500 };
      uNormalGain.value = 1;
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          uClock: fx.uClock,
          uPheroVision: ctx.uniforms.uPheroVision,
          uCutPlane: ctx.uniforms.uCutPlane,
          uWind: ctx.uniforms.uWind,
          uPx,
          uColors: { value: PHERO_COLORS.map((c) => new THREE.Vector3(c[0], c[1], c[2])) },
          uNormalView: { value: NORMAL_VIEW },
          uNormalGain,
          uFlowDir: { value: FLOW_DIR },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
        toneMapped: false,
      });
      points = new THREE.Points(g, mat);
      points.name = 'pheromoneViz';
      points.frustumCulled = false;
      points.renderOrder = 5;
      points.visible = false;
      ctx.scene.add(points);
      lastScanTick = -1000;
      lastScanFrame = -1000;
      count = 0;
    },

    update(ctx: RenderContext, frame: FrameInfo) {
      if (!points) return;
      const cam = ctx.view.camera;
      uPx.value = ctx.renderer.domElement.height / (2 * Math.tan((cam.fov * Math.PI) / 360));
      {
        const env = getEnv(ctx);
        uNormalGain.value = env.room ? 1 : 0.28 + 0.72 * env.day;
      }

      // rescan ~4×/s of sim time (evaporation runs at 2 Hz), and when the camera jumps in shots
      const due = Math.abs(frame.tick - lastScanTick) >= 8 || (ctx.sync && frame.frame !== lastScanFrame) || frame.frame - lastScanFrame > 20;
      if (due) {
        lastScanTick = frame.tick;
        lastScanFrame = frame.frame;
        const sim = ctx.sim;
        const world = sim.world;
        const sx = world.sx;
        const sxz = world.sx * world.sz;
        const fx = cam.focus.x;
        const fy = cam.focus.y;
        const fz = cam.focus.z;
        const r2 = radius * radius;
        let cells = 0;
        let seen = 0;
        let n = 0;
        const colony = sim.playerColony;
        for (let ch = 0; ch < PHERO_CHANNELS && colony; ch++) {
          const max = PHERO_MAX[ch] ?? 10;
          sim.pheromones.forEachActive(colony, ch as 0, (cell, value) => {
            const y = Math.floor(cell / sxz);
            const rem = cell - y * sxz;
            const z = Math.floor(rem / sx);
            const x = rem - z * sx;
            const dx = x + 0.5 - fx;
            const dy = y + 0.5 - fy;
            const dz = z + 0.5 - fz;
            if (dx * dx + dy * dy + dz * dz > r2) return;
            seen++;
            if (cells >= MAX_CELLS) return;
            cells++;
            // perceptual strength: weak trails still show, strong ones saturate
            const s = Math.min(1, 0.18 + 0.82 * Math.pow(value / max, 0.4));
            const hd = sim.nav.homeDistance(colony, cell);
            const ph = hd === HOME_UNREACHABLE ? hash(cell * 0.37) * 40 : hd;
            const motes = s > 0.7 ? 3 : s > 0.4 ? 2 : 1;
            for (let m = 0; m <= motes; m++) {
              const h = hash(cell * 3.17 + ch * 11.3 + m * 5.7);
              const h2 = hash(cell * 1.31 + ch * 7.9 + m * 13.1);
              const h3 = hash(cell * 2.71 + m * 3.3);
              // m = 0 is the ribbon sprite (cell centre, small jitter); the rest are motes
              const j = m === 0 ? 0.3 : 0.9;
              pos[n * 3] = x + 0.5 + (h - 0.5) * j;
              pos[n * 3 + 1] = y + 0.5 + (m === 0 ? -0.1 : (h2 - 0.5) * 0.5 - 0.15);
              pos[n * 3 + 2] = z + 0.5 + (h3 - 0.5) * j;
              data[n * 4] = ch;
              data[n * 4 + 1] = s;
              data[n * 4 + 2] = h;
              data[n * 4 + 3] = m;
              flow[n] = ph;
              n++;
            }
          });
        }
        // adaptive radius: shrink when over budget, relax back out when there is headroom
        if (seen > MAX_CELLS) radius = Math.max(10, radius * 0.8);
        else if (seen < MAX_CELLS * 0.5) radius = Math.min(260, radius * 1.1);
        count = n;
        const geo = points.geometry;
        geo.setDrawRange(0, n);
        if (n > 0) {
          const pa = geo.attributes.position as THREE.BufferAttribute;
          const da = geo.attributes.aData as THREE.BufferAttribute;
          pa.clearUpdateRanges();
          pa.addUpdateRange(0, n * 3);
          pa.needsUpdate = true;
          da.clearUpdateRanges();
          da.addUpdateRange(0, n * 4);
          da.needsUpdate = true;
          const fa = geo.attributes.aFlow as THREE.BufferAttribute;
          fa.clearUpdateRanges();
          fa.addUpdateRange(0, n);
          fa.needsUpdate = true;
        }
      }
      points.visible = count > 0;
    },

    dispose() {
      if (!points) return;
      points.removeFromParent();
      points.geometry.dispose();
      (points.material as THREE.Material).dispose();
      points = null;
    },
  };
}

export const pheromoneVizModule: Module = createPheromoneVizModule();
