import * as THREE from 'three';
import type { CreatureGeometryKind, CreatureLook, CreatureRig, GeometryLod } from '../../core';
import { getCreatureGeometry, getCreatureLook } from '../../assets/geometry';
import { applyCutPlane, type SharedUniforms } from '../shared';
import { fx } from './fxShared';

/**
 * Chitin material + instanced creature mesh factory (A4). Shared by ants, corpses, brood and
 * (next wave) B4's creature module:
 *
 *   const inst = createInstancedCreature('jumpingSpider', 0, 16, ctx.uniforms);
 *   scene.add(inst.mesh);
 *   // per frame, per instance i:
 *   writeMoverMatrix(creature, alpha, def.length, inst.matrix, i * 16);
 *   inst.color.set([r, g, b], i * 3);              // albedo (usually look.color × variation)
 *   inst.a.set([gaitPhase, speed01, seed, sunlit], i * 4);
 *   inst.b.set([bite, carry, curlOrFly, infection], i * 4);
 *   inst.c.set([markR, markG, markB, highlight], i * 4);
 *   inst.commit(count);
 *
 * Per-instance channels
 *   a.x gait phase in cycles (advance by distance / (rig.stride × length)) — feet plant exactly
 *   a.y speed 0..1 (bob / sway / antenna tempo)      a.z random seed 0..1
 *   a.w sun exposure 0..1 (gates backlit translucency and rim so tunnels stay dark)
 *   b.x bite 0..1 (mandibles open → snap; stingers curl the gaster under; mantis arms strike)
 *   b.y carry 0..1 (head raised)
 *   b.z death curl 0..1; NEGATIVE values = flying (wings spread and beat)
 *   b.w infection 0..1 (fungal tint + glow)
 *   c.rgb colony marker colour (0 = none)            c.w highlight (>0 white rim, <0 red flash)
 *   d.x pose: >0 crouch (body low, legs drawn in — spider before a pounce, grappling ants);
 *       <0 splay (legs flat and wide — rafting ants)
 *   d.y strike / lunge 0..1 (body thrown forward over planted feet, front legs raised)
 *   d.z head yaw in radians (mantis head tracking)
 *   d.w >0 thrash (crawlers whip sideways); <0 stuck in glue (gait frozen, pale stringy coat)
 * The infection channel also drives the pose: ~0.5–0.7 twitchy erratic gait, ≥0.85 death grip
 * (mandibles clamped, legs hugging the stem), ≥0.75 mycelium fuzz.
 * All shader animation runs on the FX clock (`fxShared.fx.uClock`), which follows the sim while
 * the render clock is frozen.
 */

