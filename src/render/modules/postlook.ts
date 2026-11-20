import type { LookExtras, LookSettings, MapId } from '../../core';
import type { Module, RenderContext } from '../shared';
import { fx, fxDecay, fxReset } from './fxShared';
import { defaultLookExtras, getEnv, type EnvState } from './skyEnv';

/**
 * Look tuning (§5.3): writes `ctx.look` (and the A3 `LookExtras`) every frame from
 *  - the map's grade preset, blended with time of day (golden hour, night) and weather,
 *  - the DoF policy: none at far RTS zoom → gentle tilt-shift when zoomed in → strong macro DoF
 *    with autofocus on the possessed ant (or when `__myrmeLook.macro` is set for photo poses),
 *  - bloom / god rays / AO / fog tuned per backdrop.
 * Targets are approached smoothly; blocking renders (`ctx.sync`, screenshots) snap.
 */

interface GradePreset {
  exposure: number;
  saturation: number;
  contrast: number;
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  temperature: number;
  bloom: number;
  bloomThreshold: number;
  fogScale: number;
  fogHeight: number;
}

const PRESETS: Record<MapId, GradePreset> = {
  meadow: { exposure: 1.0, saturation: 0.14, contrast: 0.1, shadowTint: [0.94, 0.98, 1.06], highlightTint: [1.04, 1.01, 0.95], temperature: 0.1, bloom: 0.55, bloomThreshold: 0.92, fogScale: 1, fogHeight: 16 },
  forest: { exposure: 1.08, saturation: 0.1, contrast: 0.12, shadowTint: [0.9, 1.0, 0.98], highlightTint: [1.05, 1.03, 0.9], temperature: 0.05, bloom: 0.7, bloomThreshold: 0.85, fogScale: 0.7, fogHeight: 10 },
  desert: { exposure: 0.95, saturation: 0.08, contrast: 0.14, shadowTint: [0.95, 0.96, 1.08], highlightTint: [1.06, 1.0, 0.9], temperature: 0.35, bloom: 0.5, bloomThreshold: 0.95, fogScale: 0.7, fogHeight: 22 },
  gelFarm: { exposure: 1.0, saturation: 0.16, contrast: 0.1, shadowTint: [0.92, 0.97, 1.08], highlightTint: [1.03, 1.0, 0.97], temperature: 0.0, bloom: 0.9, bloomThreshold: 0.78, fogScale: 0, fogHeight: 20 },
  sandFarm: { exposure: 1.0, saturation: 0.12, contrast: 0.1, shadowTint: [0.96, 0.97, 1.05], highlightTint: [1.05, 1.01, 0.94], temperature: 0.15, bloom: 0.6, bloomThreshold: 0.85, fogScale: 0, fogHeight: 20 },
  formicarium: { exposure: 1.0, saturation: 0.1, contrast: 0.1, shadowTint: [0.95, 0.97, 1.05], highlightTint: [1.04, 1.01, 0.95], temperature: 0.12, bloom: 0.6, bloomThreshold: 0.85, fogScale: 0, fogHeight: 20 },
};

