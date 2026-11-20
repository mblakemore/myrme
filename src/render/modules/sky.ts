import * as THREE from 'three';
import type { Module, RenderContext } from '../shared';
import { fx } from './fxShared';
import { disposeEnv, getEnv, updateEnv, type EnvState } from './skyEnv';

/**
 * Sky / backdrop (§5.3).
 *
 * Outdoor maps: an analytic scattering-look sky dome — zenith/horizon gradient that follows the
 * sun elevation, sunset band towards the sun azimuth, Mie glow, drifting fbm cloud layer lit by
 * the sun, moon + stars at night, an out-of-focus "far meadow" below the horizon.
 *
 * Farm maps: a procedural, deliberately out-of-focus room — wall, window light, bookshelf blur,
 * warm lamp bokeh and a string of fairy-light bokeh — so the habitat sits on a real desk.
 *
 * The same dome is rendered into a small cube map (with mips, for custom reflections: glass, dew)
 * and pre-filtered with PMREM into `scene.environment`, regenerated only when the time of day or
 * cloud cover moved enough. This module also owns the per-frame `updateEnv` call.
 */

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = modelViewMatrix * vec4(position, 0.0);
  gl_Position = projectionMatrix * vec4(p.xyz, 1.0);
  gl_Position.z = gl_Position.w;
}`;

const NOISE = /* glsl */ `
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float h31(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
float vn(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float a = 0.5; float s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * vn(p); p = p * 2.03 + vec2(17.3, 9.1); a *= 0.5; }
  return s;
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uHorizonSun; uniform vec3 uGround;
uniform vec3 uSunTrue; uniform vec3 uMoonDir; uniform vec3 uCloudLit; uniform vec3 uCloudDark; uniform vec3 uFar; uniform vec3 uFarLit;
uniform float uDay; uniform float uNight; uniform float uGolden; uniform float uCloud; uniform float uTime; uniform float uCapture; uniform float uPheroVision; uniform float uFlash;
varying vec3 vDir;
${NOISE}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float hz = pow(1.0 - clamp(h, 0.0, 1.0), 6.0);
  vec3 col = mix(uZenith * (0.8 + 0.2 * hz), uHorizon, hz);
  float az = dot(normalize(d.xz + 1e-5), normalize(uSunTrue.xz + 1e-5)) * 0.5 + 0.5;
  col = mix(col, uHorizonSun, hz * az * az * (0.35 + 0.65 * uGolden));
  float sd = dot(d, uSunTrue);
  float sunVis = smoothstep(-0.1, 0.03, uSunTrue.y);
  vec3 glowCol = mix(vec3(1.0, 0.5, 0.2), vec3(1.0, 0.93, 0.82), smoothstep(0.0, 0.4, uSunTrue.y));
  float sp = max(sd, 0.0);
  col += glowCol * sunVis * (pow(sp, 5.0) * 0.16 + pow(sp, 40.0) * 0.45 + pow(sp, 600.0) * 2.5) * (1.0 - 0.7 * uCloud);

  // night sky
  if (uNight > 0.01 && h > -0.05) {
    vec3 p = d * 95.0; vec3 ip = floor(p); vec3 fp = fract(p) - 0.5;
    float r = h31(ip);
    vec3 off = vec3(h31(ip + 3.1), h31(ip + 7.7), h31(ip + 11.3)) - 0.5;
    float star = smoothstep(0.02 + 0.09 * r, 0.0, length(fp - off * 0.6)) * step(0.72, r);
    float tw = 0.75 + 0.25 * sin(uTime * (2.0 + 5.0 * r) + r * 40.0);
    col += star * tw * uNight * mix(vec3(1.0, 0.85, 0.7), vec3(0.75, 0.88, 1.0), fract(r * 7.0)) * 3.0 * (1.0 - uCloud) * smoothstep(-0.05, 0.15, h);
    // faint milky band
    float band = exp(-pow(dot(d, normalize(vec3(0.5, 0.3, -0.8))) * 3.5, 2.0));
    col += uNight * band * vec3(0.012, 0.016, 0.03) * (0.6 + 0.8 * fbm(d.xz * 6.0 + d.y * 3.0)) * (1.0 - uCloud);
  }
  float md = dot(d, uMoonDir);
  float moonVis = (1.0 - uDay) * smoothstep(-0.02, 0.08, uMoonDir.y);
  if (moonVis > 0.01) {
    float disc = smoothstep(0.99925, 0.99945, md) * (1.0 - uCapture);
    vec2 mp = (d - uMoonDir * md).xy * 55.0;
    float maria = 0.72 + 0.28 * fbm(mp * 1.7 + 3.0);
    col += moonVis * (disc * maria * vec3(1.9, 2.0, 2.2) + pow(max(md, 0.0), 220.0) * vec3(0.16, 0.2, 0.3) + pow(max(md, 0.0), 12.0) * vec3(0.012, 0.018, 0.03));
  }

  // cloud layer
  if (h > 0.0) {
    vec2 uv = d.xz / (h + 0.14) * 0.42 + vec2(uTime * 0.0045, uTime * 0.0017);
    float n = fbm(uv) * 0.75 + fbm(uv * 2.7 + 5.0) * 0.25;
    float th = mix(0.72, 0.28, uCloud);
    float dens = smoothstep(th, th + 0.22, n) * smoothstep(0.0, 0.14, h);
    if (dens > 0.001) {
      float n2 = fbm(uv + normalize(uSunTrue.xz + 1e-4) * 0.09);
      float lit = clamp(0.55 + (n - n2) * 5.0, 0.0, 1.0);
      vec3 cc = mix(uCloudDark, uCloudLit, lit * (1.0 - 0.45 * dens));
      cc += glowCol * sunVis * pow(sp, 10.0) * 0.55 * (1.0 - dens * 0.6);
      cc = mix(cc, col, 0.35 * hz);
      col = mix(col, cc, dens * 0.92);
    }
  }

  // the far world, hopelessly out of focus: a soft band of vegetation with bokeh glints above
  // the horizon line, dissolving into blurred ground below — the macro-lens backdrop
  if (h < 0.3) {
    vec2 hd = normalize(d.xz + 1e-5);
    float top = 0.035 + 0.11 * vn(hd * 3.1 + 7.0) + 0.05 * vn(hd * 8.3 + 2.0);
    float fol = smoothstep(top, top - 0.1, h) * (1.0 - uCapture * 0.5);
    float tone = vn(hd * 6.0 + vec2(h * 9.0, -h * 7.0)) * 0.6 + vn(hd * 15.0 + h * 21.0) * 0.4;
    vec3 fc = mix(uFar * (0.45 + 1.0 * tone), uFarLit, tone * tone * (0.35 + 0.4 * az));
    fc = mix(fc, col, (0.1 + 0.22 * hz) * smoothstep(-0.12, 0.05, h));    // aerial haze
    // looking down: big soft blobs of ground and growth far below the focal plane
    vec2 gp = d.xz / (0.35 - min(h, 0.0));
    float gb = vn(gp * 2.2 + 3.0) * 0.6 + vn(gp * 5.5) * 0.4;
    // (kept earthy and dim: a neutral, vignetted ground the diorama can sit on, not a green wash)
    vec3 gcol = mix(uGround * 0.5, mix(uGround, uFar, 0.45) * 0.8, smoothstep(0.3, 0.7, gb)) * (0.5 + 0.5 * gb);
    gcol *= 1.0 - 0.55 * smoothstep(-0.25, -0.95, h);
    fc = mix(fc, gcol, smoothstep(-0.04, -0.4, h));
    col = mix(col, fc, fol);
    // bokeh discs: specular glints on distant leaves
    vec3 bp = d * 13.0; vec3 bi = floor(bp); vec3 bf = fract(bp) - 0.5;
    float br = h31(bi);
    vec3 bo = (vec3(h31(bi + 1.7), h31(bi + 5.3), h31(bi + 9.1)) - 0.5) * 0.5;
    float disc = smoothstep(0.3, 0.24, length(bf - bo) / (0.5 + 0.5 * br)) * step(0.62, br);
    col += disc * uFarLit * 0.5 * smoothstep(top + 0.06, top - 0.08, h) * smoothstep(-0.3, -0.05, h) * (1.0 - uCapture);
  }
  // lightning (B4 weatherFx → fx.flash): the cloud deck lights up from inside
  if (uFlash > 0.001) col += vec3(0.62, 0.72, 1.0) * uFlash * (0.25 + 1.6 * uCloud * smoothstep(-0.1, 0.5, h) * (0.4 + 0.6 * fbm(d.xz / (abs(h) + 0.2) * 0.8 + 3.0)));
  // pheromone vision: the backdrop drains with the rest of the world
  col = mix(col, vec3(dot(col, vec3(0.3, 0.55, 0.15))) * 0.45, uPheroVision * 0.85 * (1.0 - uCapture));
  gl_FragColor = vec4(col, 1.0);
}`;

const ROOM_FRAG = /* glsl */ `
uniform float uDay; uniform float uCapture; uniform float uTime; uniform float uPheroVision;
varying vec3 vDir;
${NOISE}
float sbox(vec2 p, vec2 b, float soft) { vec2 q = abs(p) - b; return 1.0 - smoothstep(-soft, soft, max(q.x, q.y)); }
float bokeh(vec2 p, vec2 c, float r) { float d = length(p - c) / r; return smoothstep(1.0, 0.82, d) * (0.7 + 0.3 * smoothstep(0.55, 0.95, d)); }
vec3 spine(float id) { return 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + h21(vec2(id, 3.0)) * vec3(1.0, 0.9, 0.8))); }
void main() {
  vec3 d = normalize(vDir);
  float el = asin(clamp(d.y, -1.0, 1.0));
  vec3 col;
  if (d.z < 0.25) {
    // ---- the wall behind the habitat (viewer looks towards -z) ----
    float az = atan(d.x, -d.z);
    vec3 wall = mix(vec3(0.085, 0.058, 0.045), vec3(0.4, 0.365, 0.32), uDay);
    col = wall * (0.7 + 0.4 * smoothstep(-0.7, 0.6, el)) * (0.9 + 0.2 * vn(vec2(az, el) * 2.2));
    // window, left
    vec2 w = vec2(az + 1.0, el - 0.3);
    float win = sbox(w, vec2(0.36, 0.4), 0.11);
    vec3 winCol = mix(vec3(0.02, 0.035, 0.09), vec3(1.7, 1.85, 2.0), uDay);
    float mull = 1.0 - 0.55 * max(smoothstep(0.07, 0.0, abs(w.x)), smoothstep(0.06, 0.0, abs(w.y - 0.05)));
    vec3 outside = winCol * (0.8 + 0.3 * smoothstep(-0.3, 0.4, w.y)) * mix(1.0, mull, 0.8);
    // evening: a few city lights through the glass
    for (int i = 0; i < 6; i++) {
      float fi = float(i);
      vec2 c = vec2(-0.3 + 0.6 * h21(vec2(fi, 1.0)), -0.32 + 0.5 * h21(vec2(fi, 2.0)));
      outside += (1.0 - uDay) * bokeh(w, c, 0.035 + 0.03 * h21(vec2(fi, 5.0))) * mix(vec3(1.0, 0.7, 0.3), vec3(0.5, 0.7, 1.0), h21(vec2(fi, 9.0))) * 0.55;
    }
    col = mix(col, outside, win);
    col += winCol * 0.1 * exp(-length(w * vec2(1.0, 0.8)) * 1.6) * uDay;
    // bookshelf, right
    vec2 sp = vec2(az - 0.95, el - 0.1);
    float shelf = sbox(sp, vec2(0.45, 0.5), 0.07);
    float sx = az * 30.0;
    float row = floor((el + 0.6) / 0.27);
    float sid = floor(sx) + row * 57.0;
    float sf = fract(sx);
    vec3 books = mix(spine(sid), spine(sid + 1.0), smoothstep(0.25, 0.75, sf));
    books = mix(books, vec3(dot(books, vec3(0.33))), 0.45) * (0.5 + 0.5 * h21(vec2(sid, 7.0)));
    float rowShade = smoothstep(0.0, 0.25, fract((el + 0.6) / 0.27)) * smoothstep(1.0, 0.8, fract((el + 0.6) / 0.27));
    vec3 shelfCol = mix(vec3(0.05, 0.03, 0.02), books * 0.42, rowShade) * mix(0.45, 1.0, uDay);
    col = mix(col, shelfCol, shelf * 0.92);
    // desk lamp glow + bokeh, right of centre
    vec3 lamp = vec3(1.0, 0.56, 0.2);
    vec2 lp = vec2(az - 0.42, el - 0.2);
    float lampOn = mix(1.0, 0.4, uDay);
    col += lamp * lampOn * (0.55 * exp(-dot(lp, lp) * 5.0) + 0.25 * exp(-dot(lp, lp) * 0.9));
    col += lamp * lampOn * 1.4 * bokeh(vec2(az, el), vec2(0.42, 0.2), 0.11);
    col += lamp * lampOn * 0.5 * bokeh(vec2(az, el), vec2(0.6, 0.02), 0.07);
    col += vec3(1.0, 0.8, 0.5) * lampOn * 0.4 * bokeh(vec2(az, el), vec2(0.27, 0.33), 0.05);
    // fairy lights on a catenary
    for (int i = 0; i < 14; i++) {
      float fi = float(i);
      float a = -1.45 + fi * 0.215 + 0.03 * sin(fi * 7.0);
      vec2 c = vec2(a, 0.68 - 0.1 * cos((a + 0.1) * 2.6) + 0.02 * sin(fi * 3.0));
      vec3 lc = mix(vec3(1.0, 0.62, 0.25), vec3(1.0, 0.82, 0.55), h21(vec2(fi, 4.0)));
      col += lc * bokeh(vec2(az, el), c, 0.04 + 0.018 * h21(vec2(fi, 8.0))) * mix(0.95, 0.35, uDay);
    }
    // floor falls away into darkness
    col *= mix(0.25, 1.0, smoothstep(-0.95, -0.35, el));
  } else {
    // ---- the room behind the viewer: only ever seen in reflections ----
    vec3 base = mix(vec3(0.05, 0.036, 0.03), vec3(0.2, 0.18, 0.16), uDay) * (0.7 + 0.5 * smoothstep(-0.5, 0.6, el));
    float az2 = atan(d.x, d.z);
    float soft = sbox(vec2(az2 + 0.4, el - 0.3), vec2(0.2, 0.17), 0.06);
    // a window behind the viewer (with a mullion): the highlight every glass pane wants
    soft *= 1.0 - 0.7 * smoothstep(0.02, 0.0, abs(az2 + 0.4)) - 0.7 * smoothstep(0.016, 0.0, abs(el - 0.31));
    vec3 softCol = mix(vec3(1.0, 0.62, 0.3) * 1.6, vec3(4.6, 4.8, 5.0), uDay);
    col = mix(base, softCol, soft);
    col += vec3(1.0, 0.6, 0.28) * 0.9 * exp(-pow(length(vec2(az2 - 0.9, el - 0.25)) * 3.2, 2.0)) * mix(1.0, 0.45, uDay);
    col = mix(col, base * 2.2, 0.5 * smoothstep(0.75, 1.0, d.y)); // ceiling bounce
  }
  col = mix(col, vec3(dot(col, vec3(0.3, 0.55, 0.15))) * 0.45, uPheroVision * 0.85 * (1.0 - uCapture));
  gl_FragColor = vec4(col, 1.0);
}`;

// Ground skirt (B4, integration item h): a soft, vignetted plane the outdoor diorama block stands
// on — earthy, blurred by the DoF, with an analytic contact shadow and the block's cast shadow —
// that melts into the backdrop instead of leaving the block floating in a flat green blur.
const SKIRT_VERT = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const SKIRT_FRAG = /* glsl */ `
uniform vec3 uGround; uniform vec3 uFar; uniform vec3 uKeyColor; uniform vec3 uAmbientColor; uniform vec3 uSunDir;
uniform vec4 uFoot; // centre xz, half size xz
uniform vec2 uBlock; // block height, fade radius
uniform float uPheroVision;
varying vec3 vW;
${NOISE}
float sdBox(vec2 p, vec2 b) { vec2 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0); }
void main() {
  vec2 p = vW.xz - uFoot.xy;
  float d = sdBox(p, uFoot.zw);
  if (d < -1.0) discard;
  float n = fbm(vW.xz * 0.006) * 0.75 + fbm(vW.xz * 0.03 + 9.0) * 0.25;
  vec3 earth = mix(uGround, vec3(dot(uGround, vec3(0.333))) * vec3(1.1, 1.0, 0.86), 0.65);
  vec3 alb = mix(earth * 0.8, mix(earth, uFar * 1.5, 0.3), smoothstep(0.35, 0.75, n)) * (0.85 + 0.3 * n);
  // cast shadow of the block: its footprint swept along the light direction
  vec2 off = -uSunDir.xz / max(uSunDir.y, 0.12) * uBlock.x;
  float sh = 1.0;
  for (int i = 1; i <= 4; i++) {
    float t = float(i) / 4.0;
    sh = min(sh, smoothstep(-2.0, 6.0 + 26.0 * t, sdBox(p - off * t, uFoot.zw)));
  }
  float contact = 1.0 - 0.8 * exp(-max(d, 0.0) * 0.11);
  vec3 col = alb * (uAmbientColor * 0.6 * contact + uKeyColor * max(uSunDir.y, 0.0) * 0.42 * sh);
  float a = 1.0 - smoothstep(uBlock.y * 0.3, uBlock.y, d);
  a *= a;
  col = mix(col, vec3(dot(col, vec3(0.3, 0.55, 0.15))) * 0.45, uPheroVision * 0.85);
  gl_FragColor = vec4(col * a, a);
}`;

/** Colour of the defocused far vegetation / terrain band per outdoor map (linear). */
const FAR_TINT: Record<string, readonly [number, number, number]> = {
  meadow: [0.085, 0.15, 0.04],
  forest: [0.05, 0.068, 0.03],
  desert: [0.42, 0.3, 0.17],
};
const _w = new THREE.Color(1, 1, 1);

export function createSkyModule(): Module {
  let dome: THREE.Mesh | null = null;
  let skirt: THREE.Mesh | null = null;
  let mat: THREE.ShaderMaterial | null = null;
  let envScene: THREE.Scene | null = null;
  let cubeRT: THREE.WebGLCubeRenderTarget | null = null;
  let cubeCam: THREE.CubeCamera | null = null;
  let pmrem: THREE.PMREMGenerator | null = null;
  let pmremRT: THREE.WebGLRenderTarget | null = null;
  let lastTod = -9;
  let lastCloud = -9;
  let context: RenderContext | null = null;
  const _c = new THREE.Color();

  function syncUniforms(ctx: RenderContext, s: EnvState): void {
    const u = mat!.uniforms;
    u.uDay.value = s.day;
    u.uFlash.value = fx.flash;
    if (s.room) return;
    u.uNight.value = s.night;
    u.uGolden.value = s.golden;
    u.uCloud.value = s.cloudiness;
    (u.uZenith.value as THREE.Color).copy(s.zenith);
    (u.uHorizon.value as THREE.Color).copy(s.horizon);
    (u.uHorizonSun.value as THREE.Color).copy(s.horizonSun);
    const g = ctx.map.environment.groundColor;
    (u.uGround.value as THREE.Color).setRGB(g[0], g[1], g[2]).multiplyScalar(0.1 + 0.9 * s.day).lerp(s.horizon, 0.35);
    const far = FAR_TINT[ctx.sim.mapId] ?? FAR_TINT.meadow;
    const dl = 0.05 + 0.95 * s.day;
    (u.uFar.value as THREE.Color).setRGB(far[0], far[1], far[2]).multiplyScalar(dl).lerp(s.horizon, 0.12);
    (u.uFarLit.value as THREE.Color).setRGB(far[0] * 2.6 + 0.1, far[1] * 2.3 + 0.08, far[2] * 1.6).multiply(_c.copy(s.keyColor).lerp(_w, 0.4)).multiplyScalar(dl * (0.6 + 0.4 * (1 - s.cloudiness)));
    (u.uSunTrue.value as THREE.Vector3).copy(s.sunDir);
    (u.uMoonDir.value as THREE.Vector3).copy(s.moonDir);
    // cloud colours: sunlit side takes the key colour, shaded side the sky
    const lit = u.uCloudLit.value as THREE.Color;
    lit.setRGB(1, 1, 1).lerp(_c.setRGB(1.0, 0.62, 0.38), s.golden).multiplyScalar(0.05 + 1.05 * s.day * (1 - 0.45 * s.cloudiness));
    lit.lerp(_c.setRGB(0.07, 0.09, 0.15), s.night * 0.9);
    (u.uCloudDark.value as THREE.Color).copy(s.zenith).lerp(s.horizon, 0.5).multiplyScalar(0.75 - 0.3 * s.cloudiness).lerp(_c.setRGB(0.3, 0.2, 0.28), 0.35 * s.golden * s.day);
  }

  function capture(ctx: RenderContext, s: EnvState): void {
    const r = ctx.renderer;
    mat!.uniforms.uCapture.value = 1;
    const prevTarget = r.getRenderTarget();
    cubeCam!.update(r, envScene!);
    const old = pmremRT;
    pmremRT = pmrem!.fromCubemap(cubeRT!.texture);
    old?.dispose();
    r.setRenderTarget(prevTarget);
    mat!.uniforms.uCapture.value = 0;
    ctx.scene.environment = pmremRT.texture;
    s.envCube = cubeRT!.texture;
    s.uniforms.uEnvCube.value = cubeRT!.texture;
    s.envVersion++;
    lastTod = s.timeOfDay;
    lastCloud = s.cloudiness;
  }

  return {
    id: 'sky',
    init(ctx) {
      context = ctx;
      const s = getEnv(ctx);
      const room = s.room;
      mat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
        toneMapped: false,
        uniforms: {
          uZenith: { value: new THREE.Color() },
          uHorizon: { value: new THREE.Color() },
          uHorizonSun: { value: new THREE.Color() },
          uGround: { value: new THREE.Color() },
          uCloudLit: { value: new THREE.Color() },
          uCloudDark: { value: new THREE.Color() },
          uFar: { value: new THREE.Color() },
          uFarLit: { value: new THREE.Color() },
          uSunTrue: { value: new THREE.Vector3(0, 1, 0) },
          uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
          uDay: { value: 1 },
          uNight: { value: 0 },
          uGolden: { value: 0 },
          uCloud: { value: 0.3 },
          uCapture: { value: 0 },
          uTime: ctx.uniforms.uTime,
          uPheroVision: ctx.uniforms.uPheroVision,
          uFlash: { value: 0 },
        },
        vertexShader: VERT,
        fragmentShader: room ? ROOM_FRAG : SKY_FRAG,
      });
      const geo = new THREE.SphereGeometry(1, 32, 20);
      dome = new THREE.Mesh(geo, mat);
      dome.name = 'sky';
      dome.frustumCulled = false;
      dome.renderOrder = -10;
      ctx.scene.add(dome);
      if (!room && ctx.map.boundary === 'open') {
        const world = ctx.sim.world;
        const R = Math.max(world.sx, world.sz);
        const sm = new THREE.ShaderMaterial({
          uniforms: {
            uGround: mat.uniforms.uGround,
            uFar: mat.uniforms.uFar,
            uKeyColor: s.uniforms.uKeyColor,
            uAmbientColor: s.uniforms.uAmbientColor,
            uSunDir: ctx.uniforms.uSunDir,
            uFoot: { value: new THREE.Vector4(world.sx / 2, world.sz / 2, world.sx / 2, world.sz / 2) },
            uBlock: { value: new THREE.Vector2(s.mapExtras?.surfaceY ?? world.sy * 0.5, R * 2.2) },
            uPheroVision: ctx.uniforms.uPheroVision,
          },
          vertexShader: SKIRT_VERT,
          fragmentShader: SKIRT_FRAG,
          transparent: true,
          depthWrite: false,
          blending: THREE.CustomBlending,
          blendEquation: THREE.AddEquation,
          blendSrc: THREE.OneFactor,
          blendDst: THREE.OneMinusSrcAlphaFactor,
          toneMapped: false,
        });
        skirt = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), sm);
        skirt.name = 'sky:skirt';
        skirt.rotation.x = -Math.PI / 2;
        skirt.position.set(world.sx / 2, -0.06, world.sz / 2);
        skirt.scale.setScalar(R * 7);
        skirt.renderOrder = -9;
        skirt.frustumCulled = false;
        ctx.scene.add(skirt);
      }
      ctx.scene.fog = null; // depth fog is a post effect (LookExtras), so every material gets it

      envScene = new THREE.Scene();
      const envDome = new THREE.Mesh(geo, mat);
      envDome.frustumCulled = false;
      envScene.add(envDome);
      const low = ctx.quality.preset === 'low';
      cubeRT = new THREE.WebGLCubeRenderTarget(low ? 64 : 128, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
      cubeCam = new THREE.CubeCamera(0.1, 10, cubeRT);
      pmrem = new THREE.PMREMGenerator(ctx.renderer);
      syncUniforms(ctx, s);
      capture(ctx, s);
    },
    update(ctx, frame) {
      updateEnv(ctx, frame);
      const s = getEnv(ctx);
      syncUniforms(ctx, s);
      const dt = Math.abs(s.timeOfDay - lastTod);
      const dTod = Math.min(dt, 1 - dt);
      const dCloud = Math.abs(s.cloudiness - lastCloud);
      // twilight changes fast: refresh the reflection environment more often there
      const step = 0.004 + 0.012 * s.day * (1 - s.golden);
      if (ctx.sync ? dTod > 1e-5 || dCloud > 1e-3 : dTod > step || dCloud > 0.08) capture(ctx, s);
    },
    dispose() {
      if (dome) {
        dome.removeFromParent();
        dome.geometry.dispose();
      }
      if (skirt) {
        skirt.removeFromParent();
        skirt.geometry.dispose();
        (skirt.material as THREE.Material).dispose();
        skirt = null;
      }
      mat?.dispose();
      cubeRT?.dispose();
      pmremRT?.dispose();
      pmrem?.dispose();
      if (context) {
        if (context.scene.environment === pmremRT?.texture) context.scene.environment = null;
        disposeEnv(context);
      }
      dome = null;
      mat = null;
      envScene = null;
      cubeRT = cubeCam = null;
      pmrem = null;
      pmremRT = null;
      context = null;
    },
  };
}

export const skyModule: Module = createSkyModule();