const VERT_PARS = /* glsl */ `
attribute vec4 aBody;
attribute vec3 aPivot;
attribute vec4 aInstA;
attribute vec4 aInstB;
attribute vec4 aInstC;
attribute vec4 aInstD;
uniform float uTime;
uniform vec3 uNeck;
uniform vec3 uWaist;
uniform vec4 uGait;  // stride, duty, lift, crawl
uniform vec4 uAnimP; // antenna amplitude, sting curl, first-person-only, idle amount
varying vec4 vBody;
#ifndef ANT_DEPTH
uniform vec3 uSunDir;
varying vec3 vObj;
varying vec4 vInstC;
varying vec4 vMisc; // seed, sunlit, infection, object normal y
varying vec3 vSunV;
varying vec2 vFx; // glue coat, flying
#endif

void aRotX(inout vec3 p, inout vec3 n, vec3 c, float a) {
  float s = sin(a), k = cos(a);
  p -= c;
  p.yz = vec2(p.y * k - p.z * s, p.y * s + p.z * k);
  n.yz = vec2(n.y * k - n.z * s, n.y * s + n.z * k);
  p += c;
}
void aRotY(inout vec3 p, inout vec3 n, vec3 c, float a) {
  float s = sin(a), k = cos(a);
  p -= c;
  p.xz = vec2(p.x * k + p.z * s, -p.x * s + p.z * k);
  n.xz = vec2(n.x * k + n.z * s, -n.x * s + n.z * k);
  p += c;
}
void aRotZ(inout vec3 p, inout vec3 n, vec3 c, float a) {
  float s = sin(a), k = cos(a);
  p -= c;
  p.xy = vec2(p.x * k - p.y * s, p.x * s + p.y * k);
  n.xy = vec2(n.x * k - n.y * s, n.x * s + n.y * k);
  p += c;
}

void antAnimate(inout vec3 p, inout vec3 n) {
  float part = aBody.x;
  float w = aBody.z;
  float phase = aInstA.x;
  float spd = aInstA.y;
  float seed = aInstA.z;
  float bite = aInstB.x;
  float carry = aInstB.y;
  float curl = max(aInstB.z, 0.0);
  float fly = max(-aInstB.z, 0.0);
  float live = 1.0 - curl;
  float crouch = max(aInstD.x, 0.0);
  float splay = max(-aInstD.x, 0.0);
  float strike = aInstD.y;
  float thrash = max(aInstD.w, 0.0);
  // |d.w| < 0.5 is a lingering glue coat on a slowed (still walking) body; above that the gait freezes
  float stuck = smoothstep(0.45, 0.7, max(-aInstD.w, 0.0));
  float infectA = aInstB.w * live;
  // erratic stage: spasms come in bursts; death grip from 'gripped' on
  float twitch = smoothstep(0.3, 0.5, infectA) * (1.0 - smoothstep(0.78, 0.86, infectA));
  float grip = smoothstep(0.78, 0.86, infectA) * step(0.5, uAnimP.w);
  live *= 1.0 - 0.85 * grip;
  float idle = (1.0 - spd) * live * uAnimP.w * (1.0 - stuck);
  float t = uTime;
  float spasm = twitch * smoothstep(0.35, 0.9, sin(t * 2.3 + seed * 70.0)) * sin(t * 37.0 + seed * 11.0);
  float sideS = aPivot.x >= 0.0 ? 1.0 : -1.0;
  bool isLeg = abs(part - 4.0) < 0.5;
  bool isAntenna = abs(part - 5.0) < 0.5;
  bool isMandible = abs(part - 6.0) < 0.5;
  bool isGaster = abs(part - 3.0) < 0.5;
  bool isWing = abs(part - 8.0) < 0.5;
  bool isArm = abs(part - 10.0) < 0.5;
  bool headGroup = part < 0.5 || (part > 4.5 && part < 7.5);
  float bodyW = 1.0;

  if (isLeg) {
    // alternating tripod (tetrapod for 8 legs): diagonal pairs share a phase
    float pair = floor(aBody.y * 0.5 + 0.01);
    float side = aBody.y - pair * 2.0;
    float lp = fract(phase + 0.5 * mod(pair + side, 2.0) + pair * 0.035 + twitch * 0.12 * sin(t * 19.0 + aBody.y * 2.1 + seed * 40.0));
    float duty = uGait.y;
    float zo;
    float lift = 0.0;
    if (lp < duty) {
      zo = 0.5 - lp / duty; // stance: the foot travels straight back at body speed → planted
    } else {
      float s = (lp - duty) / (1.0 - duty);
      zo = -0.5 + s * s * (3.0 - 2.0 * s);
      lift = sin(3.14159 * s);
    }
    float g = live * (1.0 - fly) * (1.0 - stuck);
    p.z += w * zo * uGait.x * duty * g;
    // spasm: a leg jerks up out of rhythm
    p.y += w * twitch * 0.07 * max(0.0, sin(t * 13.0 + aBody.y * 1.7 + seed * 23.0) - 0.6) * 2.5;
    // crouch: feet drawn in under the body; splay: flat and wide on the water
    p.x = mix(p.x, p.x * 0.74, crouch * w);
    p.x += sideS * splay * w * 0.1;
    p.y += splay * w * 0.13;
    // strike: front legs thrown up and forward
    float front = 1.0 - smoothstep(0.5, 1.5, pair);
    p.y += strike * w * front * 0.17;
    p.z += strike * w * front * 0.12;
    // death grip: legs wrap the stem under the body
    p.x = mix(p.x, sideS * 0.05, grip * w * 0.85);
    p.y -= grip * w * 0.07;
    p.y += w * lift * uGait.z * smoothstep(0.0, 0.12, spd) * (0.5 + 0.5 * spd) * g;
    // flight: legs trail; death: legs fold in over the belly
    p.z -= fly * w * 0.08;
    p.y += fly * w * 0.05;
    p.x = mix(p.x, sideS * 0.045, curl * w * 0.92);
    p.y += curl * w * 0.19;
    p.z = mix(p.z, aPivot.z, curl * w * 0.55);
    bodyW = 1.0 - w;
  }
  if (isAntenna) {
    float sw = mix(sin(t * 2.1 + seed * 31.0 + sideS * 1.3), sin(t * 7.3 + seed * 31.0 + sideS * 1.3), spd) * 0.2 + sin(t * 5.3 + seed * 11.0) * 0.05;
    float tap = mix(sin(t * 2.9 + seed * 17.0 + sideS * 0.7), sin(t * 9.1 + seed * 17.0 + sideS * 2.1), spd) * 0.16 + 0.1 * spd;
    // idle fidget: one antenna at a time is drawn down through the mouthparts (grooming)
    float groom = smoothstep(0.93, 1.0, sin(t * 0.4 + seed * 50.0 + sideS * 1.5708)) * idle;
    tap += groom * 0.9;
    sw -= groom * 0.5;
    float k = (0.3 + 0.7 * w) * uAnimP.x * live;
    aRotY(p, n, aPivot, sideS * sw * k);
    aRotX(p, n, aPivot, tap * k + curl * 0.9 * w);
  }
  if (isMandible) {
    float open = (0.05 + 0.04 * sin(t * 1.7 + seed * 9.0)) * live + bite * 0.8 - grip * 0.06 + abs(spasm) * 0.3;
    aRotY(p, n, aPivot, sideS * open);
  }
  if (isArm) {
    aRotX(p, n, aPivot, bite * 0.9 * (0.3 + 0.7 * w) + 0.05 * sin(t * 1.1 + seed * 7.0) * live);
    p.z += bite * w * 0.12;
  }
  if (headGroup) {
    float pitch = -carry * 0.42 + 0.035 * sin(t * 1.3 + seed * 20.0) * live + curl * 0.7 + bite * 0.1;
    float yaw = 0.16 * sin(t * 0.6 + seed * 37.0) * idle + aInstD.z + spasm * 0.4;
    pitch += grip * 0.35;
    aRotX(p, n, uNeck, pitch);
    aRotY(p, n, uNeck, yaw);
  }
  if (isGaster) {
    float a = -(curl * 1.15 + bite * uAnimP.y * 0.85) * (0.4 + 0.6 * w) + 0.03 * sin(t * 2.3 + seed * 5.0) * live + carry * 0.08;
    aRotX(p, n, uWaist, a);
  }
  if (isWing) {
    aRotY(p, n, aPivot, -sideS * 1.3 * fly);
    // in flight the chord fans out across the stroke: reads as a blurred wing disc, not a frozen blade
    float chordW = clamp(((position.x - aPivot.x) * sideS - (aPivot.z - position.z) * 0.2) / 0.08, -1.0, 1.0);
    aRotZ(p, n, aPivot, sideS * fly * (0.45 + 0.8 * sin(t * 95.0 + seed * 20.0) + chordW * 0.24));
  }
  if (uGait.w > 0.0 && !isLeg) {
    float wv = p.z * 9.0 - phase * 6.2832;
    p.y += uGait.w * (0.5 + 0.5 * sin(wv)) * live;
    p.z += uGait.w * 0.6 * cos(wv) * live;
  }
  // pose offsets of the body over planted feet
  p.y -= bodyW * (crouch * 0.07 + splay * 0.1);
  p.z += bodyW * strike * 0.2;
  p.y += bodyW * strike * 0.03;
  if (thrash > 0.0) {
    float wh = sin(position.z * 7.0 + t * 19.0 + seed * 9.0) * (0.25 + abs(position.z)) * thrash;
    p.x += wh * 0.16;
    p.y += abs(wh) * 0.05 * bodyW;
  }
  aRotY(p, n, vec3(0.0), spasm * 0.22 * bodyW);
  // body bob + yaw sway; planted feet stay put (weighted by 1 - w)
  p.y += bodyW * spd * 0.012 * sin(phase * 12.566) * live;
  p.y += fly * 0.02 * sin(t * 9.0 + seed * 40.0);
  aRotY(p, n, vec3(0.0), spd * 0.055 * sin(phase * 6.2832) * live * bodyW);
  if (uAnimP.z > 0.5 && !(isAntenna || isMandible)) p = vec3(0.0);
}
`;

