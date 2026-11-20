import * as THREE from 'three';

/**
 * Shared between waterFx and weatherFx (no module of its own):
 *  - a ring buffer of expanding ripple rings (xz, birth time on the FX clock, strength) that the
 *    water-surface shader reads as a uniform array,
 *  - the rain level both modules agree on (`uRain.value.x` = intensity 0..1, `.y` = storm 0..1,
 *    `.z` = smoothed surface wetness, `.w` = wind strength) — exported so the terrain shader can
 *    bind it later for rain ripples on wet ground,
 *  - a tiny "is there water here?" query filled by waterFx on every rebuild, so weatherFx can turn
 *    a droplet impact into a ripple instead of a crater.
 */
export const RIPPLE_COUNT = 24;

export const waterShared = {
  /** xy = world xz, z = birth time (fx clock), w = strength (ring amplitude, 0 = free). */
  uRipples: { value: Array.from({ length: RIPPLE_COUNT }, () => new THREE.Vector4(0, 0, -1e3, 0)) } as THREE.IUniform<THREE.Vector4[]>,
  uRain: { value: new THREE.Vector4(0, 0, 0, 0) } as THREE.IUniform<THREE.Vector4>,
  cursor: 0,
  /** Water surface height at a world xz column (highest flooded cell top), or -Infinity. Set by waterFx. */
  surfaceAt: ((_x: number, _z: number): number => -Infinity) as (x: number, z: number) => number,
  /** Number of flooded cells last seen (0 = nothing to draw). */
  flooded: 0,
};

/** Starts a ripple ring at a world xz position (`time` = fx clock now). */
export function addRipple(x: number, z: number, time: number, strength: number): void {
  const v = waterShared.uRipples.value[waterShared.cursor];
  waterShared.cursor = (waterShared.cursor + 1) % RIPPLE_COUNT;
  v.set(x, z, time, strength);
}

export function resetWaterShared(): void {
  for (const v of waterShared.uRipples.value) v.set(0, 0, -1e3, 0);
  waterShared.uRain.value.set(0, 0, 0, 0);
  waterShared.cursor = 0;
  waterShared.surfaceAt = () => -Infinity;
  waterShared.flooded = 0;
}
