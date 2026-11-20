import * as THREE from 'three';
import { MATERIALS, MAT_CHANNELS, Mat } from '../../core';
import type { NoiseTextures } from '../../assets/textures/noiseTextures';
import type { RenderContext } from '../shared';
import { getEnv } from './skyEnv';

/**
 * Terrain surface shader (§5.3): MeshStandardMaterial + onBeforeCompile, so three's lights,
 * shadows and image-based lighting keep working, with a procedural triplanar PBR layer per voxel
 * material driven by the mesher's 12 weight channels (attributes matW0..2, channel = MaterialId).
 *
 * Detail comes from three tileable noise atlases (assets/textures/noiseTextures) sampled at
 * several world scales with explicit gradients — mip-mapped, so it holds from canopy zoom down to
 * an ant's-eye view. Height gradients stored in the atlases give analytic triplanar bump mapping.
 *
 * Extras: wetness (`uWetness`: darker, glossier, puddles in hollows), underground ambient
 * falloff from the ground height field, clean cross-section look for cutaway caps / diorama
 * walls / pane faces, slab strata tints from A1's MapExtras, plant translucency, and the gel:
 * opaque with faked Beer-Lambert absorption through the slab (thickness texture), LED underglow,
 * halo around excavations, suspended bubbles and a wet fresnel on free faces.
 */

export const LED_COLOR = new THREE.Color(0.5, 0.82, 1.0);
export const MAX_STRATA = 8;

export interface TerrainUniforms {
  uCapPlane: THREE.IUniform<THREE.Vector4>;
  uSlabTex: THREE.IUniform<THREE.Texture | null>;
  /** x = slab thickness (0 = not a slab map), y = 1 when the slab axis is x, z = 1 on glass-boundary maps, w = underground logic on/off. */
  uSlab: THREE.IUniform<THREE.Vector4>;
  uLed: THREE.IUniform<THREE.Color>;
  uBase: THREE.IUniform<THREE.Vector3[]>;
  uStrataA: THREE.IUniform<THREE.Vector4[]>;
  uStrataB: THREE.IUniform<THREE.Vector4[]>;
  uStrataCount: THREE.IUniform<number>;
  uStyle: THREE.IUniform<THREE.Vector4>;
  /** Cutaway floor apron (terrain.ts): x = cut sign, y = slack depth past the plane. */
  uShell: THREE.IUniform<THREE.Vector4>;
}

const VERT_PARS = /* glsl */ `
attribute vec4 matW0;
attribute vec4 matW1;
attribute vec4 matW2;
varying vec4 vW0;
varying vec4 vW1;
varying vec4 vW2;
varying vec3 vWPos;
varying vec3 vWNormal;
`;

const VERT_MAIN = /* glsl */ `
vW0 = matW0; vW1 = matW1; vW2 = matW2;
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNormal = normalize(mat3(modelMatrix) * normal);
`;

const FRAG_PARS = /* glsl */ `
uniform sampler2D uNoiseFbm;
uniform sampler2D uNoiseCell;
uniform sampler2D uNoiseMisc;
uniform vec2 uGradScale;
uniform vec3 uBase[${MAT_CHANNELS}];
uniform vec3 uWorldSize;
uniform sampler2D uGroundTex;
uniform vec4 uCapPlane;
uniform sampler2D uSlabTex;
uniform vec4 uSlab;
uniform vec3 uLed;
uniform vec4 uStrataA[${MAX_STRATA}];
uniform vec4 uStrataB[${MAX_STRATA}];
uniform int uStrataCount;
uniform vec4 uShell;
uniform vec4 uStyle; // x = fungus is nutrient gel, y = clay is cast plaster, z = moss/lichen growth, w = arid (sun-baked rock)
uniform float uWetness;
uniform float uPheroVision;
uniform float uTime;
uniform vec3 uSunDirW;
uniform vec3 uKeyColor;
uniform vec3 uAmbientColor;
varying vec4 vW0;
varying vec4 vW1;
varying vec4 vW2;
varying vec3 vWPos;
varying vec3 vWNormal;

vec3 tBw; vec3 tDx; vec3 tDy;
float tsat(float x) { return clamp(x, 0.0, 1.0); }
// colour literals below are authored in sRGB
vec3 sc(float r, float g, float b) { return pow(vec3(r, g, b), vec3(2.2)); }

// triplanar sample; g = world-space gradient of the R channel (height per world unit)
vec4 triG(sampler2D t, vec3 p, float sc, float gs, out vec3 g) {
  vec4 acc = vec4(0.0); g = vec3(0.0);
  vec3 q = p * sc; vec3 dx = tDx * sc; vec3 dy = tDy * sc;
  if (tBw.x > 0.0) { vec4 s = textureGrad(t, q.zy, dx.zy, dy.zy); acc += s * tBw.x; g += tBw.x * vec3(0.0, s.b - 0.5, s.g - 0.5); }
  if (tBw.y > 0.0) { vec4 s = textureGrad(t, q.xz, dx.xz, dy.xz); acc += s * tBw.y; g += tBw.y * vec3(s.g - 0.5, 0.0, s.b - 0.5); }
  if (tBw.z > 0.0) { vec4 s = textureGrad(t, q.xy, dx.xy, dy.xy); acc += s * tBw.z; g += tBw.z * vec3(s.g - 0.5, s.b - 0.5, 0.0); }
  g *= 2.0 * gs * sc;
  return acc;
}
vec4 tri(sampler2D t, vec3 p, float sc) {
  vec4 acc = vec4(0.0);
  vec3 q = p * sc; vec3 dx = tDx * sc; vec3 dy = tDy * sc;
  if (tBw.x > 0.0) acc += textureGrad(t, q.zy, dx.zy, dy.zy) * tBw.x;
  if (tBw.y > 0.0) acc += textureGrad(t, q.xz, dx.xz, dy.xz) * tBw.y;
  if (tBw.z > 0.0) acc += textureGrad(t, q.xy, dx.xy, dy.xy) * tBw.z;
  return acc;
}
// slab strata (A1 MapExtras): rgb = tint, a = material id, a < 0 = none
vec4 strataAt(vec3 p, float jitter) {
  float x = uSlab.y > 0.5 ? p.z : p.x;
  for (int i = 0; i < ${MAX_STRATA}; i++) {
    if (i >= uStrataCount) break;
    vec4 a = uStrataA[i];
    if (p.y + jitter < a.x + a.y * sin(x * a.z + a.w)) return uStrataB[i];
  }
  return vec4(0.0, 0.0, 0.0, -1.0);
}
`;