const FRAG_PARS = /* glsl */ `
uniform float uTime;
uniform vec3 uSunColor;
uniform float uWetness;
uniform float uPheroVision;
uniform vec4 uSurf;   // band count, wax, translucency-all, rim strength
uniform vec4 uTransl; // rgb, strength
uniform vec4 uMark;   // thorax z, gaster z, dot radius, enabled
uniform float uDetail;
uniform float uLeaf;
uniform vec3 uSkyC;
uniform vec3 uGroundC;
uniform float uNightK;
uniform float uTranslK;
varying vec2 vFx;
varying vec4 vBody;
varying vec3 vObj;
varying vec4 vInstC;
varying vec4 vMisc;
varying vec3 vSunV;
float antHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float antNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(antHash(i), antHash(i + vec3(1, 0, 0)), f.x), mix(antHash(i + vec3(0, 1, 0)), antHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(antHash(i + vec3(0, 0, 1)), antHash(i + vec3(1, 0, 1)), f.x), mix(antHash(i + vec3(0, 1, 1)), antHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
`;

const WING_DITHER = /* glsl */ `
  if (vBody.x > 7.5 && vBody.x < 8.5) {
    float wingA = mix(0.5, 1.0, vBody.w);
    float wingD = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (wingA < wingD) discard;
  }
`;

