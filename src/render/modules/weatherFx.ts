import * as THREE from 'three';
import { weatherEx, type FrameInfo, type Vec3 } from '../../core';
import type { Module, RenderContext } from '../shared';
import { fx, fxDemo, fxKnob } from './fxShared';
import { particles } from './particles';
import { getEnv, type EnvState } from './skyEnv';
import { vegetationTips } from './vegetation';
import { addRipple, waterShared } from './waterShared';

/**
 * Weather FX (§5.3) — everything the sky throws at an ant, driven by `sim.weather` with smoothed
 * levels (snapped in blocking / frozen renders) and by the `rainImpact`, `lightning`,
 * `weatherChanged` events:
 *
 *  - rain: a camera-wrapped volume of wind-slanted streaks (1 draw) for the distance, and near the
 *    point of interest GIANT refractive droplets (real instanced lens geometry, CPU-simulated pool)
 *    that hit the terrain (voxel raycast) and burst into a splash crown (instanced animated sheet),
 *    ballistic rebound beads (same droplet pool), spray particles, a wet impact crater decal that
 *    darkens the soil and dries over ~20 s — or a ripple ring when they land on water;
 *  - storm: lightning bolts (jagged ribbon with branches, double restrike envelope) from `lightning`
 *    events, distant sheet lightning when the sim is quiet, `fx.flash`, storm darkening `fx.dim`;
 *  - wind: flying leaves / seed fluff / dust streaming with `weather.wind`;
 *  - fog banks: `fx.fog` plus slow ground-hugging mist puffs (soft particles);
 *  - heat shimmer: drives `fx.shimmer` / `fx.shimmerY` (the screen-space distortion lives in the
 *    Renderer's FxScreenEffect) over hot ground at midday;
 *  - frost / dew sparkle: view-dependent glints strewn over the ground height field;
 *  - fireflies at night: wandering, blinking warm-green lights with soft light pools on the ground;
 *  - drips from grass tips while the meadow is wet (tips published by the vegetation module).
 *
 * Shared with waterFx through `waterShared`: `uRain` (rain, storm, wetness, wind strength) and the
 * ripple ring buffer. `weatherDrops.spawn/impact` are public for other FX (keeper water dropper).
 *
 * Sim inputs: `weather.kind/intensity/wind/wetness/temperature`, B2's `weatherEx(weather).rain/
 * fog/phase` when present (else derived from kind/intensity), env time of day (A3 `skyEnv`),
 * events `rainImpact {pos, radius}`, `lightning {pos}`, `weatherChanged`.
 * Demos (`?fxdemo=` / `__myrmeFx.demo`): `rain`, `storm`, `lightning` (a bolt every 3 s), `fog`,
 * `heat`, `frost`, `fireflies`, `wind`. Knob `__myrmeFx.dropRate` scales the giant-droplet rate.
 */

const MAX_DROPS = 144;
const MAX_CROWNS = 24;
const MAX_CRATERS = 96;
const BOLT_SEGS = 220;

const LENS = /* glsl */ `
uniform samplerCube uEnvCube;
uniform float uHasCube;
uniform vec3 uSkyA;
uniform vec3 uSkyB;
uniform vec3 uSunDirW;
uniform vec3 uKeyColor;
uniform vec3 uAmbientColor;
uniform float uFlash;
vec3 lensEnv(vec3 d, float lod) {
  if (uHasCube > 0.5) return textureCube(uEnvCube, d, lod).rgb;
  return mix(uSkyA, uSkyB, smoothstep(-0.1, 0.8, d.y));
}
// a water drop is a tiny fisheye lens: the world behind appears inverted, edges dark then bright
vec3 lensShade(vec3 N, vec3 V, out float fres) {
  float ndv = max(dot(N, V), 0.0);
  vec3 Rr = refract(-V, N, 0.75);
  vec3 refr = lensEnv(vec3(-Rr.x, abs(Rr.y), Rr.z), 1.5);
  // the inverted image: sky in the lower half of the drop, the dark ground in the upper half
  vec3 groundC = uAmbientColor * vec3(0.16, 0.14, 0.1) + uKeyColor * vec3(0.04, 0.036, 0.024);
  refr = mix(groundC, refr, smoothstep(-0.22, 0.3, Rr.y));
  vec3 refl = lensEnv(reflect(-V, N), 0.5);
  fres = 0.03 + 0.97 * pow(1.0 - ndv, 4.0);
  // dark ring of total internal reflection just inside the silhouette, bright fresnel edge outside it
  float ring = smoothstep(0.0, 0.55, ndv);
  vec3 col = refr * mix(0.12, 0.8, ring) + refl * fres * 1.1 + uAmbientColor * 0.06;
  vec3 H = normalize(V + uSunDirW);
  float ndh = max(dot(N, H), 0.0);
  col += uKeyColor * (pow(ndh, 500.0) * 9.0 + pow(ndh, 40.0) * 0.12);
  // caustic crescent on the side away from the light, a soft window highlight from the zenith
  col += (uKeyColor + uAmbientColor) * pow(max(dot(N, normalize(-uSunDirW + vec3(0.0, -0.6, 0.0))), 0.0), 5.0) * 0.3 * vec3(0.9, 1.0, 0.85) * ring;
  col += uAmbientColor * pow(max(dot(N, normalize(V + vec3(0.0, 1.0, 0.0))), 0.0), 60.0) * 1.5;
  col += vec3(0.8, 0.88, 1.0) * uFlash * (0.25 + 1.6 * fres);
  return col;
}`;

const DROP_VERT = /* glsl */ `
attribute vec4 iPos; // xyz, radius
attribute vec4 iVel; // xyz, seed
uniform float uClock;
varying vec3 vN;
varying vec3 vW;
void main() {
  vec3 p = position;
  float sp = length(iVel.xyz);
  // falling drops: flattened underside, domed top, a breathing wobble
  float fall = smoothstep(6.0, 18.0, -iVel.y);
  p.y *= p.y < 0.0 ? 1.0 - 0.28 * fall : 1.0 + 0.08 * fall;
  p.xz *= 1.0 + 0.1 * fall;
  float wob = sin(uClock * 31.0 + iVel.w * 40.0);
  p.y *= 1.0 + 0.07 * wob;
  p.xz *= 1.0 - 0.035 * wob;
  // rebound beads stretch along their flight
  vec3 vd = sp > 0.01 ? iVel.xyz / sp : vec3(0.0, 1.0, 0.0);
  p += vd * dot(p, vd) * min(0.5, sp * 0.03) * (1.0 - fall);
  vec3 n = normalize(p * vec3(1.0, 1.0 + 0.4 * fall, 1.0));
  vW = iPos.xyz + p * iPos.w;
  vN = n;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
  if (iPos.w <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const DROP_FRAG = /* glsl */ `
