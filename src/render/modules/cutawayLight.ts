import * as THREE from 'three';
import type { Module } from '../shared';
import { getEnv } from './skyEnv';

/**
 * Underground legibility (§5.3, §13 "underground/farm visibility"):
 *
 *  - cutaway fill: a warm, shadowless directional light that shines straight into the exposed
 *    cross-section whenever the cut plane is on, so nests read like a lit museum display instead
 *    of a dark hole (the sun rarely reaches a vertical cut face).
 *  - possession lamp: a small warm point light riding above the possessed ant, fading in as the
 *    ant goes below ground (or at night), so tunnels are readable from inside.
 *
 * Both lights always exist (intensity 0 when idle) so toggling never recompiles shaders.
 */
export function createCutawayLightModule(): Module {
  let fill: THREE.DirectionalLight | null = null;
  let lamp: THREE.PointLight | null = null;
  let fillCur = 0;
  let lampCur = 0;
  return {
    id: 'cutawayLight',
    init(ctx) {
      fill = new THREE.DirectionalLight(new THREE.Color(1.0, 0.86, 0.68), 0);
      fill.name = 'cutaway-fill';
      ctx.scene.add(fill, fill.target);
      lamp = new THREE.PointLight(new THREE.Color(1.0, 0.78, 0.5), 0, 16, 1.7);
      lamp.name = 'possess-lamp';
      ctx.scene.add(lamp);
      fillCur = lampCur = 0;
    },
    update(ctx, frame) {
      if (!fill || !lamp) return;
      const env = getEnv(ctx);
      const view = ctx.view;
      const snap = ctx.sync || frame.frozen;
      const k = snap ? 1 : Math.min(1, frame.dt * 6);

      // ---- cutaway fill ----
      const cut = view.cut;
      const f = view.camera.focus;
      if (cut.enabled) {
        const nx = cut.axis === 'x' ? cut.sign : 0;
        const ny = cut.axis === 'y' ? cut.sign : 0;
        const nz = cut.axis === 'z' ? cut.sign : 0;
        fill.target.position.set(f.x, f.y, f.z);
        // from the removed side, slightly above and off-axis for some modelling
        fill.position.set(f.x + nx * 60 + nz * 18 + ny * 10, f.y + ny * 60 + 26 * (1 - Math.abs(ny)), f.z + nz * 60 - nx * 18 + ny * 10);
        fill.target.updateMatrixWorld();
      }
      const fillTarget = cut.enabled ? (env.room ? 0.5 : 1.9 + 0.5 * env.night) : 0;
      fillCur += (fillTarget - fillCur) * k;
      fill.intensity = fillCur;

      // ---- possession lamp ----
      let lampTarget = 0;
      if (view.mode === 'possess') {
        const ant = ctx.sim.getAnt(view.possessedId || ctx.sim.possessedId);
        if (ant) {
          const up = ant.up;
          const tx = ant.pos.x + up.x * 0.9;
          const ty = ant.pos.y + up.y * 0.9;
          const tz = ant.pos.z + up.z * 0.9;
          if (snap || lampCur < 0.01) lamp.position.set(tx, ty, tz);
          else lamp.position.lerp(_v.set(tx, ty, tz), Math.min(1, frame.dt * 10));
          if (env.room) {
            lampTarget = 1.6;
            lamp.color.setRGB(0.8, 0.92, 1.0);
          } else {
            const depth = env.ground.heightAt(ant.pos.x, ant.pos.z) - ant.pos.y;
            const under = Math.min(1, Math.max(0, (depth - 0.8) / 2.5));
            lampTarget = 7 * under + 1.2 * env.night;
            lamp.color.setRGB(1.0, 0.78, 0.5);
          }
        }
      }
      lampCur += (lampTarget - lampCur) * k;
      lamp.intensity = lampCur;
    },
    dispose() {
      fill?.removeFromParent();
      fill?.target.removeFromParent();
      fill?.dispose();
      lamp?.removeFromParent();
      lamp?.dispose();
      fill = null;
      lamp = null;
    },
  };
}

const _v = new THREE.Vector3();

export const cutawayLightModule: Module = createCutawayLightModule();