const FRAG_COLOR = /* glsl */ `
  float aPart = vBody.x;
  float isGaster = step(2.5, aPart) * step(aPart, 3.5);
  float isEye = step(6.5, aPart) * step(aPart, 7.5);
  float isWing = step(7.5, aPart) * step(aPart, 8.5);
  float isBodyPart = step(aPart, 3.5);
  float seedF = vMisc.x;
  float sunlit = vMisc.y;
  float infect = vMisc.z;
  if (isWing > 0.5) {
    // membrane: pale, glassy, dark veins (the AO channel carries vein strength on wings)
    diffuseColor.rgb = mix(vec3(0.5, 0.47, 0.4), vec3(0.1, 0.07, 0.04), vBody.w);
    #ifdef WING_BLEND
      diffuseColor.a = mix(0.3, 0.95, vBody.w) * (1.0 - 0.5 * vFx.y);
    #else
      float wingD = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      if (mix(0.5, 1.0, vBody.w) < wingD) discard;
    #endif
  }
  float n1 = antNoise(vObj * 34.0 + seedF * 13.0);
  float n2 = antNoise(vObj * 9.0 + seedF * 5.0);
  diffuseColor.rgb *= 0.84 + 0.32 * n2;
  float tergite = 1.0;
  if (uSurf.x > 0.5 && isGaster > 0.5) {
    // overlapping tergites: dark groove at each joint, paler stretched membrane behind it
    float sgf = fract(vBody.z * uSurf.x + 0.5);
    float inner = smoothstep(0.06, 0.2, vBody.z) * (1.0 - smoothstep(0.86, 0.97, vBody.z));
    float groove = 1.0 - (1.0 - smoothstep(0.0, 0.06, sgf) * (1.0 - smoothstep(0.95, 1.0, sgf))) * inner;
    float edge = smoothstep(0.7, 0.95, sgf) * inner;
    diffuseColor.rgb *= mix(0.4, 1.0, groove);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.6 + uTransl.rgb * uTransl.a * 0.03, edge * 0.7);
    tergite = 0.55 + 0.45 * edge + 0.25 * groove;
  }
  // colony paint dots (thorax + gaster dorsum), the way field myrmecologists mark ants
  float mk = 0.0;
  // marker colours above 1 flag a RIVAL colony (ants module): bigger dots, tinted cuticle + rim
  float rival = step(1.5, max(vInstC.r, max(vInstC.g, vInstC.b)));
  vec3 mkCol = vInstC.rgb * (1.0 - 0.5 * rival);
  if (uMark.w > 0.5 && vInstC.r + vInstC.g + vInstC.b > 0.001) {
    float dT = length(vObj.xz - vec2(0.0, uMark.x));
    float dG = length(vObj.xz - vec2(0.0, uMark.y)) * 0.8;
    float mkR = uMark.z * (1.0 + 0.45 * rival);
    mk = (1.0 - smoothstep(mkR * 0.8, mkR, min(dT * 1.25, dG))) * step(0.15, vMisc.w) * isBodyPart * step(0.5, aPart);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * (0.5 + mkCol * 1.3) + mkCol * 0.022, rival * (1.0 - isEye) * (1.0 - isWing));
    diffuseColor.rgb = mix(diffuseColor.rgb, mkCol, mk);
  }
  float inf = 0.0;
  float fuzz = 0.0;
  float pal = 0.0;
  if (infect > 0.001) {
    // stage 1: pallor — the cuticle goes dull and dusty, like a bloom on a grape
    pal = smoothstep(0.0, 0.5, infect) * (1.0 - isWing) * (1.0 - isEye);
    float dl = dot(diffuseColor.rgb, vec3(0.3, 0.6, 0.1));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dl) * vec3(1.2, 1.15, 1.0) + vec3(0.13, 0.125, 0.105) * (0.6 + 0.8 * n2), pal * 0.6);
    // stage 2+: mycelium creeps out of the joints (low baked AO) and spreads over the body
    float m = antNoise(vObj * 7.0 + seedF * 3.0) * 0.6 + n1 * 0.25 + (1.0 - vBody.w) * 0.25 * (1.0 - isWing);
    float thr = 1.27 - infect;
    inf = smoothstep(thr, thr + 0.12, m) * step(0.3, infect);
    fuzz = inf * smoothstep(0.7, 1.0, infect);
    // fibrous, felted look: stretched noise threads
    float fib = antNoise(vec3(vObj.x * 160.0, vObj.y * 30.0, vObj.z * 160.0) + seedF) * 0.6 + antNoise(vObj * 90.0) * 0.4;
    vec3 myc = mix(vec3(0.27, 0.28, 0.24), vec3(0.6, 0.61, 0.54), fib);
    diffuseColor.rgb = mix(diffuseColor.rgb, myc, inf * 0.9);
  }
  // carried / dropped leaf fragments (look.leaf): the blade lies in object XY, midrib along X
  float leafThin = 1.0;
  if (uLeaf > 0.5) {
    vec2 lp = vObj.xy;
    float mid = exp(-lp.y * lp.y * 2200.0);
    float sv = abs(fract(lp.x * 6.5 + abs(lp.y) * 3.4 + 0.25) - 0.5);
    float side = (1.0 - smoothstep(0.018, 0.055, sv)) * smoothstep(0.01, 0.06, abs(lp.y));
    // tertiary net between the side veins
    float net = antNoise(vObj * 46.0);
    float retic = (1.0 - smoothstep(0.0, 0.07, abs(net - 0.5))) * 0.45;
    float vein = max(max(mid, side * 0.85), retic);
    vec3 lam = diffuseColor.rgb * (0.7 + 0.6 * n2) * mix(vec3(0.86, 1.0, 0.8), vec3(1.2, 1.06, 0.62), smoothstep(0.35, 0.8, antNoise(vObj * 5.0 + seedF * 9.0)));
    lam *= 0.86 + 0.28 * smoothstep(0.3, 0.7, antNoise(vObj * 150.0)); // epidermal cells
    diffuseColor.rgb = mix(lam, lam * 1.8 + vec3(0.035, 0.055, 0.0), vein * 0.75);
    // the margin (AO channel 0.5 at the rim): a bruised, drying rim — strongest on the cut side
    float rim = 1.0 - smoothstep(0.5, 0.92, vBody.w);
    float cutSide = smoothstep(0.05, -0.12, lp.y);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3, 0.22, 0.05) * (0.6 + 0.8 * n1), rim * (0.3 + 0.55 * cutSide));
    leafThin = (1.0 - 0.8 * max(mid, side * 0.85)) * (1.0 - 0.5 * rim);
  }
  float glue = 0.0;
  if (vFx.x > 0.001) {
    // nasute glue: pale strings sagging down the body
    float gs = antNoise(vec3(vObj.x * 46.0, vObj.y * 5.0, vObj.z * 46.0) + seedF * 7.0);
    float gk = min(1.0, vFx.x * 1.7);
    // blobs where it landed (upper side of the body) running into strings down the flanks
    float gb = antNoise(vObj * 11.0 + seedF * 3.0);
    float gm = gs * 0.6 + 0.2 * n2 + 0.3 * gb + 0.22 * vMisc.w;
    glue = smoothstep(0.8 - 0.26 * gk, 0.88 - 0.26 * gk, gm) * (1.0 - isEye);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.74, 0.69, 0.47) * (0.8 + 0.4 * gb), glue * 0.88);
  }
  diffuseColor.rgb *= 1.0 - 0.25 * uWetness;
`;