const FRAG_SURFACE = /* glsl */ `
vec3 tAlb = vec3(0.0); float tRough = 0.0; vec3 tGrad = vec3(0.0); vec3 tEmis = vec3(0.0); float tAmb = 1.0;
vec3 tN = normalize(vWNormal);
float tCap = 0.0;
{
  vec3 P = vWPos;
  #ifdef TERRAIN_SHELL
  {
    // ghosted floor past the cut plane: solid under the entities, dissolving towards the viewer
    float sd = uShell.x * (dot(uCapPlane.xyz, P) + uCapPlane.w);
    float sa = 1.0 - smoothstep(uShell.y * 0.72, uShell.y, sd);
    float dn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (sa < dn + 0.02 || sd < -0.02) discard;
  }
  #endif
  tDx = dFdx(P); tDy = dFdy(P);
  vec3 V = normalize(cameraPosition - P);
  vec3 faceN = normalize(cross(tDx, tDy));
  if (dot(faceN, V) < 0.0) faceN = -faceN;

  // ---- flat cross-section faces: cutaway cap, diorama walls, pane faces ----
  float cutCap = 0.0;
  if (dot(uCapPlane.xyz, uCapPlane.xyz) > 0.5 && abs(dot(uCapPlane.xyz, P) + uCapPlane.w) < 0.05 && abs(dot(faceN, uCapPlane.xyz)) > 0.6) cutCap = 1.0;
  vec3 bnd = max(step(P, vec3(0.05)), step(uWorldSize - 0.05, P)) * step(0.6, abs(faceN));
  float wallCap = max(bnd.x, max(bnd.y, bnd.z));
  tCap = max(cutCap, wallCap);
  if (tCap > 0.5) tN = faceN;

  tBw = pow(abs(tN), vec3(4.0));
  tBw = max(tBw - 0.04, 0.0);
  tBw /= (tBw.x + tBw.y + tBw.z);
  float upF = tsat(tN.y);

  // ---- shared noise samples ----
  vec3 gLo; vec3 gMid; vec3 gHi; vec3 gCA; vec3 gCB;
  vec4 fLo = triG(uNoiseFbm, P + 3.7, 0.017, uGradScale.x, gLo);
  vec4 fMid = triG(uNoiseFbm, P + vec3(11.3, 5.1, 7.9), 0.11, uGradScale.x, gMid);
  vec4 cA = triG(uNoiseCell, P, 0.11, uGradScale.y, gCA);
  vec4 mA = tri(uNoiseMisc, P, 0.045);
  #ifdef TERRAIN_LOW
    vec4 fHi = vec4(0.5); gHi = vec3(0.0);
    vec4 cB = vec4(0.5, 0.5, 0.5, fract(cA.a * 7.0)); gCB = vec3(0.0);
    vec4 mB = vec4(0.0, 0.5, 0.0, 0.5);
  #else
    vec4 fHi = triG(uNoiseFbm, P, 1.9, uGradScale.x, gHi);
    vec4 cB = triG(uNoiseCell, P + 0.37, 0.62, uGradScale.y, gCB);
    vec4 mB = tri(uNoiseMisc, P, 1.3);
  #endif

  // ---- depth below the ground surface (outdoor maps) ----
  float depth = 0.0; float under = 0.0;
  if (uSlab.w > 0.5) {
    depth = textureLod(uGroundTex, P.xz / uWorldSize.xz, 0.0).r - P.y;
    // (plants / wood / fungus stand in the open air whatever the height field says)
    under = smoothstep(1.0, 3.5, depth - 1.2 * upF) * (1.0 - tCap) * (1.0 - tsat((vW1.z + vW2.x + vW2.z) * 1.5));
  }
  float outdoor = uSlab.w;

  // ---- material weights (channel = MaterialId) ----
  float w1 = vW0.y; float w2 = vW0.z; float w3 = vW0.w; float w4 = vW1.x; float w5 = vW1.y;
  float w6 = vW1.z; float w7 = vW1.w; float w8 = vW2.x; float w9 = vW2.y; float w10 = vW2.z;
  // sharpen blends a little and break the straight voxel transition lines with noise
  float wn = (fMid.r - 0.5) * 0.5;
  w1 = tsat(w1 + wn * step(0.02, w1) * step(w1, 0.98));
  // plant matter below the soil line is roots and humus, not green tissue: no green haze on cut
  // faces / entrance shafts (integration item d); only a thin sod line survives on a section
  if (uSlab.w > 0.5 && w8 > 0.003) {
    float buried = max(smoothstep(0.25, 1.1, depth + (fMid.r - 0.5) * 0.5), tCap * smoothstep(-0.9, -0.25, depth));
    w1 += w8 * buried;
    w8 *= 1.0 - buried;
  }
  float wsum = w1 + w2 + w3 + w4 + w5 + w6 + w7 + w8 + w9 + w10;
  float winv = 1.0 / max(wsum, 1e-4);
  vec4 strata = strataAt(P, (mB.g - 0.5) * 0.5);
  #define SB(i) (abs(strata.a - float(i)) < 0.5 ? strata.rgb : uBase[i])
  // gel farm: the Fungus strata are nutrient jelly — shade them as tinted gel
  float nutr = 0.0;
  if (uStyle.x > 0.5) { nutr = w10; w5 += w10; w10 = 0.0; }

  if (w1 > 0.003) { // ---------- soil: crumbly aggregates, grit, the odd pebble ----------
    float w = w1 * winv;
    vec3 b = SB(1);
    float v = fLo.r * 0.4 + fMid.r * 0.42 + fHi.r * 0.18;
    vec3 c = b * mix(0.42, 1.22, v);
    c = mix(c, c * vec3(1.16, 0.96, 0.78), fLo.a);
    // crumbs: only some cells are raised aggregates, the rest is fine tilth
    float sel = smoothstep(0.42, 0.5, cA.a) * (1.0 - step(0.9, cA.a));
    float clod = cA.r * sel;
    c *= 0.84 + 0.3 * clod - 0.1 * sel * (1.0 - cA.r);
    float peb = smoothstep(0.15, 0.45, cA.r) * step(0.9, cA.a) * smoothstep(0.5, 0.62, fLo.a * 0.5 + fMid.a * 0.55 + 0.25 * tCap);
    vec3 pc = mix(sc(0.3, 0.28, 0.26), sc(0.58, 0.52, 0.44), fract(cA.a * 37.0));
    c = mix(c, pc * (0.6 + 0.5 * cA.r) * (1.0 - 0.35 * tCap), peb);
    c *= 0.74 + 0.5 * mB.g;
    c += sc(0.8, 0.74, 0.6) * mB.b * 0.12 * (1.0 - peb);
    float crumb = cB.r * step(0.5, cB.a);
    c *= 0.84 + 0.3 * crumb;
    // dark organic matter in the hollows
    c = mix(c, c * vec3(0.6, 0.55, 0.5), smoothstep(0.5, 0.25, fMid.r * 0.6 + fLo.r * 0.4) * 0.5);
    c = mix(c, c * vec3(0.7, 0.6, 0.52), under * 0.7); // tunnels: moist and dark
    tAlb += w * c;
    tRough += w * mix(0.96, 0.55, peb);
    tGrad += w * (gMid * 0.416 + gHi * 0.028 + gCA * (0.05 * sel + 0.07 * peb) + gCB * 0.016 * step(0.5, cB.a));
  }
  if (w2 > 0.003) { // ---------- sand: individual grains, sparkle, ripples ----------
    float w = w2 * winv;
    vec3 b = SB(2);
    vec3 c = b * mix(0.82, 1.14, fLo.r * 0.4 + fMid.r * 0.6);
    float gid = cB.a;
    vec3 gc = mix(vec3(0.74, 0.7, 0.64), vec3(1.28, 1.22, 1.12), fract(gid * 5.3));
    gc = mix(gc, vec3(0.3, 0.22, 0.17), step(0.9, gid));
    gc = mix(gc, vec3(1.3, 0.95, 0.68), step(gid, 0.08));
    c *= mix(vec3(1.0), gc, 0.8) * (0.66 + 0.5 * cB.r);
    c *= 0.9 + 0.2 * mB.g;
    float rip = sin(dot(P.xz, vec2(0.8, 0.45)) * 2.4 + fLo.r * 14.0 + fMid.r * 2.0);
    c *= 1.0 + 0.07 * rip * upF * outdoor * (1.0 - under);
    c += vec3(1.0, 0.96, 0.85) * mB.b * 0.25;
    tAlb += w * c;
    // (0.3 here turned a sand patch into a white, striped mirror under the low moon / dusk key)
    tRough += w * mix(0.88, 0.58, mB.b);
    tGrad += w * (gCB * 0.02 + gMid * 0.112 + gHi * 0.008);
  }
  if (w3 > 0.003) { // ---------- clay: smooth, cracked ----------
    float w = w3 * winv;
    vec3 b = SB(3);
    vec3 c = b * mix(0.74, 1.16, fLo.r * 0.6 + fMid.r * 0.4);
    c = mix(c, c * vec3(1.1, 0.9, 0.8), fLo.a * 0.6);
    float fine = tri(uNoiseMisc, P + 9.0, 0.11).r;
    float plaster = uStyle.y;
    c *= 1.0 - (0.5 * fine * smoothstep(0.3, 0.6, fLo.a * 0.5 + fMid.a * 0.5) + 0.12 * mA.r) * (1.0 - plaster);
    // cast plaster: chalky, pin-holed, faint trowel streaks
    c = mix(c, b * (0.86 + 0.12 * fMid.r + 0.06 * fLo.r), plaster * 0.8);
    c *= 1.0 - plaster * 0.55 * smoothstep(0.75, 1.0, cB.r) * step(0.82, cB.a);
    c *= 0.92 + 0.16 * mB.g;
    tAlb += w * c;
    tRough += w * mix(0.8 - 0.22 * fLo.a, 0.93, uStyle.y);
    tGrad += w * (gMid * 0.096 + gHi * 0.006);
  }
  if (w4 > 0.003) { // ---------- rock: speckled, fractured, lichen ----------
    float w = w4 * winv;
    vec3 b = SB(4);
    vec3 c = b * mix(0.6, 1.25, fLo.r * 0.5 + fMid.r * 0.5);
    c = mix(c, c * vec3(1.1, 1.0, 0.88), fLo.a);
    float sid = cB.a;
    c = mix(c, sc(0.8, 0.78, 0.73), step(0.72, sid) * 0.6 * cB.r);
    c = mix(c, sc(0.12, 0.12, 0.13), step(sid, 0.14) * 0.75 * cB.r);
    c *= 1.0 + 0.07 * sin(P.y * 2.6 + fLo.r * 9.0);
    c *= 1.0 - 0.5 * mA.r * smoothstep(0.35, 0.6, fMid.a);
    c = mix(c, dot(c, vec3(0.4)) * vec3(1.5, 1.12, 0.82), uStyle.w * 0.75);
    float lich = uStyle.z * smoothstep(0.52, 0.66, fLo.a * 0.7 + fMid.a * 0.3) * (1.0 - under) * outdoor * (1.0 - tCap) * smoothstep(-0.2, 0.5, tN.y);
    c = mix(c, mix(sc(0.5, 0.56, 0.2), sc(0.74, 0.72, 0.58), fMid.a) * (0.7 + 0.5 * cB.r), lich * 0.75);
    tAlb += w * c;
    tRough += w * (0.74 - 0.3 * step(sid, 0.14) * cB.r);
    tGrad += w * (gMid * 0.48 + gHi * 0.03 + gCB * 0.006);
  }
  if (w5 > 0.003) { // ---------- gel: faked absorption, LED underglow, bubbles ----------
    float w = w5 * winv;
    vec3 b = mix(SB(5), SB(10), nutr / max(w5, 1e-4));
    bool ax = uSlab.y > 0.5;
    vec2 sp = ax ? P.zy : P.xy;
    vec2 ssz = ax ? uWorldSize.zy : uWorldSize.xy;
    vec3 Vs = ax ? V.zyx : V;
    float vz = max(abs(Vs.z), 0.3);
    vec2 par = -Vs.xy / vz; // slab-plane shift per unit of depth behind the pane
    float T = uSlab.x;
    float led = exp(-P.y / (uWorldSize.y * 0.36));
    vec3 backlight = uLed * (0.1 + 2.4 * pow(led, 1.35));
    vec2 smid = (sp + par * T * 0.5) / ssz;
    float thick = textureLod(uSlabTex, smid, 0.0).r;
    float halo = 1.0 - textureLod(uSlabTex, smid, 2.2).r;
    float freeF = 1.0 - tCap;
    float path = mix(thick, 0.45, freeF) * T / vz;
    vec3 tintc = b / max(max(b.r, b.g), b.b);
    vec3 trans = exp(-(1.03 - tintc) * 0.56 * path);
    vec3 body = backlight * trans * mix(vec3(1.0), tintc, 0.75);
    body += b * uLed * (0.05 + 1.1 * halo * halo) * (0.35 + led);
    // suspended bubbles at two depths (parallax gives them volume)
    vec2 ddx = (ax ? tDx.zy : tDx.xy); vec2 ddy = (ax ? tDy.zy : tDy.xy);
    for (int i = 0; i < 2; i++) {
      float dpt = i == 0 ? 0.8 : 2.8;
      float bs = i == 0 ? 0.17 : 0.11;
      vec2 q = (sp + par * dpt + float(i) * 13.7) * bs;
      vec4 cb = textureGrad(uNoiseCell, q, ddx * bs, ddy * bs);
      float sel = step(0.968, cb.a);
      float ring = smoothstep(0.02, 0.3, cb.r) * (1.0 - smoothstep(0.45, 0.9, cb.r));
      float core = smoothstep(0.8, 1.0, cb.r);
      body += sel * uLed * (ring * 0.35 + core * 0.5) * (0.35 + led) * (i == 0 ? 1.0 : 0.5);
    }
    // slow shimmer, like light through a thick liquid
    vec2 cq = (sp + par * 1.5) * 0.06;
    float ca = textureGrad(uNoiseFbm, cq + uTime * 0.008, ddx * 0.06, ddy * 0.06).r * textureGrad(uNoiseFbm, cq * 1.37 - uTime * 0.011, ddx * 0.08, ddy * 0.08).a;
    body *= 0.72 + 1.1 * ca;
    // faint vertical light shafts rising from the LED strip
    float shaft = textureGrad(uNoiseMisc, vec2((sp.x + par.x * 2.0) * 0.009, sp.y * 0.002 + 0.3), ddx * 0.009, ddy * 0.002).a;
    body *= 1.0 + 0.28 * (shaft - 0.5) * led;
    // free faces (tunnel walls, top surface): wet inner glow + fresnel
    float fr = pow(1.0 - tsat(dot(tN, V)), 3.0);
    // tunnel ceilings face the LED strip and light up; floors fall into a deeper blue
    body *= mix(1.0, 0.5 + 0.6 * tsat(0.5 - 0.5 * tN.y), freeF);
    body = mix(body, body * tintc * 1.15, freeF * 0.5);
    body += freeF * (b * uLed * 0.1 + uLed * fr * 0.22) * (0.5 + led);
    tEmis += w * body;
    tAlb += w * b * 0.06;
    tRough += w * mix(0.6, 0.1 + 0.25 * fMid.r, freeF);
    tGrad += w * freeF * (gMid * 0.16 + gHi * 0.012);
  }
  if (w6 > 0.003) { // ---------- wood: bark plates, fibres, moss; rings on cut faces ----------
    float w = w6 * winv;
    vec3 b = uBase[6];
    vec4 bk = tri(uNoiseMisc, P + 4.0, 0.1);
    vec3 c = b * mix(0.55, 1.2, fMid.r * 0.6 + fLo.r * 0.4);
    c = mix(c, c * 0.28, bk.r);
    c *= 0.78 + 0.44 * mB.a;
    c = mix(c, c * vec3(0.9, 0.95, 1.0) * 1.2, fMid.a * 0.45);
    float moss = uStyle.z * smoothstep(0.48, 0.7, fLo.a * 0.6 + fMid.a * 0.4 + tN.y * 0.22) * outdoor * (1.0 - under) * smoothstep(0.05, 0.6, tN.y);
    c = mix(c, sc(0.3, 0.42, 0.12) * (0.45 + 0.9 * cB.r), moss * 0.85);
    float ring = 0.5 + 0.5 * sin((fLo.r * 4.0 + fMid.r * 0.22) * 52.0);
    c = mix(c, b * vec3(1.45, 1.25, 0.95) * (0.72 + 0.34 * ring), tCap);
    tAlb += w * c;
    tRough += w * mix(0.88, 0.97, moss);
    tGrad += w * (gMid * 0.384 + gHi * 0.03 + gCB * 0.02 * moss);
  }
  if (w7 > 0.003) { // ---------- leaf litter: overlapping leaf fragments ----------
    float w = w7 * winv;
    vec3 gL;
    vec4 lf = triG(uNoiseCell, P + 1.7, 0.021, uGradScale.y, gL);
    float id = lf.a;
    vec3 pal = mix(mix(sc(0.5, 0.3, 0.12), sc(0.72, 0.52, 0.2), fract(id * 3.7)), mix(sc(0.4, 0.17, 0.09), sc(0.6, 0.55, 0.28), fract(id * 9.1)), step(0.5, fract(id * 5.3)));
    vec3 c = mix(uBase[7], pal, 0.78) * (0.4 + 0.8 * smoothstep(0.0, 0.5, lf.r));
    c *= 0.72 + 0.56 * mB.a;
    c *= 0.86 + 0.28 * mB.g;
    tAlb += w * c;
    tRough += w * (0.86 - 0.3 * fract(id * 11.0));
    tGrad += w * (gL * 0.5 + gHi * 0.015 + gMid * 0.128);
  }
  if (w8 > 0.003) { // ---------- plant tissue: veins, waxy cuticle, translucency; moss near the ground ----------
    float w = w8 * winv;
    vec3 b = uBase[8];
    vec4 st = tri(uNoiseMisc, P * vec3(1.0, 0.22, 1.0), 0.9);
    float hAbove = uSlab.w > 0.5 ? -depth : 9.0;
    float mossy = uStyle.z * (1.0 - smoothstep(4.0, 6.5, hAbove + fMid.r * 1.2)) * outdoor * smoothstep(0.05, 0.5, tN.y);
    vec3 c = b * mix(0.5, 1.08, fMid.r * 0.6 + fLo.r * 0.4);
    c *= mix(vec3(0.72, 0.82, 0.7), vec3(1.0), smoothstep(0.0, 14.0, hAbove)); // darker, bluer near the base
    c = mix(c, c * vec3(1.35, 1.12, 0.45), smoothstep(0.5, 0.85, fLo.a) * 0.45);
    float vein = smoothstep(0.5, 0.8, st.a);
    c = mix(c, c * 1.35 + vec3(0.015, 0.03, 0.0), vein * 0.5 * (1.0 - mossy));
    c *= 0.86 + 0.28 * mB.g;
    c = mix(c, c * vec3(0.74, 0.62, 0.4), smoothstep(0.6, 0.8, fMid.a * 0.6 + fLo.r * 0.4) * 0.5); // weathering
    // stems — upright, curved plant tissue above the turf (flat blades have no normal curvature and
    // stay as they are): swollen nodes with a dark groove and a pale collar, longitudinal ridges
    // from the normal's azimuth, internodes drifting yellow ↔ blue-green with a purple flush under
    // each node, and fine pale hairs that catch grazing light
    {
      float upr = 1.0 - smoothstep(0.35, 0.8, abs(tN.y));
      float curv = length(fwidth(tN.xz)) / max(length(fwidth(P)), 1e-4);
      float stem = upr * smoothstep(0.15, 0.32, curv) * (1.0 - smoothstep(0.95, 1.5, curv)) * (1.0 - mossy) * (1.0 - tCap);
      if (stem > 0.01) {
        float th = atan(tN.z, tN.x);
        float sid = fLo.r * 5.0 + fLo.a * 3.0; // slow noise: differs from stem to stem
        float rg = cos(th * 13.0 + sid * 2.0);
        float ridge = rg * 0.5 + 0.5;
        float ny = P.y / 5.5 + fLo.r * 1.1;
        float nf = fract(ny) - 0.5; // 0 at a node
        float ring = exp(-nf * nf * 1400.0);
        float collar = exp(-(nf - 0.035) * (nf - 0.035) * 500.0);
        float flush = exp(-(nf + 0.07) * (nf + 0.07) * 160.0);
        float inter = fract(floor(ny + 0.5) * 0.618 + sid * 0.3);
        c = mix(c, c * mix(vec3(1.1, 1.02, 0.74), vec3(0.84, 0.98, 1.06), inter), stem * 0.8);
        c = mix(c, c * (0.72 + 0.5 * ridge * ridge), stem * 0.75);
        c = mix(c, c * vec3(1.3, 0.66, 0.72), stem * flush * 0.4);
        c = mix(c, c * vec3(1.4, 1.34, 0.85) + vec3(0.02, 0.025, 0.0), stem * collar * 0.65);
        c = mix(c, c * vec3(0.42, 0.36, 0.26), stem * ring * 0.85);
        vec3 sT = normalize(vec3(-tN.z, 0.0, tN.x) + vec3(1e-4, 0.0, 0.0));
        tGrad += w * stem * (sT * (-sin(th * 13.0 + sid * 2.0)) * 0.34 + vec3(0.0, nf * ring * 22.0 - (nf - 0.035) * collar * 5.0, 0.0));
        #ifndef TERRAIN_LOW
        {
          vec4 hn = tri(uNoiseMisc, P * vec3(1.0, 0.28, 1.0), 6.0);
          float hair = smoothstep(0.66, 0.9, hn.a) * stem;
          float graze = pow(1.0 - tsat(dot(tN, V)), 2.0);
          c = mix(c, c * 1.5 + vec3(0.03, 0.035, 0.02), hair * (0.25 + 0.6 * graze));
          tEmis += w * hair * graze * (uAmbientColor * 0.35 + uKeyColor * 0.12) * vec3(0.9, 1.0, 0.7) * (1.0 - tCap);
        }
        #endif
      }
    }
    // ground-hugging growth is a turf / moss cushion, not glossy leaf tissue: muted olive albedo,
    // blade-scale streaks leaning with the slope, clover-dark and straw-dry patches, pale tips
    {
      vec3 gT;
      vec4 bl = triG(uNoiseMisc, P * vec3(1.0, 0.35, 1.0) + fMid.r * 0.6, 2.6, uGradScale.x, gT);
      float blade = bl.a;
      float tuft = cB.r;
      vec3 olive = sc(0.44, 0.58, 0.2);
      vec3 mc = olive * (0.35 + 0.95 * tuft) * (0.55 + 0.75 * fMid.r) * (0.75 + 0.5 * mB.g);
      mc = mix(mc, sc(0.22, 0.4, 0.14) * (0.6 + 0.6 * tuft), smoothstep(0.52, 0.72, fLo.r) * 0.75);       // dark clover mats
      mc = mix(mc, sc(0.62, 0.58, 0.26) * (0.5 + 0.7 * blade), smoothstep(0.56, 0.78, fLo.a) * 0.6);     // dry straw
      mc *= 0.62 + 0.75 * smoothstep(0.25, 0.8, blade);                                                     // blades over dark gaps
      mc += sc(0.7, 0.8, 0.3) * smoothstep(0.7, 0.92, blade) * tuft * 0.5;                             // sunlit tips
      mc = mix(mc, mc * vec3(1.4, 1.2, 0.5), step(0.74, cB.a) * 0.45 * cB.r);
      mc = mix(mc, sc(0.3, 0.22, 0.13) * (0.6 + 0.5 * fMid.r), smoothstep(0.62, 0.3, cA.r + fMid.a * 0.4) * 0.35); // soil showing through
      c = mix(c, mc, mossy);
      tGrad += w * mossy * gT * 0.05;
      // velvet: the cushion catches skylight at grazing angles
      tEmis += w * mossy * mc * uAmbientColor * pow(1.0 - tsat(dot(tN, V)), 2.0) * 0.9 * (1.0 - tCap);
    }
    c *= 1.0 - 0.45 * tCap; // cut turf: dense, dark sod
    float back = pow(tsat(dot(V, -uSunDirW)), 3.0) * 0.4 + tsat(dot(-tN, uSunDirW)) * 0.14;
    float fr = pow(1.0 - tsat(dot(tN, V)), 3.0);
    tEmis += w * (1.0 - mossy) * (1.0 - tCap) * (c * vec3(1.25, 1.3, 0.45) * uKeyColor * back * 0.5 + c * uAmbientColor * fr * 0.8);
    tAlb += w * c;
    tRough += w * mix(0.42 + 0.22 * fMid.a, 0.97, mossy);
    tGrad += w * (gMid * 0.08 + gHi * 0.008 + mossy * (gCB * 0.07 + gMid * 0.352 + gHi * 0.03));
  }
  if (w9 > 0.003) { // ---------- (termite) mud: pellets, damp patches ----------
    float w = w9 * winv;
    vec3 b = SB(9);
    vec3 c = b * mix(0.62, 1.2, fMid.r * 0.7 + fLo.r * 0.3);
    c *= 0.72 + 0.44 * cB.r;
    c = mix(c, c * vec3(1.25, 1.08, 0.9), step(0.6, cB.a) * 0.4);
    tAlb += w * c;
    tRough += w * mix(0.8, 0.38, fMid.a * fMid.a);
    tGrad += w * (gCB * 0.03 + gMid * 0.224);
  }
  if (w10 > 0.003) { // ---------- fungus: soft, spotted caps, gills underneath ----------
    float w = w10 * winv;
    vec3 b = SB(10);
    vec3 c = b * mix(0.84, 1.1, fMid.r);
    float spots = smoothstep(0.3, 0.6, cA.r) * step(0.7, cA.a) * smoothstep(0.0, 0.5, tN.y);
    c = mix(c, c * vec3(0.72, 0.5, 0.36), spots * 0.65);
    float gill = smoothstep(-0.1, -0.5, tN.y);
    c *= 1.0 - gill * 0.55 * smoothstep(0.35, 0.6, mB.a);
    float fr = pow(1.0 - tsat(dot(tN, V)), 2.5);
    tEmis += w * c * (uAmbientColor * (0.12 + 0.5 * fr) + uKeyColor * 0.05 * fr);
    tAlb += w * c;
    tRough += w * 0.66;
    tGrad += w * (gMid * 0.08 + gHi * 0.01);
  }
  if (wsum < 1e-3) { tAlb = vec3(0.4, 0.3, 0.25); tRough = 0.9; }
  float gelF = w5 * winv;
  float dry = 1.0 - gelF;
  // formicarium: the carved galleries carry a warm, hand-stained sandstone wash so they read as
  // rooms against the chalk-white block face (grey-on-white hollows looked unfinished)
  if (uStyle.y > 0.5) {
    float hollow = (1.0 - wallCap) * w3 * winv;
    tAlb = mix(tAlb, tAlb * vec3(1.0, 0.8, 0.6) + vec3(0.02, 0.008, 0.0), hollow * 0.8);
  }

  // ---- cross-section look: a clean museum cut with soil horizons ----
  float cutOn = step(0.5, dot(uCapPlane.xyz, uCapPlane.xyz));
  float section = max(cutCap, wallCap * (1.0 - step(0.5, uSlab.z)));
  if (section > 0.5) {
    float soilish = (w1 + w3 + w9) * winv * outdoor;
    float dj = depth + (fMid.r - 0.5) * 2.4 + (fLo.r - 0.5) * 5.0;
    // O/A horizon: dark humus right under the surface; B: the material itself; C: pale, stony subsoil
    float humus = smoothstep(4.5, 0.8, dj) * soilish;
    tAlb = mix(tAlb, tAlb * vec3(0.46, 0.4, 0.36), humus);
    float sub = smoothstep(12.0, 22.0, dj) * soilish;
    tAlb = mix(tAlb, tAlb * vec3(1.25, 1.18, 1.0) + sc(0.2, 0.17, 0.12) * 0.25, sub * 0.7);
    float band = sin(P.y * 0.85 + fLo.r * 7.0 + fLo.a * 4.0);
    tAlb *= 0.92 + 0.08 * band;
    // hair roots hanging into the topsoil
    float rootN = tri(uNoiseMisc, P * vec3(1.0, 0.16, 1.0) + fLo.r * 3.0, 0.42).a;
    float root = smoothstep(0.8, 0.9, rootN) * smoothstep(9.0, 0.5, dj) * soilish;
    tAlb = mix(tAlb, sc(0.7, 0.6, 0.44), root * 0.5);
    // diorama side walls (integration item h): an illustrative soil profile instead of a plain
    // dark slab — wavy horizon boundaries, an iron-stained clay band, gravel lenses, long roots,
    // weathered bedrock at the base — and enough fill light to read it on the shadow side
    float wallOnly = wallCap * (1.0 - cutCap) * outdoor;
    if (wallOnly > 0.5) {
      float along = abs(faceN.x) > 0.5 ? P.z : P.x;
      float wav = sin(along * 0.11 + fLo.r * 5.0) * 1.6 + (fMid.r - 0.5) * 1.8;
      float dw = depth + wav;
      float clay = smoothstep(9.0, 10.2, dw) * (1.0 - smoothstep(15.0, 16.5, dw)) * soilish;
      tAlb = mix(tAlb, mix(tAlb, sc(0.62, 0.36, 0.2), 0.55) * (0.9 + 0.25 * fMid.a), clay);
      float lens = smoothstep(0.6, 0.72, tri(uNoiseFbm, P * vec3(1.0, 3.2, 1.0) + 7.0, 0.035).a) * smoothstep(5.0, 9.0, dw) * soilish;
      float stone = smoothstep(0.3, 0.5, cB.r) * step(0.45, cB.a);
      tAlb = mix(tAlb, mix(sc(0.36, 0.33, 0.3), sc(0.66, 0.62, 0.55), fract(cB.a * 13.0)) * (0.55 + 0.6 * cB.r), lens * stone * 0.9);
      float tap = smoothstep(0.86, 0.93, tri(uNoiseMisc, P * vec3(1.0, 0.07, 1.0) + fLo.r * 2.0, 0.6).a) * smoothstep(16.0, 1.0, dw) * soilish;
      tAlb = mix(tAlb, sc(0.78, 0.68, 0.5), tap * 0.7);
      float sodLine = smoothstep(1.3, 0.2, depth) * soilish;
      tAlb = mix(tAlb, tAlb * vec3(0.5, 0.52, 0.4), sodLine * 0.6);
      float rockBase = smoothstep(9.0, 4.0, P.y + wav * 0.8);
      tAlb = mix(tAlb, tAlb * vec3(0.8, 0.82, 0.88) * (0.85 + 0.3 * sin(P.y * 3.1 + along * 0.07 + fLo.r * 6.0)), rockBase * 0.5);
      tEmis += tAlb * (uAmbientColor * 0.55 + uKeyColor * 0.035);
    }
    tGrad *= 0.45;
    tRough = mix(tRough, 0.88, 0.5);
  } else if (tCap > 0.5) {
    tGrad *= 0.5; // pressed flat against the pane
  }

  // ---- wetness: darker, glossier, puddles collect in the hollows ----
  float wet = uWetness * (1.0 - under) * outdoor * dry;
  if (wet > 0.001) {
    float puddle = wet * smoothstep(0.52, 0.36, fLo.r + 0.12 * fMid.r) * smoothstep(0.8, 0.96, tN.y) * (1.0 - tCap);
    tAlb *= mix(1.0, 0.5, wet * 0.85);
    tRough = mix(tRough, 0.28, wet * 0.75);
    tRough = mix(tRough, 0.03, puddle);
    tGrad *= 1.0 - 0.95 * puddle;
    tAlb = mix(tAlb, tAlb * 0.55, puddle);
  }

  // ---- ambient: the sky does not reach into tunnels ----
  // (with the cutaway open the nest is a lit exhibit: keep more of it)
  // Tunnel and chamber walls must read lighter and warmer than the cut face around them, so the
  // nest is a bright shape on dark soil and dark ants / pale brood stand out against the floor.
  float lit = under * cutOn * dry;
  tAlb = mix(tAlb, tAlb * vec3(1.55, 1.38, 1.14) + vec3(0.035, 0.026, 0.014), lit);
  if (section > 0.5) tAlb = mix(tAlb, mix(tAlb, vec3(dot(tAlb, vec3(0.3, 0.55, 0.15))), 0.25) * 0.68, cutOn * outdoor);
  tAmb = mix(1.0, mix(0.3, 0.9, cutOn), under);
  tEmis += tAlb * vec3(1.0, 0.66, 0.38) * (0.035 + 0.2 * cutOn) * under * dry;

  // ---- pheromone vision: desaturated, dimmed world ----
  float lum = dot(tAlb, vec3(0.3, 0.55, 0.15));
  tAlb = mix(tAlb, vec3(lum) * 0.5, uPheroVision * 0.85);
  tEmis *= 1.0 - 0.6 * uPheroVision;
}
diffuseColor.rgb = tAlb;
`;