uniform vec4 uCutPlane;
varying vec3 vN;
varying vec3 vW;
${LENS}
void main() {
  if (dot(uCutPlane.xyz, vW) + uCutPlane.w > 0.0) discard;
  float fres;
  vec3 col = lensShade(normalize(vN), normalize(cameraPosition - vW), fres);
  gl_FragColor = vec4(col, 1.0);
}`;

const CROWN_VERT = /* glsl */ `
attribute vec4 iPos; // xyz, birth
attribute vec4 iNrm; // normal, scale
uniform float uClock;
varying vec3 vN;
varying vec3 vW;
varying vec3 vK; // age, v, angle
void main() {
  float s = iNrm.w;
  float a = (uClock - iPos.w) / (0.34 + 0.16 * s);
  if (a < 0.0 || a >= 1.0 || s <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float ang = position.x * 6.2831853;
  float v = position.y;
  float seed = fract(iPos.w * 13.71);
  float R = s * (0.4 + 1.55 * pow(a, 0.55));
  float Hh = s * 1.5 * pow(sin(3.14159 * min(1.0, a * 1.12)), 0.8) * (1.0 - 0.35 * a);
  float fingers = pow(0.5 + 0.5 * cos(ang * 9.0 + seed * 6.283), 3.0);
  float rad = R * (1.0 + 0.55 * v * v * (0.35 + a));
  float y = v * Hh * (1.0 + 0.6 * fingers * smoothstep(0.45, 1.0, v));
  vec3 n = normalize(iNrm.xyz);
  vec3 t = normalize(abs(n.y) < 0.95 ? cross(n, vec3(0.0, 1.0, 0.0)) : vec3(1.0, 0.0, 0.0));
  vec3 b = cross(n, t);
  vec3 radial = t * cos(ang) + b * sin(ang);
  vW = iPos.xyz + radial * rad + n * (y - 0.02);
  vN = normalize(radial + n * (0.35 - 0.8 * v));
  vK = vec3(a, v, ang);
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}`;

const CROWN_FRAG = /* glsl */ `
uniform vec4 uCutPlane;
varying vec3 vN;
varying vec3 vW;
varying vec3 vK;
${LENS}
float cHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  if (dot(uCutPlane.xyz, vW) + uCutPlane.w > 0.0) discard;
  float a = vK.x;
  // the sheet tears into holes as it thins
  vec2 cell = vec2(floor(vK.z * 7.0), floor(vK.y * 5.0));
  float tear = cHash(cell) * 0.6 + 0.4 * vK.y;
  if (tear < a * 1.25 - 0.55) discard;
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  if (dot(N, V) < 0.0) N = -N;
  float fres;
  vec3 col = lensShade(N, V, fres);
  float rim = smoothstep(0.75, 1.0, vK.y);
  float alpha = (0.42 + 0.58 * fres + 0.3 * rim) * (1.0 - smoothstep(0.65, 1.0, a));
  gl_FragColor = vec4(col * (1.0 + 0.3 * rim), clamp(alpha, 0.0, 1.0));
}`;

const CRATER_VERT = /* glsl */ `
attribute vec4 iPos; // xyz, birth
attribute vec4 iNrm; // normal, radius
uniform float uClock;
varying vec2 vUv;
varying vec3 vW;
varying float vAge;
void main() {
  float age = uClock - iPos.w;
  if (age < 0.0 || age > 24.0 || iNrm.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 n = normalize(iNrm.xyz);
  vec3 t = normalize(abs(n.y) < 0.95 ? cross(n, vec3(0.0, 1.0, 0.0)) : vec3(1.0, 0.0, 0.0));
  vec3 b = cross(n, t);
  vW = iPos.xyz + (t * position.x + b * position.y) * iNrm.w + n * 0.03;
  vUv = position.xy;
  vAge = age;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}`;

const CRATER_FRAG = /* glsl */ `
uniform vec4 uCutPlane;
uniform vec3 uSunDirW;
uniform vec3 uKeyColor;
uniform vec3 uAmbientColor;
uniform float uPheroVision;
varying vec2 vUv;
varying vec3 vW;
varying float vAge;
float kHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
void main() {
  if (dot(uCutPlane.xyz, vW) + uCutPlane.w > 0.0) discard;
  float ang = atan(vUv.y, vUv.x);
  float seed = kHash(floor(vW.xz * 3.0));
  float r = length(vUv) * (1.0 + 0.07 * sin(ang * 5.0 + seed * 20.0) + 0.04 * sin(ang * 9.0 + seed * 7.0));
  float fade = smoothstep(0.0, 0.1, vAge) * (1.0 - smoothstep(10.0, 24.0, vAge));
  // wet dark bowl, a faint thrown-up rim lit from the sun side, a few ejecta streaks
  float bowl = 1.0 - smoothstep(0.2, 0.55, r);
  float wet = 1.0 - smoothstep(0.5, 0.97, r);
  float rim = smoothstep(0.42, 0.58, r) * (1.0 - smoothstep(0.6, 0.78, r));
  float rays = pow(0.5 + 0.5 * cos(ang * 11.0 + seed * 30.0), 5.0) * smoothstep(0.55, 0.7, r) * (1.0 - smoothstep(0.75, 1.0, r));
  vec2 sd = normalize(uSunDirW.xz + 1e-4);
  float lit = 0.5 + 0.5 * dot(normalize(vUv + 1e-4), -sd);
  float dark = (wet * 0.42 + bowl * 0.3 + rays * 0.22 - rim * 0.12 * lit) * fade;
  vec3 light = (uKeyColor * lit * 0.03 + uAmbientColor * 0.012) * rim * fade * (1.0 - uPheroVision);
  // glint of standing water in the fresh pit
  float glint = smoothstep(0.3, 0.0, r) * (1.0 - smoothstep(0.0, 3.0, vAge));
  light += (uAmbientColor * 0.1 + uKeyColor * 0.02) * glint;
  gl_FragColor = vec4(light, clamp(dark, 0.0, 0.85));
}`;

const RAIN_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uClock;
uniform vec3 uCamPos;
uniform vec3 uWindV;
uniform vec3 uBox;
uniform vec4 uRain;
uniform sampler2D uGroundTex;
uniform vec3 uWorldSize;
uniform float uPx;
varying vec2 vUv;
varying float vA;
varying vec3 vW;
void main() {
  float speed = 20.0 + 9.0 * aSeed.w;
  vec3 vel = vec3(uWindV.x * 1.3, -speed, uWindV.z * 1.3);
  vec3 wp = uCamPos + (fract(aSeed.xyz + (vel * uClock - uCamPos) / uBox) - 0.5) * uBox;
  float on = step(aSeed.w, uRain.x * 1.05) * step(fract(aSeed.x * 91.7), 0.999);
  // nothing falls through the ground or outside the diorama
  vec2 guv = wp.xz / uWorldSize.xz;
  float gh = textureLod(uGroundTex, clamp(guv, 0.0, 1.0), 0.0).r;
  float inside = step(0.0, guv.x) * step(guv.x, 1.0) * step(0.0, guv.y) * step(guv.y, 1.0);
  on *= step(mix(-1e3, gh, inside), wp.y);
  float dCam = length(wp - uCamPos);
  vec3 tail = wp - vel * (0.026 + 0.012 * aSeed.z) * max(1.0, dCam / 22.0);
  vec4 c0 = viewMatrix * vec4(wp, 1.0);
  vec4 c1 = viewMatrix * vec4(tail, 1.0);
  vec2 dir = c1.xy - c0.xy;
  float dl = length(dir);
  dir = dl > 1e-5 ? dir / dl : vec2(0.0, 1.0);
  vec4 c = mix(c0, c1, position.y * 0.5 + 0.5);
  float d = -c.z;
  float w = max(0.009 + 0.01 * aSeed.z, d * 1.1 / uPx);
  c.xy += vec2(-dir.y, dir.x) * position.x * w;
  gl_Position = projectionMatrix * c;
  if (on < 0.5 || d < 0.3) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vUv = position.xy;
  // thin streaks dissolve in the distance; the widened ones keep their energy
  vA = smoothstep(0.6, 3.5, d) * (1.0 - smoothstep(uBox.x * 0.32, uBox.x * 0.5, length(wp - uCamPos))) * min(1.0, (0.02 * uPx) / max(d, 1.0) + 0.25);
  vW = wp;
}`;

const RAIN_FRAG = /* glsl */ `
uniform vec4 uCutPlane;
uniform vec3 uRainColor;
varying vec2 vUv;
varying float vA;
varying vec3 vW;
void main() {
  if (dot(uCutPlane.xyz, vW) + uCutPlane.w > 0.0) discard;
  float a = (1.0 - abs(vUv.x)) * smoothstep(-1.0, 0.2, vUv.y) * (1.0 - smoothstep(0.6, 1.0, vUv.y)) * vA;
  gl_FragColor = vec4(uRainColor * a, a * 0.5);
}`;

const SPARK_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uClock;
uniform vec3 uFocusP;
uniform vec3 uBox;
uniform sampler2D uGroundTex;
uniform vec3 uWorldSize;
uniform float uPx;
uniform vec4 uSpark; // strength, frost 0..1, unused
varying float vA;
varying float vSeed;
varying vec3 vW;
void main() {
  vec2 xz = uFocusP.xz + (fract(aSeed.xz - uFocusP.xz / uBox.xz) - 0.5) * uBox.xz;
  vec2 guv = xz / uWorldSize.xz;
  float gh = textureLod(uGroundTex, clamp(guv, 0.0, 1.0), 0.0).r;
  float inside = step(0.0, guv.x) * step(guv.x, 1.0) * step(0.0, guv.y) * step(guv.y, 1.0);
  vec3 wp = vec3(xz.x, gh + 0.05 + aSeed.y * aSeed.y * 0.5, xz.y);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = -mv.z;
  // glints flash as the view direction sweeps over each facet
  vec3 vd = normalize(cameraPosition - wp);
  float facet = sin(dot(vd, vec3(aSeed.w * 37.0 + 11.0, aSeed.x * 23.0, aSeed.z * 41.0 - 17.0)) * 6.0 + aSeed.w * 80.0 + uClock * (0.6 + aSeed.y));
  float tw = pow(max(facet, 0.0), 14.0);
  float edge = 1.0 - smoothstep(uBox.x * 0.35, uBox.x * 0.5, length(xz - uFocusP.xz));
  vA = tw * edge * inside * uSpark.x * step(aSeed.w, 0.25 + 0.75 * uSpark.x);
  vSeed = aSeed.w;
  gl_PointSize = clamp(uPx * (0.03 + 0.05 * aSeed.y) / max(d, 0.1), 1.5, 14.0);
  if (vA < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vW = wp;
}`;

const SPARK_FRAG = /* glsl */ `
uniform vec4 uCutPlane;
uniform vec3 uKeyColor;
uniform vec3 uAmbientColor;
uniform vec4 uSpark;
varying float vA;
varying float vSeed;
varying vec3 vW;
void main() {
  if (dot(uCutPlane.xyz, vW) + uCutPlane.w > 0.0) discard;
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  float core = smoothstep(0.6, 0.0, r);
  float cross_ = smoothstep(0.14, 0.0, min(abs(p.x), abs(p.y))) * smoothstep(1.0, 0.0, r);
  float a = (core * core + cross_ * 0.5) * vA;
  vec3 dewC = uKeyColor * 1.6 + uAmbientColor * 2.0 + 0.05;
  vec3 frostC = (uKeyColor + uAmbientColor * 3.0 + 0.08) * vec3(0.8, 0.92, 1.15);
  // a hint of prismatic colour per glint
  vec3 prism = 0.75 + 0.25 * cos(6.283 * (vSeed * 5.0 + vec3(0.0, 0.33, 0.67)));
  gl_FragColor = vec4(mix(dewC, frostC, uSpark.y) * prism * a * 2.2, 0.0);
}`;

const FLY_VERT = /* glsl */ `
attribute vec4 aSeed;
attribute float aKind;
uniform float uClock;
uniform vec3 uFocusP;
uniform vec3 uBox;
uniform sampler2D uGroundTex;
uniform vec3 uWorldSize;
uniform float uLevel;
varying vec2 vUv;
varying vec3 vK; // brightness, kind, seed
varying vec3 vW;
void main() {
  float t = uClock;
  vec2 home = uFocusP.xz + (fract(aSeed.xz - uFocusP.xz / uBox.xz) - 0.5) * uBox.xz;
  float s = aSeed.w;
  vec3 wander = vec3(sin(t * (0.23 + 0.2 * s) + s * 40.0) + 0.5 * sin(t * 0.71 + s * 13.0), 0.5 * sin(t * (0.4 + 0.3 * s) + s * 21.0) + 0.25 * sin(t * 1.3 + s * 5.0), cos(t * (0.19 + 0.22 * s) + s * 33.0) + 0.5 * cos(t * 0.63 + s * 9.0));
  vec2 xz = home + wander.xz * 2.2;
  vec2 guv = xz / uWorldSize.xz;
  float gh = textureLod(uGroundTex, clamp(guv, 0.0, 1.0), 0.0).r;
  float inside = step(0.0, guv.x) * step(guv.x, 1.0) * step(0.0, guv.y) * step(guv.y, 1.0);
  float h = 1.2 + aSeed.y * aSeed.y * 9.0 + wander.y * 1.2;
  vec3 wp = vec3(xz.x, gh + h, xz.y);
  // courtship flashes: a slow swell, a quick double pulse, darkness in between
  float ph = fract(t * (0.16 + 0.1 * s) + s * 7.0);
  float blink = smoothstep(0.0, 0.08, ph) * (1.0 - smoothstep(0.18, 0.42, ph)) + 0.6 * smoothstep(0.5, 0.54, ph) * (1.0 - smoothstep(0.56, 0.7, ph));
  float edge = 1.0 - smoothstep(uBox.x * 0.36, uBox.x * 0.5, length(home - uFocusP.xz));
  float b = (0.06 + blink) * edge * inside * uLevel * step(s, 0.15 + 0.85 * uLevel);
  vec4 mv;
  if (aKind < 0.5) {
    mv = viewMatrix * vec4(wp, 1.0);
    mv.xy += position.xy * (0.3 + 0.5 * blink);
  } else {
    // light pool: a flat disc on the ground under the fly, wider and dimmer the higher it flies
    float rad = 1.2 + h * 0.75;
    vec3 gp = vec3(xz.x + position.x * rad, gh + 0.12, xz.y + position.y * rad);
    mv = viewMatrix * vec4(gp, 1.0);
    b *= 1.6 / (1.0 + h * h * 0.12);
    wp = gp;
  }
  gl_Position = projectionMatrix * mv;
  if (b < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vUv = position.xy;
  vK = vec3(b, aKind, s);
  vW = wp;
}`;

const FLY_FRAG = /* glsl */ `
uniform vec4 uCutPlane;
uniform float uPheroVision;
varying vec2 vUv;
varying vec3 vK;
varying vec3 vW;
void main() {
  if (dot(uCutPlane.xyz, vW) + uCutPlane.w > 0.0) discard;
  float r = length(vUv);
  vec3 tint = mix(vec3(0.62, 1.0, 0.18), vec3(1.0, 0.9, 0.25), vK.z * 0.6);
  float a;
  if (vK.y < 0.5) {
    float core = smoothstep(0.16, 0.0, r);
    float halo = smoothstep(1.0, 0.0, r);
    a = core * 5.0 + halo * halo * 0.8;
    tint = mix(tint, vec3(1.0, 1.0, 0.7), core);
  } else {
    float f = smoothstep(1.0, 0.0, r);
    a = f * f * 0.16;
  }
  a *= vK.x * (1.0 - 0.6 * uPheroVision);
  gl_FragColor = vec4(tint * a, 0.0);
}`;

const BOLT_VERT = /* glsl */ `
attribute vec3 aDir;
attribute vec2 aSide; // side ±1, width
uniform float uPx;
varying float vS;
varying float vWd;
void main() {
  vec4 mv = viewMatrix * vec4(position, 1.0);
  vec3 dv = (viewMatrix * vec4(aDir, 0.0)).xyz;
  vec2 n = normalize(vec2(-dv.y, dv.x) + 1e-5);
  float d = max(-mv.z, 0.1);
  float w = max(aSide.y, d * 1.6 / uPx);
  mv.xy += n * aSide.x * w;
  gl_Position = projectionMatrix * mv;
  vS = aSide.x;
  vWd = aSide.y;
}`;

const BOLT_FRAG = /* glsl */ `
uniform float uBolt;
varying float vS;
varying float vWd;
void main() {
  float c = 1.0 - abs(vS);
  float a = (c * c * 0.6 + smoothstep(0.55, 1.0, c) * 3.0) * uBolt * (0.35 + vWd * 1.4);
  gl_FragColor = vec4(vec3(0.72, 0.8, 1.0) * a * 6.0, 0.0);
}`;

/** Public droplet API (keeper water dropper, tests, demos). No-ops before the module is initialised. */
export const weatherDrops: {
  /** A lens droplet with a velocity; `floorY` (optional) is the height it bursts at (else raycast). */
  spawn(x: number, y: number, z: number, radius: number, vx: number, vy: number, vz: number, floorY?: number): void;
  /** Burst a droplet of `radius` right here: crown, beads, spray, crater or ripple. */
  impact(x: number, y: number, z: number, radius: number, normal?: Readonly<Vec3> | null): void;
} = { spawn() {}, impact() {} };

/** Uniforms other shaders may bind (terrain rain ripples): see `waterShared.uRain`. */
export const weatherUniforms = { uRain: waterShared.uRain };

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function createWeatherFxModule(): Module {
  const disposables: { dispose(): void }[] = [];
  const meshes: THREE.Object3D[] = [];
  // ---- drops ----
  const dPos = new Float32Array(MAX_DROPS * 4);
  const dVel = new Float32Array(MAX_DROPS * 4);
  const dFloor = new Float32Array(MAX_DROPS); // burst height, NaN = bead (no burst)
  const dKind = new Uint8Array(MAX_DROPS); // 0 free, 1 rain, 2 bead
  let dropMesh: THREE.InstancedMesh | null = null;
  let dropAttrs: THREE.InstancedBufferAttribute[] = [];
  let dropCursor = 0;
  let liveDrops = 0;
  // ---- crowns / craters ----
  const cPos = new Float32Array(MAX_CROWNS * 4).fill(-1e3);
  const cNrm = new Float32Array(MAX_CROWNS * 4);
  let crownAttrs: THREE.InstancedBufferAttribute[] = [];
  let crownCursor = 0;
  const kPos = new Float32Array(MAX_CRATERS * 4).fill(-1e3);
  const kNrm = new Float32Array(MAX_CRATERS * 4);
  let craterAttrs: THREE.InstancedBufferAttribute[] = [];
  let craterCursor = 0;
  let crownMesh: THREE.Mesh | null = null;
  let craterMesh: THREE.Mesh | null = null;
  let lastImpactAt = -1e3;
  // ---- rain / sparkle / fireflies / bolt ----
  let rainMesh: THREE.Mesh | null = null;
  let sparkMesh: THREE.Points | null = null;
  let flyMesh: THREE.Mesh | null = null;
  let boltMesh: THREE.Mesh | null = null;
  let boltPos = new Float32Array(0);
  let boltDir = new Float32Array(0);
  let boltSide = new Float32Array(0);
  let boltAt = -1e3;
  let boltPower = 0;
  let sheetAt = -1e3;
  let lastEventBolt = -1e3;
  let nextSheet = 6;
  const U = {
    uCamPos: { value: new THREE.Vector3() },
    uFocusP: { value: new THREE.Vector3() },
    uWindV: { value: new THREE.Vector3() },
    uRainBox: { value: new THREE.Vector3(44, 34, 44) },
    uSparkBox: { value: new THREE.Vector3(40, 1, 40) },
    uFlyBox: { value: new THREE.Vector3(60, 1, 60) },
    uPx: { value: 500 },
    uRainColor: { value: new THREE.Color(0.6, 0.65, 0.7) },
    uSpark: { value: new THREE.Vector4(0, 0, 0, 0) },
    uFlyLevel: { value: 0 },
    uBolt: { value: 0 },
    uFlash: { value: 0 },
    uHasCube: { value: 0 },
  };
  // ---- levels ----
  const L = { rain: 0, storm: 0, wind: 0, heat: 0, frost: 0, fog: 0, fly: 0, wet: 0, wx: 0, wz: 0 };
  let first = true;
  let seed = 24680;
  const rand = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 8) / 16777216;
  };
  let dropAcc = 0;
  let debrisAcc = 0;
  let mistAcc = 0;
  let dripAcc = 0;
  let ctxRef: RenderContext | null = null;
  let envRef: EnvState | null = null;
  const rayO = { x: 0, y: 0, z: 0 };
  const rayD = { x: 0, y: -1, z: 0 };
  const tmpP = { x: 0, y: 0, z: 0 };
  const tmpN = { x: 0, y: 1, z: 0 };
  const WATER_COL: readonly [number, number, number] = [0.75, 0.85, 0.95];

  function spawnDrop(kind: 1 | 2, x: number, y: number, z: number, r: number, vx: number, vy: number, vz: number, floorY: number): void {
    // beads never evict rain drops that are still falling
    let j = -1;
    for (let k = 0; k < MAX_DROPS; k++) {
      const c = (dropCursor + k) % MAX_DROPS;
      if (dKind[c] === 0) {
        j = c;
        break;
      }
    }
    if (j < 0) {
      if (kind === 2) return;
      j = dropCursor;
    }
    dropCursor = (j + 1) % MAX_DROPS;
    dPos[j * 4] = x;
    dPos[j * 4 + 1] = y;
    dPos[j * 4 + 2] = z;
    dPos[j * 4 + 3] = r;
    dVel[j * 4] = vx;
    dVel[j * 4 + 1] = vy;
    dVel[j * 4 + 2] = vz;
    dVel[j * 4 + 3] = rand();
    dFloor[j] = floorY;
    dKind[j] = kind;
  }

  function impact(x: number, y: number, z: number, r: number, normal: Readonly<Vec3> | null): void {
    const ctx = ctxRef;
    if (!ctx) return;
    const clock = fx.clock;
    const waterY = waterShared.surfaceAt(x, z);
    const onWater = waterY > y - 0.35;
    if (onWater) y = Math.max(y, waterY);
    let nx = 0;
    let ny = 1;
    let nz = 0;
    if (normal && !onWater) {
      const l = Math.hypot(normal.x, normal.y, normal.z) || 1;
      nx = normal.x / l;
      ny = normal.y / l;
      nz = normal.z / l;
    }
    // crown
    let j = crownCursor;
    crownCursor = (crownCursor + 1) % MAX_CROWNS;
    cPos[j * 4] = x;
    cPos[j * 4 + 1] = y;
    cPos[j * 4 + 2] = z;
    cPos[j * 4 + 3] = clock;
    cNrm[j * 4] = nx;
    cNrm[j * 4 + 1] = ny;
    cNrm[j * 4 + 2] = nz;
    cNrm[j * 4 + 3] = r * 1.25;
    for (const a of crownAttrs) a.needsUpdate = true;
    if (onWater) addRipple(x, z, clock, Math.min(1.6, 0.7 + r));
    else {
      j = craterCursor;
      craterCursor = (craterCursor + 1) % MAX_CRATERS;
      kPos[j * 4] = x;
      kPos[j * 4 + 1] = y;
      kPos[j * 4 + 2] = z;
      kPos[j * 4 + 3] = clock;
      kNrm[j * 4] = nx;
      kNrm[j * 4 + 1] = ny;
      kNrm[j * 4 + 2] = nz;
      kNrm[j * 4 + 3] = r * (2.4 + 0.8 * rand());
      for (const a of craterAttrs) a.needsUpdate = true;
    }
    // rebound beads: a ring thrown out from the rim + the central jet
    const beads = ctx.quality.preset === 'low' ? 3 : 7 + Math.floor(rand() * 4);
    const a0 = rand() * 6.283;
    for (let i = 0; i < beads; i++) {
      const a = a0 + (i / beads) * 6.283 + rand() * 0.5;
      const out = (2.2 + 2.6 * rand()) * Math.sqrt(r * 2);
      const up = (3.5 + 3.5 * rand()) * Math.sqrt(r * 2);
      spawnDrop(2, x + Math.cos(a) * r * 0.7, y + 0.05, z + Math.sin(a) * r * 0.7, r * (0.1 + 0.16 * rand()), Math.cos(a) * out + nx * up, ny * up, Math.sin(a) * out + nz * up, NaN);
    }
    spawnDrop(2, x, y + 0.05, z, r * 0.3, nx * 2, 5.5 * Math.sqrt(r * 2), nz * 2, NaN);
    // spray + mist
    tmpP.x = x;
    tmpP.y = y + 0.05;
    tmpP.z = z;
    tmpN.x = nx;
    tmpN.y = ny;
    tmpN.z = nz;
    particles.emitCustom('splash', tmpP, tmpN, { count: 9, speed: Math.sqrt(r * 2), radius: r * 0.5, size: 0.7 + r });
    particles.emitCustom('splashMist', tmpP, tmpN, { count: 2, size: 0.6 + r * 1.4 });
    lastImpactAt = clock;
  }

  function strike(x: number, y: number, z: number, power: number): void {
    // midpoint-displaced main channel from the cloud base to the ground, plus a few branches
    const top = y + 150;
    let n = 0;
    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number): void => {
      if (n >= BOLT_SEGS) return;
      const dx = bx - ax;
      const dy = by - ay;
      const dz = bz - az;
      for (let v = 0; v < 4; v++) {
        const k = (n * 4 + v) * 3;
        const end = v >= 2;
        boltPos[k] = end ? bx : ax;
        boltPos[k + 1] = end ? by : ay;
        boltPos[k + 2] = end ? bz : az;
        boltDir[k] = dx;
        boltDir[k + 1] = dy;
        boltDir[k + 2] = dz;
        boltSide[(n * 4 + v) * 2] = v % 2 === 0 ? -1 : 1;
        boltSide[(n * 4 + v) * 2 + 1] = w;
      }
      n++;
    };
    const path = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, steps: number, jit: number, w: number, branch: number): void => {
      let px = ax;
      let py = ay;
      let pz = az;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const j = i === steps ? 0 : jit;
        const qx = ax + (bx - ax) * t + (rand() - 0.5) * j;
        const qy = ay + (by - ay) * t + (rand() - 0.5) * j * 0.4;
        const qz = az + (bz - az) * t + (rand() - 0.5) * j;
        seg(px, py, pz, qx, qy, qz, w * (1 - 0.35 * t));
        if (branch > 0 && rand() < 0.16 && i < steps - 2) {
          const len = (20 + 40 * rand()) * (1 - t * 0.5);
          const a = rand() * 6.283;
          path(qx, qy, qz, qx + Math.cos(a) * len * 0.8, qy - len * (0.4 + 0.6 * rand()), qz + Math.sin(a) * len * 0.8, 7, jit * 0.7, w * 0.4, branch - 1);
        }
        px = qx;
        py = qy;
        pz = qz;
      }
    };
    path(x + (rand() - 0.5) * 60, top, z + (rand() - 0.5) * 60, x, y, z, 30, 9, 0.5, 2);
    // collapse unused segments
    for (let k = n * 12; k < BOLT_SEGS * 12; k++) boltPos[k] = 0;
    for (let k = n * 8; k < BOLT_SEGS * 8; k++) boltSide[k] = 0;
    if (boltMesh) {
      const g = boltMesh.geometry;
      (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (g.getAttribute('aDir') as THREE.BufferAttribute).needsUpdate = true;
      (g.getAttribute('aSide') as THREE.BufferAttribute).needsUpdate = true;
      g.setDrawRange(0, n * 6);
    }
    boltAt = fx.clock;
    boltPower = power;
    tmpP.x = x;
    tmpP.y = y + 0.2;
    tmpP.z = z;
    particles.emit('spark', tmpP, null, { count: 30, speed: 2.4, size: 2.5, color: [0.8, 0.9, 1.0], life: 1.6 });
    particles.emit('dust', tmpP, null, { count: 12, size: 3, radius: 1.5 });
  }

  /** Flash envelope of a bolt: leader, dip, bright restrike, afterglow. */
  const flashEnv = (age: number): number => {
    if (age < 0 || age > 0.9) return 0;
    const a = Math.exp(-age * 22);
    const b = age > 0.13 ? Math.exp(-(age - 0.13) * 9) : 0;
    const c = age > 0.34 ? 0.45 * Math.exp(-(age - 0.34) * 7) : 0;
    return Math.min(1, Math.max(a, b, c));
  };

  return {
    id: 'weatherFx',
    init(ctx) {
      ctxRef = ctx;
      const env = (envRef = getEnv(ctx));
      const q = ctx.quality;
      const low = q.preset === 'low';
      const cutU = ctx.uniforms.uCutPlane;
      first = true;
      seed = 24680 + (ctx.sim.options.seed | 0);
      dKind.fill(0);
      dPos.fill(0);
      cPos.fill(-1e3);
      kPos.fill(-1e3);
      boltAt = sheetAt = lastEventBolt = lastImpactAt = -1e3;
      L.rain = L.storm = L.wind = L.heat = L.frost = L.fog = L.fly = L.wet = 0;

      // particle kinds owned by the weather
      particles.registerKind('splash', { count: 9, color: WATER_COL, size: 0.05, sizeVar: 0.6, speed: 4.2, speedVar: 0.6, life: 0.55, lifeVar: 0.4, gravity: 13, drag: 0.5, spread: 0.75, radius: 0.1, additive: 0.35, shape: 2, grow: 0.6, opacity: 0.9, lit: 0.7 });
      particles.registerKind('splashMist', { count: 2, color: [0.8, 0.86, 0.92], size: 0.5, sizeVar: 0.4, speed: 0.7, life: 0.9, lifeVar: 0.3, gravity: -0.2, drag: 2.5, spread: 0.9, radius: 0.15, additive: 0, shape: 0, grow: 2.6, opacity: 0.08, lit: 1 });
      particles.registerKind('drip', { count: 1, color: WATER_COL, size: 0.045, sizeVar: 0.3, speed: 0.4, speedVar: 0.5, life: 0.9, lifeVar: 0.2, gravity: 16, drag: 0.1, spread: 0.05, radius: 0.01, additive: 0.4, shape: 2, grow: 1, opacity: 1, lit: 0.8 });
      particles.registerKind('mist', { count: 1, color: [0.82, 0.86, 0.9], size: 5.5, sizeVar: 0.4, speed: 0.25, speedVar: 0.6, life: 11, lifeVar: 0.3, gravity: -0.01, drag: 0.25, spread: 1.6, radius: 2.5, additive: 0, shape: 0, grow: 1.7, opacity: 0.085, lit: 1 });
      particles.registerKind('leafDebris', { count: 1, color: [0.5, 0.42, 0.14], size: 0.85, sizeVar: 0.6, speed: 1, speedVar: 0.4, life: 4.5, lifeVar: 0.4, gravity: 0.22, drag: 0.12, spread: 0.35, radius: 0.5, additive: 0, shape: 4 as unknown as 1 /* leaf (particles.ts shape 4) */, grow: 1, opacity: 1, lit: 1 });
      particles.registerKind('seedFluff', { count: 1, color: [1, 0.98, 0.92], size: 0.3, sizeVar: 0.4, speed: 1, speedVar: 0.4, life: 6, lifeVar: 0.3, gravity: 0.12, drag: 0.1, spread: 0.3, radius: 0.5, additive: 0.5, shape: 3, grow: 1, opacity: 0.8, lit: 0.9 });
      particles.registerKind('windDust', { count: 1, color: [0.72, 0.62, 0.46], size: 1.6, sizeVar: 0.5, speed: 1, speedVar: 0.4, life: 2.6, lifeVar: 0.3, gravity: -0.1, drag: 0.15, spread: 0.3, radius: 1, additive: 0, shape: 0, grow: 2.2, opacity: 0.1, lit: 1 });

      const lens = {
        uEnvCube: env.uniforms.uEnvCube,
        uHasCube: U.uHasCube,
        uSkyA: { value: env.horizon },
        uSkyB: { value: env.zenith },
        uSunDirW: ctx.uniforms.uSunDir,
        uKeyColor: env.uniforms.uKeyColor,
        uAmbientColor: env.uniforms.uAmbientColor,
        uFlash: U.uFlash,
        uCutPlane: cutU,
        uClock: fx.uClock,
      };
      const inst = (g: THREE.BufferGeometry, name: string, arr: Float32Array, size: number): THREE.InstancedBufferAttribute => {
        const a = new THREE.InstancedBufferAttribute(arr, size);
        a.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute(name, a);
        return a;
      };
      const far = new THREE.Sphere(new THREE.Vector3(), 1e6);
      const add = (m: THREE.Object3D, order: number): void => {
        m.frustumCulled = false;
        m.renderOrder = order;
        ctx.scene.add(m);
        meshes.push(m);
      };

      // ---- giant droplets ----
      {
        const g = new THREE.SphereGeometry(1, low ? 10 : 20, low ? 7 : 14);
        g.deleteAttribute('uv');
        dropAttrs = [inst(g, 'iPos', dPos, 4), inst(g, 'iVel', dVel, 4)];
        const m = new THREE.ShaderMaterial({ vertexShader: DROP_VERT, fragmentShader: DROP_FRAG, uniforms: lens });
        dropMesh = new THREE.InstancedMesh(g, m, MAX_DROPS);
        dropMesh.name = 'weather:drops';
        dropMesh.count = 0;
        dropMesh.visible = false;
        add(dropMesh, 0);
        disposables.push(g, m);
      }
      // ---- splash crowns ----
      {
        const SEG = low ? 18 : 36;
        const ROWS = 6;
        const pos: number[] = [];
        const idx: number[] = [];
        for (let j = 0; j <= ROWS; j++) for (let i = 0; i <= SEG; i++) pos.push(i / SEG, j / ROWS, 0);
        for (let j = 0; j < ROWS; j++)
          for (let i = 0; i < SEG; i++) {
            const a = j * (SEG + 1) + i;
            idx.push(a, a + 1, a + SEG + 2, a, a + SEG + 2, a + SEG + 1);
          }
        const g = new THREE.InstancedBufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setIndex(idx);
        g.instanceCount = MAX_CROWNS;
        g.boundingSphere = far;
        crownAttrs = [inst(g, 'iPos', cPos, 4), inst(g, 'iNrm', cNrm, 4)];
        const m = new THREE.ShaderMaterial({ vertexShader: CROWN_VERT, fragmentShader: CROWN_FRAG, uniforms: lens, transparent: true, depthWrite: false, side: THREE.DoubleSide });
        crownMesh = new THREE.Mesh(g, m);
        crownMesh.name = 'weather:crowns';
        crownMesh.visible = false;
        add(crownMesh, 7);
        disposables.push(g, m);
      }
      // ---- impact craters ----
      {
        const g = new THREE.InstancedBufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
        g.setIndex([0, 1, 2, 0, 2, 3]);
        g.instanceCount = MAX_CRATERS;
        g.boundingSphere = far;
        craterAttrs = [inst(g, 'iPos', kPos, 4), inst(g, 'iNrm', kNrm, 4)];
        const m = new THREE.ShaderMaterial({
          vertexShader: CRATER_VERT,
          fragmentShader: CRATER_FRAG,
          uniforms: { uClock: fx.uClock, uCutPlane: cutU, uSunDirW: ctx.uniforms.uSunDir, uKeyColor: env.uniforms.uKeyColor, uAmbientColor: env.uniforms.uAmbientColor, uPheroVision: ctx.uniforms.uPheroVision },
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
          blending: THREE.CustomBlending,
          blendEquation: THREE.AddEquation,
          blendSrc: THREE.OneFactor,
          blendDst: THREE.OneMinusSrcAlphaFactor,
        });
        craterMesh = new THREE.Mesh(g, m);
        craterMesh.name = 'weather:craters';
        craterMesh.visible = false;
        add(craterMesh, 1);
        disposables.push(g, m);
      }
      // ---- rain streaks (outdoor only from here: indoor farms have no weather, the keeper is their weather) ----
      if (!env.room) {
        const n = Math.round((low ? 900 : 3600) * Math.min(1.4, Math.max(0.5, q.decoration)));
        const seeds = new Float32Array(n * 4);
        let s = 13579;
        for (let i = 0; i < seeds.length; i++) {
          s = (Math.imul(s, 1664525) + 1013904223) | 0;
          seeds[i] = (s >>> 8) / 16777216;
        }
        const g = new THREE.InstancedBufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
        g.setIndex([0, 1, 2, 0, 2, 3]);
        g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
        g.instanceCount = n;
        g.boundingSphere = far;
        const m = new THREE.ShaderMaterial({
          vertexShader: RAIN_VERT,
          fragmentShader: RAIN_FRAG,
          uniforms: { uClock: fx.uClock, uCamPos: U.uCamPos, uWindV: U.uWindV, uBox: U.uRainBox, uRain: waterShared.uRain, uGroundTex: env.uniforms.uGroundTex, uWorldSize: env.uniforms.uWorldSize, uPx: U.uPx, uCutPlane: cutU, uRainColor: U.uRainColor },
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.CustomBlending,
          blendEquation: THREE.AddEquation,
          blendSrc: THREE.OneFactor,
          blendDst: THREE.OneMinusSrcAlphaFactor,
        });
        rainMesh = new THREE.Mesh(g, m);
        rainMesh.name = 'weather:rain';
        rainMesh.visible = false;
        add(rainMesh, 8);
        disposables.push(g, m);
      }
      // ---- frost / dew sparkle ----
      if (!low && !env.room) {
        const n = Math.round(2200 * Math.min(1.4, q.decoration));
        const seeds = new Float32Array(n * 4);
        let s = 97531;
        for (let i = 0; i < seeds.length; i++) {
          s = (Math.imul(s, 1664525) + 1013904223) | 0;
          seeds[i] = (s >>> 8) / 16777216;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
        g.boundingSphere = far;
        const m = new THREE.ShaderMaterial({
          vertexShader: SPARK_VERT,
          fragmentShader: SPARK_FRAG,
          uniforms: { uClock: fx.uClock, uFocusP: U.uFocusP, uBox: U.uSparkBox, uGroundTex: env.uniforms.uGroundTex, uWorldSize: env.uniforms.uWorldSize, uPx: U.uPx, uSpark: U.uSpark, uCutPlane: cutU, uKeyColor: env.uniforms.uKeyColor, uAmbientColor: env.uniforms.uAmbientColor },
          transparent: true,
          depthWrite: false,
          blending: THREE.CustomBlending,
          blendEquation: THREE.AddEquation,
          blendSrc: THREE.OneFactor,
          blendDst: THREE.OneFactor,
        });
        sparkMesh = new THREE.Points(g, m);
        sparkMesh.name = 'weather:sparkle';
        sparkMesh.visible = false;
        add(sparkMesh, 5);
        disposables.push(g, m);
      }
      // ---- fireflies (billboard + ground light pool per fly) ----
      if (!env.room) {
        const n = Math.round((low ? 28 : 110) * Math.min(1.3, Math.max(0.5, q.decoration)));
        const seeds = new Float32Array(n * 2 * 4);
        const kinds = new Float32Array(n * 2);
        let s = 424242;
        for (let i = 0; i < n; i++) {
          for (let k = 0; k < 4; k++) {
            s = (Math.imul(s, 1664525) + 1013904223) | 0;
            seeds[i * 8 + k] = seeds[i * 8 + 4 + k] = (s >>> 8) / 16777216;
          }
          kinds[i * 2] = 1; // pools first so the flies draw over them
          kinds[i * 2 + 1] = 0;
        }
        // order: all pools, then all flies
        const seeds2 = new Float32Array(seeds.length);
        const kinds2 = new Float32Array(kinds.length);
        for (let i = 0; i < n; i++) {
          seeds2.set(seeds.subarray(i * 8, i * 8 + 4), i * 4);
          seeds2.set(seeds.subarray(i * 8, i * 8 + 4), (n + i) * 4);
          kinds2[i] = 1;
          kinds2[n + i] = 0;
        }
        const g = new THREE.InstancedBufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
        g.setIndex([0, 1, 2, 0, 2, 3]);
        g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds2, 4));
        g.setAttribute('aKind', new THREE.InstancedBufferAttribute(kinds2, 1));
        g.instanceCount = low ? n : n * 2;
        if (low) {
          // low: flies only (second half of the buffers)
          g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds2.subarray(n * 4), 4));
          g.setAttribute('aKind', new THREE.InstancedBufferAttribute(kinds2.subarray(n), 1));
        }
        g.boundingSphere = far;
        const m = new THREE.ShaderMaterial({
          vertexShader: FLY_VERT,
          fragmentShader: FLY_FRAG,
          uniforms: { uClock: fx.uClock, uFocusP: U.uFocusP, uBox: U.uFlyBox, uGroundTex: env.uniforms.uGroundTex, uWorldSize: env.uniforms.uWorldSize, uLevel: U.uFlyLevel, uCutPlane: cutU, uPheroVision: ctx.uniforms.uPheroVision },
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.CustomBlending,
          blendEquation: THREE.AddEquation,
          blendSrc: THREE.OneFactor,
          blendDst: THREE.OneFactor,
        });
        flyMesh = new THREE.Mesh(g, m);
        flyMesh.name = 'weather:fireflies';
        flyMesh.visible = false;
        add(flyMesh, 6);
        disposables.push(g, m);
      }
      // ---- lightning bolt ----
      if (!env.room) {
        boltPos = new Float32Array(BOLT_SEGS * 4 * 3);
        boltDir = new Float32Array(BOLT_SEGS * 4 * 3);
        boltSide = new Float32Array(BOLT_SEGS * 4 * 2);
        const idx = new Uint16Array(BOLT_SEGS * 6);
        for (let i = 0; i < BOLT_SEGS; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6);
        const g = new THREE.BufferGeometry();
        const dyn = (arr: Float32Array, size: number): THREE.BufferAttribute => {
          const a = new THREE.BufferAttribute(arr, size);
          a.setUsage(THREE.DynamicDrawUsage);
          return a;
        };
        g.setAttribute('position', dyn(boltPos, 3));
        g.setAttribute('aDir', dyn(boltDir, 3));
        g.setAttribute('aSide', dyn(boltSide, 2));
        g.setIndex(new THREE.BufferAttribute(idx, 1));
        g.setDrawRange(0, 0);
        g.boundingSphere = far;
        const m = new THREE.ShaderMaterial({
          vertexShader: BOLT_VERT,
          fragmentShader: BOLT_FRAG,
          uniforms: { uPx: U.uPx, uBolt: U.uBolt },
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.CustomBlending,
          blendEquation: THREE.AddEquation,
          blendSrc: THREE.OneFactor,
          blendDst: THREE.OneFactor,
        });
        boltMesh = new THREE.Mesh(g, m);
        boltMesh.name = 'weather:bolt';
        boltMesh.visible = false;
        add(boltMesh, 9);
        disposables.push(g, m);
      }

      weatherDrops.spawn = (x, y, z, r, vx, vy, vz, floorY) => spawnDrop(1, x, y, z, r, vx, vy, vz, floorY ?? -Infinity);
      weatherDrops.impact = (x, y, z, r, normal) => impact(x, y, z, r, normal ?? null);
    },

    update(ctx: RenderContext, frame: FrameInfo) {
      const env = envRef;
      if (!env) return;
      const sim = ctx.sim;
      const w = sim.weather;
      const view = ctx.view;
      const cam = view.camera;
      const clock = fx.clock;
      const dA = fx.dAnim;
      const snap = first || ctx.sync || frame.frozen;
      first = false;
      const outdoor = !env.room;

      // ---- target levels from the sim's weather ----
      const kind = w.kind;
      const inten = Math.min(1, Math.max(0, w.intensity));
      // B2's smoothed levels when its weather system is running, else derived from kind / intensity
      const wex = weatherEx(w);
      const ph = wex.phase;
      let tRain = typeof wex.rain === 'number' ? wex.rain : kind === 'rain' ? 0.3 + 0.7 * inten : kind === 'storm' ? 0.75 + 0.25 * inten : 0;
      let tStorm = ph === 'storm' || ph === 'cloudburst' || kind === 'storm' ? (0.5 + 0.5 * inten) * Math.min(1, 0.4 + tRain) : 0;
      const windLen = Math.hypot(w.wind.x, w.wind.z);
      let tWind = Math.max(windLen, kind === 'wind' ? 2 + 3 * inten : 0, tStorm * 3.5);
      let tHeat = Math.max(kind === 'heat' ? 0.5 + 0.5 * inten : 0, smooth(31, 40, w.temperature)) * env.day * (1 - tRain);
      const cold = Math.max(kind === 'cold' ? 0.4 + 0.6 * inten : 0, smooth(5, -2, w.temperature));
      let tFrost = cold * Math.max(env.night, env.golden, 0.25) * (1 - tRain);
      let tFog = Math.max(env.dew * 0.55, cold * 0.45 * (1 - env.day * 0.6), w.wetness * (1 - tRain) * 0.45 * (1 - 0.5 * env.day)) * (1 - 0.5 * Math.min(1, windLen / 4));
      let tFly = env.night * (1 - tRain) * (1 - cold) * (sim.mapId === 'desert' ? 0.3 : 1) * (1 - 0.6 * Math.min(1, windLen / 5));
      if (typeof wex.fog === 'number') tFog = Math.max(tFog * 0.6, wex.fog);
      if (!outdoor) tRain = tStorm = tWind = tHeat = tFrost = tFog = tFly = 0;
      else {
        if (fxDemo('rain')) tRain = Math.max(tRain, 0.8);
        if (fxDemo('storm')) {
          tRain = 1;
          tStorm = 1;
          tWind = Math.max(tWind, 4);
        }
        if (fxDemo('fog')) tFog = 1;
        if (fxDemo('heat')) tHeat = 1;
        if (fxDemo('frost')) tFrost = 1;
        if (fxDemo('fireflies')) tFly = 1;
        if (fxDemo('wind')) tWind = Math.max(tWind, 4);
      }
      const k = snap ? 1 : Math.min(1, Math.max(frame.dt, dA) * 0.7);
      L.rain += (tRain - L.rain) * k;
      L.storm += (tStorm - L.storm) * k;
      L.wind += (tWind - L.wind) * k;
      L.heat += (tHeat - L.heat) * k;
      L.frost += (tFrost - L.frost) * k;
      L.fog += (tFog - L.fog) * k;
      L.fly += (tFly - L.fly) * k;
      L.wet += (env.wetness - L.wet) * k;
      // wind vector: the sim's, or a default heading when only a strength is known
      let wx = w.wind.x;
      let wz = w.wind.z;
      if (windLen < 0.05) {
        wx = 0.85;
        wz = 0.5;
      } else {
        wx /= windLen;
        wz /= windLen;
      }
      L.wx += (wx * L.wind - L.wx) * k;
      L.wz += (wz * L.wind - L.wz) * k;
      waterShared.uRain.value.set(L.rain, L.storm, L.wet, L.wind);

      // ---- shared screen levels ----
      fx.dim = Math.min(1, 0.55 * L.storm + 0.14 * L.rain);
      // (A3's postlook already thickens the depth fog with wetness and cloud cover — far too much for a
      // readable rain scene at ant scale, so rain pulls it back and only real fog banks add to it)
      fx.fog = 3.2 * L.fog - 0.62 * Math.min(1, Math.max(L.rain, L.wet * 0.9)) * (1 - L.fog);
      const gFocus = env.ground.heightAt(cam.focus.x, cam.focus.z);
      const camAbove = cam.pos.y - env.ground.heightAt(cam.pos.x, cam.pos.z);
      fx.shimmer = outdoor && !view.cut.enabled && camAbove > 0.2 ? L.heat * (sim.mapId === 'desert' ? 1 : 0.55) * (1 - ctx.uniforms.uPheroVision.value) : 0;
      fx.shimmerY = gFocus;

      U.uCamPos.value.set(cam.pos.x, cam.pos.y, cam.pos.z);
      U.uFocusP.value.set(cam.focus.x, cam.focus.y, cam.focus.z);
      U.uWindV.value.set(L.wx, 0, L.wz);
      U.uPx.value = ctx.renderer.domElement.height / (2 * Math.tan((cam.fov * Math.PI) / 360));
      U.uHasCube.value = env.uniforms.uEnvCube.value ? 1 : 0;
      const low = ctx.quality.preset === 'low';

      // ---- events ----
      const events = frame.events;
      let impacts = 0;
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.type === 'rainImpact') {
          if (impacts++ < 6) {
            rayO.x = e.pos.x;
            rayO.y = e.pos.y + 0.5;
            rayO.z = e.pos.z;
            sim.world.gradient(e.pos.x, e.pos.y, e.pos.z, tmpN);
            const l = Math.hypot(tmpN.x, tmpN.y, tmpN.z);
            const nrm = l > 0.05 ? { x: -tmpN.x / l, y: -tmpN.y / l, z: -tmpN.z / l } : null;
            impact(e.pos.x, e.pos.y, e.pos.z, Math.min(1.2, Math.max(0.25, e.radius * 0.45)), nrm);
          }
        } else if (e.type === 'lightning' && boltMesh) {
          strike(e.pos.x, e.pos.y, e.pos.z, 1);
          lastEventBolt = clock;
        }
      }
      if (boltMesh && fxDemo('lightning') && dA > 0 && Math.floor(clock / 3) !== Math.floor((clock - dA) / 3)) strike(cam.focus.x + (rand() - 0.5) * 50, gFocus, cam.focus.z - 30 - rand() * 40, 1);
      // sheet lightning while the sim stays quiet in a storm
      if (L.storm > 0.5 && dA > 0 && clock - lastEventBolt > 14) {
        nextSheet -= dA;
        if (nextSheet <= 0) {
          nextSheet = 5 + rand() * 9;
          sheetAt = clock;
        }
      }
      const boltEnv = flashEnv(clock - boltAt) * boltPower;
      const sheetEnv = flashEnv(clock - sheetAt) * 0.4 * L.storm;
      fx.flash = Math.min(1, Math.max(boltEnv, sheetEnv));
      U.uFlash.value = fx.flash;
      U.uBolt.value = boltEnv;
      if (boltMesh) boltMesh.visible = boltEnv > 0.004;

      // ---- rain streaks ----
      if (rainMesh) {
        rainMesh.visible = L.rain > 0.01;
        const far = view.mode === 'possess' ? 30 : Math.min(84, Math.max(36, cam.focusDist * 1.3));
        U.uRainBox.value.set(far, Math.max(26, far * 0.7), far);
        const b = 0.35 + 0.65 * env.day + 2.5 * fx.flash;
        U.uRainColor.value.setRGB(0.7 * b, 0.76 * b, 0.86 * b);
      }

      // ---- giant droplets: spawn around the point of interest ----
      if (dA > 0 && L.rain > 0.02 && view.mode !== 'slab') {
        const R = view.mode === 'possess' ? 7 : Math.min(18, Math.max(5, cam.focusDist * 0.42));
        const rate = L.rain * (low ? 5 : 16) * (0.6 + 0.4 * L.storm + 0.4) * fxKnob('dropRate', 1) * Math.min(2.2, 0.6 + (R * R) / 110);
        dropAcc += rate * Math.min(dA, 0.5);
        let guard = 24;
        while (dropAcc >= 1 && guard-- > 0) {
          dropAcc -= 1;
          const a = rand() * 6.283;
          const d = Math.sqrt(rand()) * R;
          const x = cam.focus.x + Math.cos(a) * d;
          const z = cam.focus.z + Math.sin(a) * d;
          if (x < 1 || z < 1 || x > sim.world.sx - 1 || z > sim.world.sz - 1) continue;
          const speed = 24 + 6 * rand();
          const fallT = 0.35 + 0.5 * rand();
          const gy = env.ground.heightAt(x, z);
          const r = 0.2 + 0.3 * rand() * rand() + 0.12 * L.storm;
          // start upwind so the slanted fall lands on the chosen spot
          spawnDrop(1, x - L.wx * 1.3 * fallT, gy + 2 + speed * fallT, z - L.wz * 1.3 * fallT, r, L.wx * 1.3, -speed, L.wz * 1.3, -Infinity);
        }
      } else dropAcc = 0;

      // ---- droplet simulation (sub-stepped at 60 Hz so fast drops never tunnel) ----
      if (dA > 0) {
        const steps = Math.min(40, Math.max(1, Math.ceil(dA * 60)));
        const h = dA / steps;
        const world = sim.world;
        for (let j = 0; j < MAX_DROPS; j++) {
          const kd = dKind[j];
          if (kd === 0) continue;
          const o = j * 4;
          for (let s = 0; s < steps; s++) {
            if (kd === 2) dVel[o + 1] -= 22 * h;
            dPos[o] += dVel[o] * h;
            dPos[o + 1] += dVel[o + 1] * h;
            dPos[o + 2] += dVel[o + 2] * h;
            const x = dPos[o];
            const y = dPos[o + 1];
            const z = dPos[o + 2];
            const r = dPos[o + 3];
            if (kd === 2) {
              // bead: dies on the first solid / water it meets on the way down
              if (dVel[o + 1] < 0 && (world.sample(x, y, z) > -0.1 || y < waterShared.surfaceAt(x, z))) {
                if (y < waterShared.surfaceAt(x, z) + 0.2 && r > 0.05) addRipple(x, z, clock, 0.25);
                dKind[j] = 0;
                dPos[o + 3] = 0;
                break;
              }
              if (y < -5) {
                dKind[j] = 0;
                dPos[o + 3] = 0;
                break;
              }
              continue;
            }
            const floor = dFloor[j];
            const wy = waterShared.surfaceAt(x, z);
            let hit = false;
            if (floor > -1e8) hit = y - r * 0.5 <= floor;
            else hit = y - r * 0.5 <= wy || (y < world.sy + 1 && world.sample(x, y - r * 0.5, z) > 0);
            if (hit) {
              // refine the contact with a short ray back along the fall
              let hy = floor > -1e8 ? floor : y - r * 0.5;
              let nrm: Readonly<Vec3> | null = null;
              if (!(floor > -1e8) && !(y - r * 0.5 <= wy)) {
                rayO.x = x;
                rayO.y = y + 1.6;
                rayO.z = z;
                const rh = world.raycast(rayO, rayD, 4);
                if (rh) {
                  hy = rh.pos.y;
                  nrm = rh.normal;
                }
              }
              dKind[j] = 0;
              dPos[o + 3] = 0;
              impact(x, hy, z, r, nrm);
              break;
            }
            if (y < -5) {
              dKind[j] = 0;
              dPos[o + 3] = 0;
              break;
            }
          }
        }
      }
      liveDrops = 0;
      for (let j = 0; j < MAX_DROPS; j++) if (dKind[j] !== 0) liveDrops = j + 1;
      if (dropMesh) {
        dropMesh.count = liveDrops;
        dropMesh.visible = liveDrops > 0;
        if (liveDrops > 0 || dA > 0)
          for (const a of dropAttrs) {
            a.clearUpdateRanges();
            a.addUpdateRange(0, Math.max(4, liveDrops * 4));
            a.needsUpdate = true;
          }
      }
      if (crownMesh) crownMesh.visible = clock - lastImpactAt < 1.2;
      if (craterMesh) craterMesh.visible = clock - lastImpactAt < 26;

      // ---- wind-borne debris ----
      if (dA > 0 && L.wind > 1.4) {
        debrisAcc += (L.wind - 1.2) * (low ? 5 : 26) * Math.min(dA, 0.5);
        const R = view.mode === 'possess' ? 9 : Math.min(30, Math.max(7, cam.focusDist * 0.5));
        let guard = 24;
        while (debrisAcc >= 1 && guard-- > 0) {
          debrisAcc -= 1;
          // enter upwind of the focus, cross the view
          const side = (rand() - 0.5) * 2 * R;
          const back = R * (-0.5 + 1.5 * rand());
          const wl = Math.max(0.01, Math.hypot(L.wx, L.wz));
          const ux = L.wx / wl;
          const uz = L.wz / wl;
          tmpP.x = cam.focus.x - ux * back - uz * side;
          tmpP.z = cam.focus.z - uz * back + ux * side;
          tmpP.y = env.ground.heightAt(tmpP.x, tmpP.z) + 0.3 + rand() * rand() * 4.5;
          tmpN.x = L.wx;
          tmpN.y = 0.6 + rand() * 1.2;
          tmpN.z = L.wz;
          const pick = rand();
          const sp = L.wind * (0.9 + 0.8 * rand());
          if (pick < 0.5) {
            const dry = rand();
            particles.emitCustom('leafDebris', tmpP, tmpN, { speed: sp, color: sim.mapId === 'desert' ? [0.6, 0.5, 0.3] : [0.3 + 0.35 * dry, 0.4 - 0.1 * dry, 0.08 + 0.05 * dry] });
          } else if (pick < 0.75 && L.rain < 0.3) particles.emitCustom('seedFluff', tmpP, tmpN, { speed: sp * 0.8 });
          else if (L.rain < 0.3) {
            tmpP.y = env.ground.heightAt(tmpP.x, tmpP.z) + 0.4;
            particles.emitCustom('windDust', tmpP, tmpN, { speed: sp, color: sim.mapId === 'desert' ? [0.85, 0.7, 0.5] : [0.6, 0.52, 0.4] });
          }
        }
      }

      // ---- fog banks: slow ground-hugging mist ----
      const mistLevel = L.fog;
      if (dA > 0 && mistLevel > 0.05 && !low) {
        mistAcc += mistLevel * 5 * Math.min(dA, 0.5);
        const R = view.mode === 'possess' ? 12 : Math.min(60, Math.max(14, cam.focusDist * 0.9));
        let guard = 8;
        while (mistAcc >= 1 && guard-- > 0) {
          mistAcc -= 1;
          const a = rand() * 6.283;
          const d = Math.sqrt(rand()) * R;
          tmpP.x = cam.focus.x + Math.cos(a) * d;
          tmpP.z = cam.focus.z + Math.sin(a) * d;
          tmpP.y = env.ground.heightAt(tmpP.x, tmpP.z) + 1.2 + rand() * 2.5;
          tmpN.x = L.wx * 0.4 + 0.2;
          tmpN.y = 0.02;
          tmpN.z = L.wz * 0.4;
          particles.emitCustom('mist', tmpP, tmpN, { size: (0.7 + 0.8 * rand()) * Math.max(1, R / 16), color: [0.78 * (0.25 + 0.75 * env.day) + 0.1 * env.night, 0.82 * (0.25 + 0.75 * env.day) + 0.14 * env.night, 0.88 * (0.25 + 0.75 * env.day) + 0.2 * env.night] });
        }
      }

      // ---- drips from grass tips while the meadow is wet ----
      if (dA > 0 && L.wet > 0.2 && vegetationTips.count > 0 && !low) {
        dripAcc += L.wet * (6 + 10 * L.rain) * Math.min(dA, 0.5);
        let guard = 12;
        const tips = vegetationTips.data;
        while (dripAcc >= 1 && guard-- > 0) {
          dripAcc -= 1;
          // a handful of tries to find a tip near the point of interest
          for (let t = 0; t < 6; t++) {
            const j = Math.floor(rand() * vegetationTips.count) * 3;
            const dx = tips[j] - cam.focus.x;
            const dz = tips[j + 2] - cam.focus.z;
            if (dx * dx + dz * dz > 30 * 30) continue;
            tmpP.x = tips[j];
            tmpP.y = tips[j + 1] - 0.05;
            tmpP.z = tips[j + 2];
            tmpN.x = 0;
            tmpN.y = -1;
            tmpN.z = 0;
            particles.emitCustom('drip', tmpP, tmpN);
            break;
          }
        }
      }

      // ---- sparkle + fireflies ----
      const sparkle = Math.max(env.dew * 0.9, L.frost, L.wet * 0.35 * env.day * (1 - L.rain)) * (1 - 0.8 * ctx.uniforms.uPheroVision.value);
      U.uSpark.value.set(sparkle, L.frost > env.dew ? Math.min(1, L.frost * 1.5) : 0, 0, 0);
      const box = view.mode === 'possess' ? 26 : Math.min(90, Math.max(30, cam.focusDist * 1.5));
      U.uSparkBox.value.set(box, 1, box);
      if (sparkMesh) sparkMesh.visible = sparkle > 0.02;
      U.uFlyLevel.value = L.fly;
      const fbox = view.mode === 'possess' ? 44 : Math.min(120, Math.max(50, cam.focusDist * 1.8));
      U.uFlyBox.value.set(fbox, 1, fbox);
      if (flyMesh) flyMesh.visible = L.fly > 0.02;
    },

    dispose() {
      for (const m of meshes) m.removeFromParent();
      meshes.length = 0;
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      dropMesh = null;
      crownMesh = craterMesh = rainMesh = flyMesh = boltMesh = null;
      sparkMesh = null;
      dropAttrs = crownAttrs = craterAttrs = [];
      weatherDrops.spawn = () => {};
      weatherDrops.impact = () => {};
      ctxRef = null;
      envRef = null;
      fx.flash = fx.shimmer = fx.fog = fx.dim = 0;
    },
  };
}

export const weatherFxModule: Module = createWeatherFxModule();