const FRAG_ROUGH = /* glsl */ `
  roughnessFactor = clamp(roughnessFactor + (isGaster > 0.5 ? -0.08 : 0.05) + (n1 - 0.5) * 0.2, 0.04, 1.0);
  roughnessFactor = mix(roughnessFactor, 0.05, isEye);
  roughnessFactor = mix(roughnessFactor, 0.18, isWing);
  roughnessFactor = mix(roughnessFactor, 0.9, max(max(inf, pal * 0.7), mk * 0.5));
  roughnessFactor = mix(roughnessFactor, 0.3, glue);
  roughnessFactor *= 1.0 - 0.5 * uWetness;
`;

const FRAG_NORMAL = /* glsl */ `
  {
    // fine cuticle pitting; fades out once a pit is smaller than a pixel
    float fw = length(fwidth(vObj)) * 70.0;
    float fade = (1.0 - smoothstep(0.25, 0.9, fw)) * (1.0 - isEye) * (1.0 - isWing) * (1.0 - 0.75 * uNightK);
    if (fade > 0.001) {
      float h = antNoise(vObj * 70.0) * 0.6 + antNoise(vObj * 170.0) * 0.4;
      h = mix(h, antNoise(vObj * 24.0) * 3.0 + antNoise(vObj * 120.0) * 1.5, inf);
      vec3 sx = dFdx(-vViewPosition);
      vec3 sy = dFdy(-vViewPosition);
      vec3 r1 = cross(sy, normal);
      vec3 r2 = cross(normal, sx);
      float det = dot(sx, r1);
      vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
      normal = normalize(abs(det) * normal - uDetail * fade * length(sx) * grad);
    }
  }
`;

const FRAG_AO = /* glsl */ `
  {
    float bao = mix(vBody.w, 1.0, isWing);
    // the scene environment is open sky: fade it for instances that are under cover
    float envOcc = 0.15 + 0.85 * vMisc.y;
    reflectedLight.indirectDiffuse *= bao * (0.55 + 0.45 * vMisc.y);
    reflectedLight.indirectSpecular *= mix(1.0, bao, 0.75) * envOcc;
    #ifdef USE_CLEARCOAT
      clearcoatSpecularIndirect *= envOcc;
    #endif
    #ifdef USE_SHEEN
      sheenSpecularIndirect *= envOcc;
    #endif
    reflectedLight.directDiffuse *= mix(1.0, bao, 0.3);
  }
`;