const ss = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function computeTarget(ctx: RenderContext, s: EnvState, look: LookSettings, ex: LookExtras): void {
  const p = PRESETS[ctx.sim.mapId] ?? PRESETS.meadow;
  const view = ctx.view;
  const dbg = s.debug;
  const night = s.night;
  const golden = s.room ? 0 : s.golden;
  const possess = view.mode === 'possess' || dbg.macro === true;
  const fd = view.camera.focusDist;

  look.exposure = p.exposure * (s.room ? 1 + 0.35 * night : 1 + 0.45 * golden * (1 - night) + 2.0 * Math.max(night, s.lowLight) + 0.5 * s.lowLight * (1 - night)) * (dbg.exposureScale ?? 1);

  // ---- AO: world-space radius; tight contact shadows when close ----
  look.ssao.intensity = possess ? 1.15 : 1.0;
  look.ssao.radius = possess ? 0.55 : Math.min(2.4, 0.5 + fd * 0.035);
  look.ssao.bias = 0.035;
  ex.aoFade = possess ? 40 : 60 + fd * 2.5;

  // ---- bloom: backlit foliage, gel glow, sun glints ----
  look.bloom.intensity = p.bloom * (1 + 0.5 * golden + (s.room ? 0.5 * night : 0.2 * night));
  look.bloom.threshold = p.bloomThreshold - 0.12 * golden - (s.room ? 0.1 * night : 0.25 * night);
  // pheromone vision: the world is dimmed and desaturated, the scent glows
  const pv = ctx.uniforms.uPheroVision.value;
  look.bloom.intensity += 0.6 * pv;
  look.bloom.threshold += (0.62 - look.bloom.threshold) * pv;
  look.bloom.smoothing = 0.25;
  look.bloom.radius = 0.72;

  // ---- DoF policy (§5.3) ----
  const d = look.dof;
  d.autoFocus = true;
  if (possess) {
    d.strength = 1;
    d.focusRange = Math.max(2.2, fd * 2.2 + 1.5);
    d.bokehScale = 3.6;
  } else if (view.mode === 'slab') {
    // the pane is a flat subject: keep it crisp, let the room melt away
    d.strength = 1;
    d.focusRange = Math.max(10, fd * 0.6);
    d.bokehScale = 4.5;
  } else {
    d.strength = 0.75 * ss(60, 16, fd);
    d.focusRange = Math.max(8, fd * 1.5);
    d.bokehScale = 2.2;
  }
  if (view.cut.enabled && !possess) d.strength *= 0.35; // the cross-section is a flat subject: keep it crisp
  d.strength *= dbg.dofScale ?? 1;

  // ---- god rays ----
  const g = look.godRays;
  g.intensity = s.room ? 0 : (0.16 + 0.5 * golden) * s.day * (1 - 0.6 * s.cloudiness);
  g.decay = 0.93;
  g.density = 0.92;
  g.weight = 0.32;

  // ---- grade ----
  look.grade.saturation = p.saturation + 0.06 * golden - 0.34 * night * (s.room ? 0.2 : 1) - 0.12 * s.cloudiness * (s.room ? 0 : 1);
  look.grade.contrast = p.contrast + 0.04 * golden;
  look.grade.brightness = 0;
  look.grade.hue = 0;
  const nb = s.room ? 0 : night;
  ex.shadowTint = [p.shadowTint[0] - 0.14 * nb - 0.02 * golden, p.shadowTint[1] - 0.04 * nb - 0.02 * golden, p.shadowTint[2] + 0.12 * nb + 0.05 * golden];
  ex.highlightTint = [p.highlightTint[0] + 0.05 * golden - 0.08 * nb, p.highlightTint[1] - 0.02 * nb, p.highlightTint[2] - 0.06 * golden + 0.08 * nb];
  ex.temperature = p.temperature + 0.35 * golden - 0.3 * nb + (s.room ? 0.25 * night : 0);
  ex.lift = 0.012 + 0.012 * golden;

  look.vignette.offset = possess ? 0.28 : 0.36;
  look.vignette.darkness = (possess ? 0.6 : 0.46 + 0.1 * night) + 0.18 * pv;
  look.chromaticAberration = possess ? 0.0009 : 0.00045;
  look.grain = 0.03 + 0.03 * night;

  // ---- fog ----
  const envDef = ctx.map.environment;
  const wet = s.wetness;
  ex.fogDensity = envDef.fogDensity * p.fogScale * (1 + 1.6 * golden + 0.6 * night + 2.2 * wet + 1.2 * s.cloudiness * s.cloudiness);
  if (view.cut.enabled) ex.fogDensity *= 0.25; // a lit exhibit, not a misty hole
  ex.fogHeight = p.fogHeight;
  ex.fogBase = s.mapExtras?.surfaceY ?? ctx.sim.world.sy * 0.5;
  ex.fogColor = [s.fogColor.r, s.fogColor.g, s.fogColor.b];
  const fs = (0.35 * golden + 0.12 * s.day) * (1 - 0.7 * s.cloudiness);
  ex.fogSunColor = [s.keyColor.r * fs, s.keyColor.g * fs, s.keyColor.b * fs];
}

function approach(cur: Record<string, unknown>, target: Record<string, unknown>, k: number): void {
  for (const key of Object.keys(target)) {
    const t = target[key];
    const c = cur[key];
    if (typeof t === 'number' && typeof c === 'number') cur[key] = c + (t - c) * k;
    else if (Array.isArray(t) && Array.isArray(c)) for (let i = 0; i < t.length; i++) c[i] += (t[i] - c[i]) * k;
    else if (t !== null && typeof t === 'object' && c !== null && typeof c === 'object') approach(c as Record<string, unknown>, t as Record<string, unknown>, k);
    else cur[key] = t;
  }
}

export function createPostlookModule(): Module {
  let target: LookSettings | null = null;
  // smoothed base look; `ctx.look` = base × the B4 FX modifiers (`fxShared`), rewritten every frame
  let base: LookSettings | null = null;
  const targetEx: LookExtras = defaultLookExtras();
  const baseEx: LookExtras = defaultLookExtras();
  let first = true;
  return {
    id: 'postlook',
    init(ctx) {
      target = JSON.parse(JSON.stringify(ctx.look)) as LookSettings;
      base = JSON.parse(JSON.stringify(ctx.look)) as LookSettings;
      first = true;
      fxReset();
    },
    update(ctx, frame) {
      if (!target || !base) return;
      const s = getEnv(ctx);
      computeTarget(ctx, s, target, targetEx);
      const k = first || ctx.sync || frame.frozen ? 1 : Math.min(1, frame.dt * 4);
      first = false;
      approach(base as unknown as Record<string, unknown>, target as unknown as Record<string, unknown>, k);
      approach(baseEx as unknown as Record<string, unknown>, targetEx as unknown as Record<string, unknown>, k);
      approach(ctx.look as unknown as Record<string, unknown>, base as unknown as Record<string, unknown>, 1);
      approach(s.extras as unknown as Record<string, unknown>, baseEx as unknown as Record<string, unknown>, 1);

      // ---- B4 FX modifiers (weather, keeper, combat feedback) ----
      const look = ctx.look;
      const ex = s.extras;
      look.exposure *= fx.exposure * (1 - 0.3 * fx.dim) * (1 + (ctx.quality.preset === 'low' ? 0.12 : 0.4) * fx.flash) * (1 - 0.34 * ctx.uniforms.uPheroVision.value);
      look.bloom.intensity += fx.bloom + 0.6 * fx.flash;
      look.grade.saturation -= 0.18 * fx.dim;
      look.vignette.darkness += 0.25 * fx.hurt + 0.12 * fx.dim;
      look.chromaticAberration += 0.0035 * fx.kick + 0.0012 * fx.hurt;
      ex.fogDensity *= 1 + fx.fog;
      ex.temperature += 0.45 * fx.warm - 0.25 * fx.flash;
      fxDecay(fx.dAnim);
    },
    dispose() {
      target = null;
      base = null;
    },
  };
}

export const postlookModule: Module = createPostlookModule();
