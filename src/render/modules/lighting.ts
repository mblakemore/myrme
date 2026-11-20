import * as THREE from 'three';
import type { Module } from '../shared';
import { fx } from './fxShared';
import { getEnv } from './skyEnv';

const _flashC = new THREE.Color(0.72, 0.8, 1.0);

/**
 * Lighting (§5.3). Drives the key light (sun by day, moon by night, window/lamp in a room), the
 * shared `uSunDir` / `uSunColor` / `uWind` / `uWetness` uniforms, a hemisphere fill and a weak
 * shadowless counter light for rim and shape in shadowed areas — all from the A3 environment
 * state (time of day, weather). Image-based ambient comes from the sky module's PMREM.
 */
export function createLightingModule(): Module {
  let hemi: THREE.HemisphereLight | null = null;
  let fill: THREE.DirectionalLight | null = null;
  let gust = 0;
  return {
    id: 'lighting',
    init(ctx) {
      hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
      hemi.name = 'hemi';
      ctx.scene.add(hemi);
      fill = new THREE.DirectionalLight(0xffffff, 0.2);
      fill.name = 'fill';
      ctx.scene.add(fill, fill.target);
      this.update(ctx, { dt: 0, time: 0, alpha: 1, tick: 0, events: [], frozen: true, frame: 0 });
    },
    update(ctx, frame) {
      const s = getEnv(ctx);
      const u = ctx.uniforms;
      u.uSunDir.value.copy(s.keyDir);
      u.uSunColor.value.copy(s.keyColor);
      ctx.sun.color.copy(s.keyColor);
      // B4 weather: storm clouds eat the key light; a lightning flash is a hard, cold key for a few frames
      const flash = s.room ? 0 : fx.flash * (ctx.quality.preset === 'low' ? 0.4 : 1);
      const dim = s.room ? 0 : fx.dim;
      ctx.sun.intensity = s.keyIntensity * (1 - 0.65 * dim) + 3.6 * flash;
      if (flash > 0.001) {
        ctx.sun.color.lerp(_flashC, Math.min(1, flash * 1.4));
        u.uSunColor.value.lerp(_flashC, Math.min(1, flash * 1.4));
      }
      u.uWetness.value = s.wetness;

      // wind: weather vector → direction × strength, with a slow gust phase
      const w = ctx.sim.weather.wind;
      const base = s.room ? 0 : 0.35;
      const k = s.room ? 0 : 1;
      u.uWind.value.x = (w.x * 0.6 + (w.x === 0 && w.z === 0 ? base : 0)) * k;
      u.uWind.value.y = w.z * 0.6 * k;
      gust += frame.dt * (0.6 + 0.5 * Math.hypot(w.x, w.z));
      u.uWind.value.z = frame.frozen ? frame.time * 0.8 : gust;

      // Image-based light carries most of the ambient; the hemisphere keeps undersides readable.
      const envShare = s.room ? 0.5 : 0.55;
      ctx.scene.environmentIntensity = envShare * (s.room ? 0.9 + 0.5 * s.day : 0.45 + 0.75 * s.day + 0.9 * s.night);
      hemi!.color.copy(s.hemiSky);
      hemi!.groundColor.copy(s.hemiGround);
      hemi!.intensity = s.ambient * (s.room ? 0.9 : 0.75) * (1 - 0.3 * dim) + 0.6 * flash;

      // counter light: opposite the key in azimuth, sky coloured
      fill!.color.copy(s.hemiSky);
      fill!.intensity = s.ambient * (s.room ? 0.5 : 0.32);
      const f = ctx.view.camera.focus;
      fill!.target.position.set(f.x, f.y, f.z);
      fill!.position.set(f.x - s.keyDir.x * 40, f.y + 22, f.z - s.keyDir.z * 40);
      fill!.target.updateMatrixWorld();
    },
    dispose() {
      hemi?.removeFromParent();
      hemi?.dispose();
      fill?.removeFromParent();
      fill?.target.removeFromParent();
      fill?.dispose();
      hemi = fill = null;
    },
  };
}

export const lightingModule: Module = createLightingModule();