const FRAG_OUT = /* glsl */ `
  {
    vec3 V = normalize(vViewPosition);
    float ndv = saturate(dot(nonPerturbedNormal, V));
    float fres = pow(1.0 - ndv, 3.0);
    vec3 Ls = normalize(vSunV);
    // backlit translucency: amber gasters (repletes), waxy termites, green aphids
    float trMask = max(isGaster, uSurf.z) * (1.0 - isEye) * (1.0 - isWing) * (1.0 - mk);
    float back = pow(saturate(dot(-V, Ls)), 2.5);
    float wrap = saturate(dot(-nonPerturbedNormal, Ls) * 0.6 + 0.4);
    outgoingLight += uSunColor * uTransl.rgb * uTransl.a * uTranslK * trMask * sunlit * tergite * (back * (0.5 + 1.2 * (1.0 - ndv)) + wrap * mix(0.22, 0.75, uLeaf)) * mix(1.0, 0.25 + 1.3 * leafThin, uLeaf);
    // waxy soft bodies never go fully dark in their own shadow
    outgoingLight += diffuseColor.rgb * uTransl.rgb * uSurf.y * 0.1 * (0.15 + 0.85 * sunlit) * (1.0 - isEye);
    {
      // analytic sky dome in the clearcoat with a bright zenith "softbox" — the broad highlight
      // that makes chitin read as chitin in macro photography. With a scene environment map the
      // gradient part is mostly left to the real reflection.
      vec3 Rw = inverseTransformDirection(reflect(-V, nonPerturbedNormal), viewMatrix);
      float skyK = smoothstep(-0.25, 0.45, Rw.y);
      #ifdef USE_ENVMAP
        vec3 envC = mix(uGroundC * 0.6, uSkyC, skyK) * 0.45 + uSkyC * 1.5 * smoothstep(0.55, 0.85, Rw.y);
      #else
        vec3 envC = mix(uGroundC * 0.6, uSkyC, skyK) + uSkyC * 1.5 * smoothstep(0.55, 0.85, Rw.y);
      #endif
      float Fc = 0.05 + 0.95 * pow(1.0 - ndv, 5.0);
      float gloss = (1.0 - roughnessFactor) * (1.0 - roughnessFactor);
      #ifdef USE_CLEARCOAT
        float coat = max(material.clearcoat, isEye);
      #else
        float coat = isEye;
      #endif
      outgoingLight += envC * (Fc * (0.3 + 0.7 * coat) + 0.16 * coat * gloss) * (0.3 + 0.7 * gloss) * (0.06 + 0.94 * sunlit) * mix(vBody.w, 1.0, isWing) * (1.0 - 0.8 * inf) * (1.0 - 0.7 * pal) * (1.0 - mk);
    }
    // rim: reads the silhouette against soil; stronger at far zoom for readability
    float dist = length(vViewPosition);
    float farK = smoothstep(14.0, 70.0, dist);
    vec3 rimC = mix(vec3(0.5, 0.6, 0.72), uSunColor, 0.45) * (0.06 + 0.94 * sunlit);
    outgoingLight += rimC * fres * uSurf.w * (0.3 + 1.1 * farK);
    outgoingLight += mkCol * (fres * 0.6 + 0.1) * max(farK, 0.13 * rival) * uMark.w * (0.25 + 0.75 * sunlit);
    outgoingLight += mkCol * mk * 0.12;
    // moonlight: a cool wrap so bodies read as shapes at night, not as stray speculars
    outgoingLight += uNightK * vec3(0.016, 0.022, 0.04) * (0.35 + 1.6 * pow(1.0 - ndv, 1.5)) * (0.25 + 0.75 * sunlit) * (1.0 - isEye);
    // mycelium: felted back-scatter on the silhouette, a faint sickly glow once it fruits
    outgoingLight += (uSunColor * 0.22 + uSkyC * 0.3) * vec3(0.9, 0.95, 0.85) * fuzz * pow(1.0 - ndv, 1.5) * (0.2 + 0.8 * sunlit);
    outgoingLight += vec3(0.25, 0.9, 0.5) * inf * smoothstep(0.6, 1.0, infect) * (0.035 + 0.1 * uNightK) * (0.8 + 0.2 * sin(uTime * 3.0 + seedF * 30.0));
    float hl = vInstC.w;
    outgoingLight += vec3(1.0, 0.95, 0.8) * max(hl, 0.0) * (fres * 1.3 + 0.05);
    outgoingLight += vec3(1.0, 0.12, 0.05) * max(-hl, 0.0) * (fres * 0.75 + 0.04);
    float lum = dot(outgoingLight, vec3(0.3, 0.6, 0.1));
    outgoingLight = mix(outgoingLight, vec3(lum * 0.3) + vec3(0.2, 0.5, 0.65) * fres * 0.5, uPheroVision * 0.85);
    // pheromone vision: infection reads as a green-violet warning
    outgoingLight += uPheroVision * infect * (inf * 0.8 + 0.12) * mix(vec3(0.3, 1.0, 0.5), vec3(0.6, 0.3, 1.0), 0.5 + 0.5 * sin(uTime * 2.0 + seedF * 20.0));
  }
`;

/** Sky colours for the analytic reflection used when the scene has no environment map. */
export const chitinEnv = { uSkyC: { value: new THREE.Color(0.6, 0.75, 0.95) }, uGroundC: { value: new THREE.Color(0.25, 0.2, 0.15) }, uNightK: { value: 0 }, uTranslK: { value: 1 } };

export interface ChitinUniforms {
  [name: string]: THREE.IUniform;
  uNeck: THREE.IUniform<THREE.Vector3>;
  uWaist: THREE.IUniform<THREE.Vector3>;
  uGait: THREE.IUniform<THREE.Vector4>;
  uAnimP: THREE.IUniform<THREE.Vector4>;
  uSurf: THREE.IUniform<THREE.Vector4>;
  uTransl: THREE.IUniform<THREE.Vector4>;
  uMark: THREE.IUniform<THREE.Vector4>;
  uDetail: THREE.IUniform<number>;
  uLeaf: THREE.IUniform<number>;
}

export interface ChitinMaterials {
  material: THREE.MeshPhysicalMaterial;
  /** Alpha-blended variant for wing membranes (geometry group 1 of winged kinds). */
  wingMaterial: THREE.MeshPhysicalMaterial;
  depthMaterial: THREE.MeshDepthMaterial;
  /** Per-kind uniforms (shared by both materials). `uMark.w` toggles colony paint dots. */
  uniforms: ChitinUniforms;
  dispose(): void;
}

export interface ChitinOptions {
  /** First-person rig: collapse everything except antennae and mandibles. */
  firstPersonOnly?: boolean;
  /** Scale idle fidgets (0 for inert things like items). */
  idle?: number;
}