const FRAG_NORMAL = /* glsl */ `
{
  vec3 nW = normalize(tN - (tGrad - tN * dot(tGrad, tN)));
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}
`;

export interface TerrainMaterial {
  material: THREE.MeshStandardMaterial;
  /** Dithered variant for the cutaway floor apron (same uniforms). */
  shellMaterial: THREE.MeshStandardMaterial;
  uniforms: TerrainUniforms;
}

export function createTerrainMaterial(ctx: RenderContext, noise: NoiseTextures): TerrainMaterial {
  const env = getEnv(ctx);
  const extras = env.mapExtras;
  const world = ctx.sim.world;

  const base: THREE.Vector3[] = [];
  for (let i = 0; i < MAT_CHANNELS; i++) {
    const tint = extras?.materialTints[i as keyof typeof extras.materialTints];
    const c = new THREE.Color();
    if (tint) c.setRGB(tint[0], tint[1], tint[2]);
    else c.setRGB(...(MATERIALS[i]?.color ?? [1, 0, 1]), THREE.SRGBColorSpace);
    base.push(new THREE.Vector3(c.r, c.g, c.b));
  }

  const strataA: THREE.Vector4[] = [];
  const strataB: THREE.Vector4[] = [];
  const bands = extras?.strata ?? [];
  for (let i = 0; i < MAX_STRATA; i++) {
    const b = bands[i];
    strataA.push(b ? new THREE.Vector4(b.y1, b.waveAmp, b.waveFreq, b.wavePhase) : new THREE.Vector4(1e9, 0, 0, 0));
    strataB.push(b ? new THREE.Vector4(b.tint[0], b.tint[1], b.tint[2], b.material) : new THREE.Vector4(0, 0, 0, -1));
  }
  const slab = ctx.map.flags.slab;
  const axisX = ctx.map.flags.slabAxis === 'x';
  const mapId = ctx.sim.mapId;
  const uniforms: TerrainUniforms = {
    uStyle: { value: new THREE.Vector4(mapId === 'gelFarm' ? 1 : 0, mapId === 'formicarium' ? 1 : 0, mapId === 'desert' ? 0.0 : 1, mapId === 'desert' ? 1 : 0) },
    uCapPlane: { value: new THREE.Vector4(0, 0, 0, 0) },
    uSlabTex: { value: null },
    uSlab: { value: new THREE.Vector4(slab ? (axisX ? world.sx : world.sz) : 0, axisX ? 1 : 0, ctx.map.boundary === 'glass' ? 1 : 0, slab || ctx.map.boundary === 'glass' ? 0 : 1) },
    uLed: { value: LED_COLOR.clone() },
    uBase: { value: base },
    uStrataA: { value: strataA },
    uStrataB: { value: strataB },
    uStrataCount: { value: Math.min(MAX_STRATA, bands.length) },
    uShell: { value: new THREE.Vector4(1, 3.5, 0, 0) },
  };

  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  material.name = 'terrain';
  if (ctx.quality.preset === 'low') material.defines = { ...material.defines, TERRAIN_LOW: '' };
  const patch = (shader: THREE.WebGLProgramParametersWithUniforms): void => {
    const u = shader.uniforms;
    u.uNoiseFbm = { value: noise.fbm };
    u.uNoiseCell = { value: noise.cell };
    u.uNoiseMisc = { value: noise.misc };
    u.uGradScale = { value: new THREE.Vector2(noise.fbmGradScale, noise.cellGradScale) };
    u.uWorldSize = env.uniforms.uWorldSize;
    u.uGroundTex = env.uniforms.uGroundTex;
    u.uWetness = ctx.uniforms.uWetness;
    u.uPheroVision = ctx.uniforms.uPheroVision;
    u.uTime = ctx.uniforms.uTime;
    u.uSunDirW = ctx.uniforms.uSunDir;
    u.uKeyColor = env.uniforms.uKeyColor;
    u.uAmbientColor = env.uniforms.uAmbientColor;
    Object.assign(u, uniforms);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${VERT_PARS}`).replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_SURFACE}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = clamp(tRough, 0.03, 1.0);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAG_NORMAL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += tEmis;`)
      .replace('#include <aomap_fragment>', `reflectedLight.indirectDiffuse *= tAmb; reflectedLight.indirectSpecular *= tAmb;\n#include <aomap_fragment>`);
  };
  material.onBeforeCompile = patch;
  const shellMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  shellMaterial.name = 'terrain-shell';
  shellMaterial.defines = { ...material.defines, TERRAIN_SHELL: '' };
  shellMaterial.onBeforeCompile = patch;
  void Mat;
  return { material, shellMaterial, uniforms };
}