export function createChitinMaterials(look: CreatureLook, rig: CreatureRig, shared: SharedUniforms, opts: ChitinOptions = {}): ChitinMaterials {
  const uniforms: ChitinUniforms = {
    uTime: fx.uClock,
    uSunDir: shared.uSunDir,
    uSunColor: shared.uSunColor,
    uWetness: shared.uWetness,
    uPheroVision: shared.uPheroVision,
    uSkyC: chitinEnv.uSkyC,
    uGroundC: chitinEnv.uGroundC,
    uNightK: chitinEnv.uNightK,
    uTranslK: chitinEnv.uTranslK,
    uNeck: { value: new THREE.Vector3(...rig.neck) },
    uWaist: { value: new THREE.Vector3(...rig.waist) },
    uGait: { value: new THREE.Vector4(rig.stride, rig.duty, rig.lift, rig.crawl) },
    uAnimP: { value: new THREE.Vector4(1, look.sting, opts.firstPersonOnly ? 1 : 0, opts.idle ?? 1) },
    uSurf: { value: new THREE.Vector4(look.bands, look.wax, look.translucencyAll ? 1 : 0, 0.45) },
    uTransl: { value: new THREE.Vector4(look.translucencyColor[0], look.translucencyColor[1], look.translucencyColor[2], look.translucency) },
    uMark: { value: new THREE.Vector4(rig.marker[0], rig.marker[1], rig.marker[2], 0) },
    uDetail: { value: 0.9 },
    uLeaf: { value: look.leaf ?? 0 },
  };
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: look.roughness,
    metalness: 0,
    clearcoat: look.clearcoat,
    clearcoatRoughness: 0.12 + look.wax * 0.25,
    sheen: look.sheen,
    sheenRoughness: 0.45,
    sheenColor: new THREE.Color(0.55, 0.5, 0.42).multiplyScalar(look.wax > 0.5 ? 0.5 : 0.14),
    iridescence: look.iridescence,
    iridescenceIOR: 1.56,
    iridescenceThicknessMinimum: 180,
    iridescenceThicknessMaximum: 520,
    envMapIntensity: 1,
  });
  material.name = 'chitin';
  const patch = (shader: THREE.WebGLProgramParametersWithUniforms): void => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `
        vec3 antP = position;
        vec3 objectNormal = normal;
        antAnimate(antP, objectNormal);
        vBody = aBody;
        vObj = position;
        vInstC = aInstC;
        vMisc = vec4(aInstA.z, aInstA.w, aInstB.w, normal.y);
        vSunV = (viewMatrix * vec4(uSunDir, 0.0)).xyz;
        vFx = vec2(max(-aInstD.w, 0.0), max(-aInstB.z, 0.0));
        {
          // mycelium fuzz: the silhouette goes lumpy as hyphae break through the cuticle
          float fz = smoothstep(0.72, 1.0, aInstB.w);
          if (fz > 0.0) antP += objectNormal * fz * 0.022 * fract(sin(dot(position, vec3(127.1, 311.7, 74.7))) * 43758.5453);
        }
        `,
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = antP;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_COLOR}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${FRAG_ROUGH}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAG_NORMAL}`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${FRAG_AO}`)
      .replace('#include <opaque_fragment>', `${FRAG_OUT}\n#include <opaque_fragment>`);
  };
  material.onBeforeCompile = patch;
  material.customProgramCacheKey = () => 'chitin-v2';
  applyCutPlane(material, shared, { entity: true });

  const wingMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.2,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.1,
    iridescence: 1,
    iridescenceIOR: 1.4,
    iridescenceThicknessMinimum: 150,
    iridescenceThicknessMaximum: 600,
    transparent: true,
    // membranes write depth: wings of one swarm no longer sort through each other
    depthWrite: true,
  });
  wingMaterial.name = 'chitin-wing';
  wingMaterial.defines = { ...wingMaterial.defines, WING_BLEND: '' };
  wingMaterial.onBeforeCompile = patch;
  wingMaterial.customProgramCacheKey = () => 'chitin-wing-v2';
  applyCutPlane(wingMaterial, shared, { entity: true });

  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depthMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#define ANT_DEPTH\n#include <common>\n${VERT_PARS}`)
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        vec3 antP = position;
        vec3 antN = vec3(0.0, 1.0, 0.0);
        antAnimate(antP, antN);
        vBody = aBody;
        vec3 transformed = antP;
        `,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vBody;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${WING_DITHER}`);
  };
  depthMaterial.customProgramCacheKey = () => 'chitin-depth-v2';
  applyCutPlane(depthMaterial, shared, { entity: true });

  return {
    material,
    wingMaterial,
    depthMaterial,
    uniforms,
    dispose() {
      material.dispose();
      wingMaterial.dispose();
      depthMaterial.dispose();
    },
  };
}

/** One InstancedMesh of a creature kind at one LOD, with the per-instance channels exposed. */
export interface InstancedCreature {
  readonly kind: CreatureGeometryKind;
  readonly lod: GeometryLod;
  readonly rig: CreatureRig;
  readonly look: CreatureLook;
  mesh: THREE.InstancedMesh;
  capacity: number;
  matrix: Float32Array;
  color: Float32Array;
  a: Float32Array;
  b: Float32Array;
  c: Float32Array;
  /** Pose channel (crouch/splay, strike, head yaw, thrash/stuck) — zero unless written. */
  d: Float32Array;
  /** Makes room for at least `n` instances (reallocates buffers; existing data is NOT kept). */
  ensure(n: number): void;
  /** Uploads the first `n` instances and sets the draw count. */
  commit(n: number): void;
  dispose(): void;
}

const materialCache = new WeakMap<SharedUniforms, Map<string, ChitinMaterials>>();

/** Materials are shared per kind (all LODs of a kind have the same rig constants). */
export function getChitinMaterials(kind: CreatureGeometryKind, shared: SharedUniforms, opts: ChitinOptions = {}): ChitinMaterials {
  let byKind = materialCache.get(shared);
  if (!byKind) materialCache.set(shared, (byKind = new Map()));
  const key = `${kind}|${opts.firstPersonOnly ? 1 : 0}|${opts.idle ?? 1}`;
  let m = byKind.get(key);
  if (!m) {
    m = createChitinMaterials(getCreatureLook(kind), getCreatureGeometry(kind, 1).userData.rig as CreatureRig, shared, opts);
    byKind.set(key, m);
  }
  return m;
}

/** Drops every cached chitin material for these shared uniforms (called by the ants module on dispose). */
export function disposeChitinMaterials(shared: SharedUniforms): void {
  const byKind = materialCache.get(shared);
  if (!byKind) return;
  for (const m of byKind.values()) m.dispose();
  materialCache.delete(shared);
}

/** Disposes a wrapper geometry without releasing the registry's shared vertex/index buffers. */
function disposeWrapper(g: THREE.BufferGeometry, src: THREE.BufferGeometry): void {
  for (const name of Object.keys(src.attributes)) g.deleteAttribute(name);
  g.setIndex(null);
  g.dispose();
}

export function createInstancedCreature(kind: CreatureGeometryKind, lod: GeometryLod, capacity: number, shared: SharedUniforms, opts: ChitinOptions = {}): InstancedCreature {
  const src = getCreatureGeometry(kind, lod);
  const mats = getChitinMaterials(kind, shared, opts);
  const inst: InstancedCreature = {
    kind,
    lod,
    rig: src.userData.rig as CreatureRig,
    look: getCreatureLook(kind),
    mesh: null as unknown as THREE.InstancedMesh,
    capacity: 0,
    matrix: new Float32Array(0),
    color: new Float32Array(0),
    a: new Float32Array(0),
    b: new Float32Array(0),
    c: new Float32Array(0),
    d: new Float32Array(0),
    ensure(n: number) {
      if (n <= inst.capacity) return;
      const parent = inst.mesh?.parent ?? null;
      const old = inst.mesh;
      const cap = Math.max(n, Math.ceil(inst.capacity * 1.6), 8);
      // wrap the shared geometry: same vertex buffers, own instanced attributes
      const g = new THREE.BufferGeometry();
      g.setIndex(src.index);
      for (const name of Object.keys(src.attributes)) g.setAttribute(name, src.attributes[name]);
      g.boundingSphere = src.boundingSphere;
      g.boundingBox = src.boundingBox;
      for (const gr of src.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
      const mk = (size: number, name: string): Float32Array => {
        const arr = new Float32Array(cap * size);
        const attr = new THREE.InstancedBufferAttribute(arr, size);
        attr.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute(name, attr);
        return arr;
      };
      inst.a = mk(4, 'aInstA');
      inst.b = mk(4, 'aInstB');
      inst.c = mk(4, 'aInstC');
      inst.d = mk(4, 'aInstD');
      const mesh = new THREE.InstancedMesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>(g, src.groups.length ? [mats.material, mats.wingMaterial] : mats.material, cap);
      mesh.name = `creature:${kind}:${lod}`;
      mesh.frustumCulled = false; // instances are culled manually
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = mats.depthMaterial;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      if (old) {
        mesh.visible = old.visible;
        mesh.renderOrder = old.renderOrder;
        mesh.castShadow = old.castShadow;
        old.removeFromParent();
        disposeWrapper(old.geometry, src);
        old.dispose();
      }
      inst.mesh = mesh;
      inst.capacity = cap;
      inst.matrix = mesh.instanceMatrix.array as Float32Array;
      inst.color = mesh.instanceColor.array as Float32Array;
      if (parent) parent.add(mesh);
    },
    commit(n: number) {
      const mesh = inst.mesh;
      mesh.count = n;
      mesh.visible = n > 0;
      if (n === 0) return;
      const up = (attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, size: number): void => {
        const a = attr as THREE.BufferAttribute;
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * size);
        a.needsUpdate = true;
      };
      up(mesh.instanceMatrix, 16);
      up(mesh.instanceColor!, 3);
      up(mesh.geometry.attributes.aInstA, 4);
      up(mesh.geometry.attributes.aInstB, 4);
      up(mesh.geometry.attributes.aInstC, 4);
      up(mesh.geometry.attributes.aInstD, 4);
    },
    dispose() {
      inst.mesh.removeFromParent();
      disposeWrapper(inst.mesh.geometry, src);
      inst.mesh.dispose();
    },
  };
  inst.ensure(capacity);
  return inst;
}
