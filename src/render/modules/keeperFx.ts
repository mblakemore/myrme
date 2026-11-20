import * as THREE from 'three';
import { b3StateOf, type AnySimEvent, type FrameInfo, type KeeperFoodKind, type Vec3 } from '../../core';
import type { Module, RenderContext } from '../shared';
import { createInstancedCreature, type InstancedCreature } from './antsMaterial';
import { writeSurfaceMatrix } from './antsShared';
import { fungusLook } from './fungusFx';
import { fx, fxDemo, fxDesat, fxKick, fxKnob, fxRevealAt } from './fxShared';
import { GlowBatch } from './keeperGlow';
import { buildFingerGeometry, buildHandGeometry, buildLampShade, buildPipetteGeometry, buildTweezerBlade } from './keeperHand';
import { createNuptialFx, type NuptialFx } from './nuptialFx';
import { particles } from './particles';
import { getEnv } from './skyEnv';

/**
 * Keeper FX (§2 farm maps, §5.3 FX; B4) — the unseen human who owns the ant farm, at ant scale:
 *
 *  - food / water drops: the lid port flips open (a shaft of room light falls in), a GIANT soft
 *    hand lowers tweezers (food) or a pipette (water) through it, lets go, and withdraws. The
 *    hand is drawn as a shrunken opaque core + a fresnel-faded shell, so its silhouette is soft
 *    even without DoF. Food tumbles down from the tweezers (visual only; the sim's own food
 *    source / item is what the ants use).
 *  - desk lamp: a lamp head hangs over the farm; switching it on fades in a warm spot light, a
 *    visible light cone with drifting dust, and warms the grade (`fx.warm`).
 *  - glass tap / shake: a huge fingertip flicks the front pane, ripple rings spread over the glass,
 *    dust trickles from tunnel ceilings, the camera jolts (`fxKick`).
 *  - tube port: a vinyl tube leaves the frame at the `tubePort` site; opening it flashes and then
 *    breathes a soft glow at the port.
 *  - lid / room light: `fx.exposure` lifts slightly while the lid is open and with the lamp.
 *
 * On outdoor maps the module only runs the shared moments: nuptial flight (`nuptialFx.ts`),
 * queen death / lose desaturation (`fxDesat`), win bloom — and it sums `fx.bloom` for the frame.
 *
 * Sim inputs: events `keeperEvent` (B3: action, pos, on, food) with the frozen `keeper` event as a
 * fallback; `b3StateOf(sim).keeper.{lampOn,lampPos,tubeOpen,tubePos,panic}`, `weather.lamp`;
 * map site `tubePort`; `antDied` (queen), `colonyDied`, `lose`, `win`, B3 `gameEnd`.
 *
 * Demos (`?fxdemo=` / `__myrmeFx.demo`): `hand` (loops a food drop at the drop zone), `pipette`
 * (loops a water drop), `lamp` (lamp on), `tap` (loops a glass tap at the camera focus), `tube`
 * (tube open), `desat` (holds the queen-death desaturation). `__myrmeFx.handT` (seconds) freezes
 * the drop animation at that time for stills.
 */

const DROP_TIME = 3.6;
const TAP_TIME = 1.6;
const MAX_TAPS = 3;
const PIECES = 6;

const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

const SHAFT_FRAG = /* glsl */ `
uniform float uK;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float a = smoothstep(0.0, 0.7, across) * (0.25 + 0.75 * vUv.y) * smoothstep(0.0, 0.12, vUv.y);
  gl_FragColor = vec4(uColor * a * uK, 0.0);
}`;
const UV_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vW;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const RIPPLE_FRAG = /* glsl */ `
uniform vec4 uTaps[${MAX_TAPS}]; // pane-space x, y, start clock, strength
uniform float uClock;
uniform vec2 uPaneSize;
varying vec2 vUv;
void main() {
  vec2 p = vUv * uPaneSize;
  float sum = 0.0;
  for (int i = 0; i < ${MAX_TAPS}; i++) {
    float age = uClock - uTaps[i].z;
    if (age < 0.0 || age > 1.5 || uTaps[i].w <= 0.0) continue;
    float d = length(p - uTaps[i].xy);
    float front = age * 46.0;
    float env = exp(-age * 3.2) * uTaps[i].w;
    // a sharp leading ring and a train of fading ripples behind it
    float ring = exp(-pow((d - front) * 0.55, 2.0));
    float train = (0.5 + 0.5 * sin((d - front) * 1.9)) * smoothstep(front, front - 16.0, d) * step(d, front) * exp(-(front - d) * 0.11);
    float contact = exp(-d * d * 0.25) * exp(-age * 14.0) * 2.5;
    sum += (ring * 0.9 + train * 0.45 + contact) * env;
  }
  if (sum < 0.003) discard;
  gl_FragColor = vec4(vec3(0.75, 0.9, 1.0) * sum * 0.6, 0.0);
}`;

const CONE_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying float vAlong;
void main() {
  vAlong = uv.y;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - w.xyz);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const CONE_FRAG = /* glsl */ `
uniform float uK;
uniform vec3 uColor;
varying vec3 vN;
varying vec3 vV;
varying float vAlong;
void main() {
  // thickest through the middle of the cone, vanishing at the silhouette
  float f = abs(dot(normalize(vN), normalize(vV)));
  float a = f * f * (0.08 + 0.92 * vAlong * vAlong) * smoothstep(0.0, 0.06, 1.0 - vAlong);
  gl_FragColor = vec4(uColor * a * uK, 0.0);
}`;

const DUST_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uClock;
uniform float uPx;
uniform float uLen;
uniform float uTan;
varying float vA;
void main() {
  float t = uClock * (0.012 + 0.02 * aSeed.w) + aSeed.y;
  float along = fract(t);
  float ang = aSeed.x * 6.283 + uClock * (0.15 + 0.3 * aSeed.z) * (aSeed.w > 0.5 ? 1.0 : -1.0);
  float rad = sqrt(aSeed.z) * along * uLen * uTan * 0.92;
  vec3 p = vec3(cos(ang) * rad, -along * uLen, sin(ang) * rad);
  p.xz += vec2(sin(uClock * 0.7 + aSeed.w * 40.0), cos(uClock * 0.53 + aSeed.x * 30.0)) * 0.6;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(uClock * (1.5 + 3.0 * aSeed.w) + aSeed.x * 80.0), 3.0);
  vA = tw * smoothstep(0.0, 0.08, along) * smoothstep(1.0, 0.75, along);
  gl_PointSize = clamp(uPx * (0.3 + 0.6 * aSeed.w) / max(-mv.z, 0.1), 2.0, 18.0);
}`;
const DUST_FRAG = /* glsl */ `
uniform float uK;
uniform vec3 uColor;
varying float vA;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float a = smoothstep(1.0, 0.0, length(p));
  gl_FragColor = vec4(uColor * a * a * vA * uK, 0.0);
}`;

const ADDITIVE = {
  transparent: true,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
} as const;

/** Opaque shrunken core + fresnel-faded expanded shell = a soft, defocused-looking solid. */
function softSkinMaterials(soft: number): { core: THREE.MeshStandardMaterial; shell: THREE.MeshStandardMaterial } {
  const core = new THREE.MeshStandardMaterial({ color: 0xc9c2bd, vertexColors: true, roughness: 0.6, metalness: 0, side: THREE.DoubleSide });
  core.name = 'keeper-skin';
  core.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `vec3 transformed = position - objectNormal * ${(soft * 0.55).toFixed(3)};`);
    // cheap subsurface: skin never goes cold-black in its own shadow
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vec3(0.1, 0.03, 0.018);');
  };
  core.customProgramCacheKey = () => 'keeper-skin-core';
  const shell = new THREE.MeshStandardMaterial({ color: 0xc9c2bd, vertexColors: true, roughness: 0.6, metalness: 0, transparent: true, depthWrite: false });
  shell.name = 'keeper-skin-shell';
  shell.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `vec3 transformed = position + objectNormal * ${(soft * 0.7).toFixed(3)};`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vec3(0.1, 0.03, 0.018);')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.a *= smoothstep(0.02, 0.62, abs(dot(normalize(vNormal), normalize(vViewPosition))));');
  };
  shell.customProgramCacheKey = () => 'keeper-skin-shell';
  return { core, shell };
}

interface Drop {
  active: boolean;
  t0: number;
  water: boolean;
  /** Landing point, slab space. */
  x: number;
  y: number;
  z: number;
  released: boolean;
  food: KeeperFoodKind | '';
}

interface Farm {
  group: THREE.Group;
  W: number;
  H: number;
  T: number;
  axisX: boolean;
  hand: THREE.Group;
  handParts: THREE.Mesh[];
  tweezers: THREE.Group;
  bladeA: THREE.Mesh;
  bladeB: THREE.Mesh;
  pipette: THREE.Mesh;
  bead: THREE.Mesh;
  finger: THREE.Group;
  port: THREE.Mesh;
  flap: THREE.Mesh;
  shaft: THREE.Mesh;
  shaftU: { uK: THREE.IUniform<number>; uColor: THREE.IUniform<THREE.Color> };
  ripple: THREE.Mesh;
  rippleU: { uTaps: THREE.IUniform<THREE.Vector4[]>; uClock: THREE.IUniform<number>; uPaneSize: THREE.IUniform<THREE.Vector2> };
  lamp: THREE.Group;
  bulb: THREE.Mesh;
  bulbMat: THREE.MeshBasicMaterial;
  cone: THREE.Mesh;
  coneU: { uK: THREE.IUniform<number>; uColor: THREE.IUniform<THREE.Color> };
  dust: THREE.Points;
  dustU: { uK: THREE.IUniform<number>; uPx: THREE.IUniform<number> };
  spot: THREE.SpotLight;
  tube: THREE.Mesh | null;
  tubeMat: THREE.MeshStandardMaterial | null;
  tubePos: THREE.Vector3 | null;
  pieces: InstancedCreature;
  glow: GlowBatch;
}

export function createKeeperFxModule(): Module {
  let farm: Farm | null = null;
  let nuptial: NuptialFx | null = null;
  const disposables: { dispose(): void }[] = [];
  const drop: Drop = { active: false, t0: -1e6, water: false, x: 0, y: 0, z: 0, released: false, food: '' };
  const taps: { t0: number; x: number; y: number; k: number; dusted: boolean }[] = [];
  let lampK = 0;
  let lampEvent = false;
  let tubeK = 0;
  let tubeFlash = -1e6;
  let tubeEvent = false;
  let lidK = 0;
  let winT = -1e6;
  let lost = false;
  let demoNext = 0;
  let lastMaxId = 0;
  let seed = 24681357;
  const rand = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 8) / 16777216;
  };
  const p: Vec3 = { x: 0, y: 0, z: 0 };
  const dn: Vec3 = { x: 0, y: -1, z: 0 };
  const lampPos = new THREE.Vector3();
  const lampAim = new THREE.Vector3();
  const _v = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _down = new THREE.Vector3(0, -1, 0);

  /** World → slab space (x along the pane, z across the slab; the front pane is at z = T). */
  function toSlab(f: Farm, w: Readonly<Vec3>, out: THREE.Vector3): THREE.Vector3 {
    return f.axisX ? out.set(w.z, w.y, f.T - w.x) : out.set(w.x, w.y, w.z);
  }
  function fromSlab(f: Farm, x: number, y: number, z: number, out: Vec3): Vec3 {
    if (f.axisX) {
      out.x = f.T - z;
      out.y = y;
      out.z = x;
    } else {
      out.x = x;
      out.y = y;
      out.z = z;
    }
    return out;
  }

  function buildFarm(ctx: RenderContext): Farm {
    const world = ctx.sim.world;
    const axisX = ctx.map.flags.slabAxis === 'x';
    const W = axisX ? world.sz : world.sx;
    const H = world.sy;
    const T = axisX ? world.sx : world.sz;
    const low = ctx.quality.preset === 'low';
    const group = new THREE.Group();
    group.name = 'keeper';
    if (axisX) {
      group.rotation.y = -Math.PI / 2;
      group.position.x = T;
    }
    ctx.scene.add(group);
    const own = <T2 extends { dispose(): void }>(d: T2): T2 => {
      disposables.push(d);
      return d;
    };

    // ---- hand + tools -----------------------------------------------------------------------
    const skin = softSkinMaterials(0.7);
    own(skin.core);
    own(skin.shell);
    const handGeo = own(buildHandGeometry());
    const hand = new THREE.Group();
    hand.name = 'keeper:hand';
    const handCore = new THREE.Mesh(handGeo, skin.core);
    handCore.castShadow = true;
    const handShell = new THREE.Mesh(handGeo, skin.shell);
    handShell.renderOrder = 21;
    hand.add(handCore, handShell);
    const steel = own(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.28, metalness: 0.9, side: THREE.DoubleSide }));
    const bladeGeo = own(buildTweezerBlade());
    const tweezers = new THREE.Group();
    tweezers.position.set(0, 13, 0);
    const bladeA = new THREE.Mesh(bladeGeo, steel);
    const bladeB = new THREE.Mesh(bladeGeo, steel);
    bladeB.scale.x = -1;
    bladeA.castShadow = bladeB.castShadow = true;
    tweezers.add(bladeA, bladeB);
    const pipMat = own(new THREE.MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08 }));
    const pipette = new THREE.Mesh(own(buildPipetteGeometry()), pipMat);
    pipette.castShadow = true;
    const beadMat = own(new THREE.MeshPhysicalMaterial({ color: new THREE.Color(0.55, 0.78, 0.95), roughness: 0.03, metalness: 0, clearcoat: 1, transparent: true, opacity: 0.8 }));
    const bead = new THREE.Mesh(own(new THREE.SphereGeometry(1, 16, 12)), beadMat);
    bead.position.set(0, -17.4, 0);
    hand.add(tweezers, pipette, bead);
    hand.visible = false;
    group.add(hand);

    const finger = new THREE.Group();
    finger.name = 'keeper:finger';
    const fingerGeo = own(buildFingerGeometry());
    const fCore = new THREE.Mesh(fingerGeo, skin.core);
    const fShell = new THREE.Mesh(fingerGeo, skin.shell);
    fShell.renderOrder = 21;
    finger.add(fCore, fShell);
    finger.visible = false;
    group.add(finger);

    // ---- lid port, flap, light shaft ----------------------------------------------------
    const depth = T + 2.4;
    const portMat = own(new THREE.MeshBasicMaterial({ color: 0x030405 }));
    const port = new THREE.Mesh(own(new THREE.BoxGeometry(11, 2.66, depth + 0.1)), portMat);
    port.visible = false;
    const flapMat = own(new THREE.MeshStandardMaterial({ color: 0x23272c, roughness: 0.45, metalness: 0.2 }));
    const flapGeo = own(new THREE.BoxGeometry(11, 0.5, depth));
    flapGeo.translate(5.5, 0.25, 0); // hinge on its left edge
    const flap = new THREE.Mesh(flapGeo, flapMat);
    flap.castShadow = true;
    flap.visible = false;
    const shaftU = { uK: { value: 0 }, uColor: { value: new THREE.Color(1, 0.93, 0.8) } };
    const shaftGeo = own(new THREE.PlaneGeometry(1, 1));
    const sp = shaftGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < sp.count; i++) if (sp.getY(i) < 0) sp.setX(i, sp.getX(i) * 2.1); // flares towards the floor
    const shaft = new THREE.Mesh(shaftGeo, own(new THREE.ShaderMaterial({ vertexShader: UV_VERT, fragmentShader: SHAFT_FRAG, uniforms: shaftU, side: THREE.DoubleSide, ...ADDITIVE })));
    shaft.renderOrder = 19;
    shaft.visible = false;
    group.add(port, flap, shaft);

    // ---- glass ripple -------------------------------------------------------------------------
    const rippleU = { uTaps: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] }, uClock: fx.uClock, uPaneSize: { value: new THREE.Vector2(W, H) } };
    const ripple = new THREE.Mesh(own(new THREE.PlaneGeometry(W, H)), own(new THREE.ShaderMaterial({ vertexShader: UV_VERT, fragmentShader: RIPPLE_FRAG, uniforms: rippleU, side: THREE.DoubleSide, ...ADDITIVE })));
    ripple.position.set(W / 2, H / 2, T + 0.07);
    ripple.renderOrder = 21;
    ripple.visible = false;
    group.add(ripple);

    // ---- desk lamp --------------------------------------------------------------------------------
    const lamp = new THREE.Group();
    lamp.name = 'keeper:lamp';
    const shadeMat = own(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.35, metalness: 0.35, side: THREE.DoubleSide }));
    const shade = new THREE.Mesh(own(buildLampShade()), shadeMat);
    shade.castShadow = false;
    const bulbMat = own(new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false }));
    const bulb = new THREE.Mesh(own(new THREE.SphereGeometry(2.3, 16, 12)), bulbMat);
    bulb.position.set(0, -4.2, 0);
    const CONE_LEN = Math.max(70, H * 1.5);
    const CONE_TAN = Math.tan(0.42);
    const coneGeo = own(new THREE.ConeGeometry(CONE_LEN * CONE_TAN, CONE_LEN, 40, 1, true));
    coneGeo.translate(0, -CONE_LEN / 2, 0); // apex at the bulb, opening along −Y; uv.y = 1 at the apex
    const coneU = { uK: { value: 0 }, uColor: { value: new THREE.Color(1.0, 0.74, 0.42) } };
    const cone = new THREE.Mesh(coneGeo, own(new THREE.ShaderMaterial({ vertexShader: CONE_VERT, fragmentShader: CONE_FRAG, uniforms: coneU, side: THREE.DoubleSide, ...ADDITIVE })));
    cone.position.set(0, -3, 0);
    cone.renderOrder = 23;
    cone.visible = false;
    const nDust = low ? 120 : 420;
    const seeds = new Float32Array(nDust * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = rand();
    const dustGeo = own(new THREE.BufferGeometry());
    dustGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nDust * 3), 3));
    dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    dustGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const dustU = { uK: { value: 0 }, uPx: { value: 500 } };
    const dust = new THREE.Points(dustGeo, own(new THREE.ShaderMaterial({ vertexShader: DUST_VERT, fragmentShader: DUST_FRAG, uniforms: { ...dustU, uClock: fx.uClock, uLen: { value: CONE_LEN * 0.8 }, uTan: { value: CONE_TAN }, uColor: coneU.uColor }, ...ADDITIVE })));
    dust.position.set(0, -3, 0);
    dust.frustumCulled = false;
    dust.renderOrder = 24;
    dust.visible = false;
    lamp.add(shade, bulb, cone, dust);
    group.add(lamp);
    const spot = new THREE.SpotLight(new THREE.Color(1.0, 0.74, 0.44), 0, 0, 0.5, 0.75, 0);
    spot.name = 'keeper-lamp';
    spot.castShadow = false;
    group.add(spot, spot.target);

    // ---- tube ---------------------------------------------------------------------------------------
    let tube: THREE.Mesh | null = null;
    let tubeMat: THREE.MeshStandardMaterial | null = null;
    let tubePos: THREE.Vector3 | null = null;
    const site = getEnv(ctx).mapExtras?.sites.find((s) => s.kind === 'tubePort');
    if (site) {
      tubePos = toSlab({ axisX, T } as Farm, site.pos, new THREE.Vector3());
      const dir = tubePos.x > W / 2 ? 1 : -1;
      const x0 = dir > 0 ? W + 0.2 : -0.2;
      const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(x0, tubePos.y, T / 2), new THREE.Vector3(x0 + dir * 9, tubePos.y + 0.5, T / 2), new THREE.Vector3(x0 + dir * 22, tubePos.y - 5, T / 2 - 6), new THREE.Vector3(x0 + dir * 40, tubePos.y - 26, T / 2 - 22), new THREE.Vector3(x0 + dir * 70, -8, T / 2 - 60)]);
      tubeMat = own(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.75, 0.82, 0.8), roughness: 0.12, metalness: 0, transparent: true, opacity: 0.3, emissive: new THREE.Color(1.0, 0.7, 0.3), emissiveIntensity: 0, depthWrite: false }));
      tube = new THREE.Mesh(own(new THREE.TubeGeometry(curve, 40, Math.max(1.6, site.radius * 0.9), 12, false)), tubeMat);
      tube.name = 'keeper:tube';
      tube.renderOrder = 18;
      group.add(tube);
    }

    // ---- falling food + glows ---------------------------------------------------------------------
    const pieces = createInstancedCreature('crumb', 1, PIECES + 2, ctx.uniforms, { idle: 0 });
    pieces.ensure(PIECES + 2);
    pieces.commit(0);
    pieces.mesh.name = 'keeper:food';
    ctx.scene.add(pieces.mesh);
    const glow = new GlowBatch(ctx, 48, 'keeper:glow');

    return { group, W, H, T, axisX, hand, handParts: [handCore, handShell], tweezers, bladeA, bladeB, pipette, bead, finger, port, flap, shaft, shaftU, ripple, rippleU, lamp, bulb, bulbMat, cone, coneU, dust, dustU, spot, tube, tubeMat, tubePos, pieces, glow };
  }

  function startDrop(f: Farm, ctx: RenderContext, pos: Readonly<Vec3> | null, water: boolean, food: KeeperFoodKind | ''): void {
    if (pos) toSlab(f, pos, _v);
    else {
      const site = getEnv(ctx).mapExtras?.sites.find((s) => s.kind === 'dropZone');
      if (site) toSlab(f, site.pos, _v);
      else _v.set(f.W / 2, f.H - 13, f.T / 2);
    }
    drop.active = true;
    drop.t0 = fx.clock;
    drop.water = water;
    drop.x = Math.min(f.W - 6, Math.max(6, _v.x));
    drop.y = _v.y;
    drop.z = f.T / 2;
    drop.released = false;
    drop.food = food;
    if (!water) {
      // the sim spawned the food this very tick — hold it back until the tumbling pieces land
      const tipY = f.H - 5;
      const groundY = Math.min(tipY - 2, drop.y + 0.35);
      const landAt = fx.clock + 1.5 + Math.sqrt((2 * Math.max(0, tipY - groundY)) / 34) + 0.1;
      const sim = ctx.sim;
      const fresh = (e: { id: number; alive: boolean; pos: Readonly<Vec3> }): void => {
        if (e.alive && e.id > lastMaxId && (!pos || Math.hypot(e.pos.x - pos.x, e.pos.y - pos.y, e.pos.z - pos.z) < 7)) fxRevealAt.set(e.id, landAt);
      };
      for (const fs of sim.foodSources) fresh(fs);
      for (const it of sim.items) if (!it.carriedBy) fresh(it);
    }
  }

  function startTap(f: Farm, ctx: RenderContext, pos: Readonly<Vec3> | null, k: number): void {
    if (pos) toSlab(f, pos, _v);
    else toSlab(f, ctx.view.camera.focus, _v);
    let t = taps.length < MAX_TAPS ? null : taps[0];
    if (!t) {
      t = { t0: 0, x: 0, y: 0, k: 0, dusted: false };
      taps.push(t);
    } else for (const o of taps) if (o.t0 < t.t0) t = o;
    t.t0 = fx.clock;
    t.x = Math.min(f.W - 1, Math.max(1, _v.x));
    t.y = Math.min(f.H - 1, Math.max(1, _v.y));
    t.k = k;
    t.dusted = false;
  }

  function handleKeeper(f: Farm, ctx: RenderContext, action: string, pos: Readonly<Vec3> | null, on: boolean, food: KeeperFoodKind | ''): void {
    switch (action) {
      case 'dropFood':
      case 'contaminatedFood':
      case 'topUp':
        startDrop(f, ctx, pos, false, food);
        break;
      case 'dropWater':
        startDrop(f, ctx, pos, true, '');
        break;
      case 'lamp':
        lampEvent = on;
        break;
      case 'tapGlass':
        startTap(f, ctx, pos, 1);
        break;
      case 'shake':
        startTap(f, ctx, pos, 1.8);
        break;
      case 'openTube':
        tubeEvent = on;
        if (on) tubeFlash = fx.clock;
        break;
      default:
        break;
    }
  }

  function updateFarm(f: Farm, ctx: RenderContext, frame: FrameInfo): void {
    const sim = ctx.sim;
    const clock = fx.clock;
    const dt = fx.dAnim;
    const snap = ctx.sync || frame.frozen;
    const env = getEnv(ctx);
    const keeper = b3StateOf(sim).keeper;

    // ---- events -----------------------------------------------------------------------------
    const events = frame.events as readonly AnySimEvent[];
    let detailed = false;
    for (let i = 0; i < events.length; i++) if (events[i].type === 'keeperEvent') detailed = true;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type === 'keeperEvent') handleKeeper(f, ctx, e.action, e.pos, e.on, e.food);
      else if (e.type === 'keeper' && !detailed) handleKeeper(f, ctx, e.action, e.pos, e.on, '');
    }
    // newest food / item id seen so far (ids only grow): anything above it next frame is fresh
    {
      const fs = sim.foodSources;
      const its = sim.items;
      if (fs.length && fs[fs.length - 1].id > lastMaxId) lastMaxId = fs[fs.length - 1].id;
      if (its.length && its[its.length - 1].id > lastMaxId) lastMaxId = its[its.length - 1].id;
    }
    // demos
    if (fxDemo('hand') || fxDemo('pipette')) {
      if (!drop.active && clock >= demoNext) {
        startDrop(f, ctx, null, fxDemo('pipette'), 'fruit');
        demoNext = clock + DROP_TIME + 0.6;
      }
    }
    if (fxDemo('tap') && clock >= demoNext) {
      startTap(f, ctx, null, 1);
      demoNext = clock + TAP_TIME + 0.8;
    }

    f.glow.begin();

    // ---- drop: lid, hand, tool, falling food -------------------------------------------------
    let lidTarget = 0;
    let nPieces = 0;
    if (drop.active) {
      let t = clock - drop.t0;
      const hold = fxKnob('handT', -1);
      if (hold >= 0) t = hold;
      if (t > DROP_TIME + 2.2) drop.active = false;
      lidTarget = t > 0 && t < DROP_TIME - 0.5 ? 1 : 0;
      const kin = smooth((t - 0.25) / 1.15) * (1 - smooth((t - 2.0) / 1.3));
      const tipY = f.H - 5;
      const hx = drop.x;
      const show = t < DROP_TIME && kin > 0.001;
      f.hand.visible = show;
      if (show) {
        // comes down through the port from above and slightly towards the viewer
        const away = 1 - kin;
        f.hand.position.set(hx + away * 6 + Math.sin(clock * 2.1) * 0.12, tipY + 17.2 + away * 78, drop.z + away * 26);
        f.hand.rotation.set(-0.1 - away * 0.35, 0.5, 0.06 + away * 0.2 + Math.sin(clock * 1.3) * 0.01);
        f.tweezers.visible = !drop.water;
        f.pipette.visible = drop.water;
        const rel = smooth((t - 1.5) / 0.14);
        const open = 0.012 + rel * 0.05;
        f.bladeA.rotation.z = open;
        f.bladeB.rotation.z = -open;
        f.bead.visible = drop.water && t > 0.9 && t < 1.62;
        if (f.bead.visible) {
          const g = smooth((t - 0.9) / 0.6);
          f.bead.scale.set(0.2 + 0.75 * g, 0.2 + 0.95 * g, 0.2 + 0.75 * g);
          f.bead.position.y = -17.2 - 0.6 * g - smooth((t - 1.5) / 0.12) * 1.5;
        }
      }
      if (t >= 1.5 && !drop.released) {
        drop.released = true;
        fromSlab(f, hx, tipY - 0.4, drop.z, p);
        if (!drop.water) particles.emit('crumb', p, dn, { count: 10, size: 2.2, speed: 0.9, spread: 0.5 });
      }
      // food: held in the tweezers, then tumbling down to the landing point
      if (!drop.water && t < DROP_TIME + 2.2) {
        const pm = f.pieces;
        const fall = t - 1.5;
        const groundY = Math.min(tipY - 2, drop.y + 0.35);
        const dark = drop.food === 'fruit' ? 0 : 1;
        for (let i = 0; i < PIECES; i++) {
          const h = ((i * 7919 + 13) % 97) / 97;
          let px = hx + (h - 0.5) * 0.5;
          let py = tipY + 0.1 + (i % 3) * 0.25;
          let pz = drop.z + (((i * 31) % 17) / 17 - 0.5) * 0.6;
          let s = 1.5 + 1.0 * h;
          let spin = h * 6.283;
          if (fall <= 0) {
            if (!f.hand.visible) continue;
            // rides the tweezers tip while the hand moves
            _v.set((h - 0.5) * 0.5, -17 + (i % 3) * 0.3, (((i * 31) % 17) / 17 - 0.5) * 0.5).applyMatrix4(f.hand.matrixWorld);
            f.group.worldToLocal(_v);
            px = _v.x;
            py = _v.y;
            pz = _v.z;
          } else {
            const tf = fall - h * 0.12;
            const drift = (h - 0.5) * 3.2;
            const yFall = py - 0.5 * 34 * Math.max(0, tf) * Math.max(0, tf);
            if (yFall > groundY) {
              py = yFall;
              px += drift * Math.max(0, tf);
              spin += tf * (5 + 9 * h);
            } else {
              // landed: a small bounce-out, then it sinks away as the sim's own food takes over
              const tl = Math.sqrt((2 * (py - groundY)) / 34);
              const after = tf - tl;
              px += drift * (tl + Math.min(0.35, after) * 0.6);
              py = groundY + Math.max(0, Math.sin(Math.min(1, after / 0.3) * Math.PI)) * 0.5 * h;
              s *= 1 - smooth((after - 1.0) / 0.9);
              if (s < 0.02) continue;
            }
          }
          fromSlab(f, px, py, pz, p);
          writeSurfaceMatrix(p.x, p.y, p.z, Math.sin(spin) * 0.6, 1, Math.cos(spin * 0.7) * 0.6, spin, s, s, s, 0, pm.matrix, nPieces * 16);
          const c3 = nPieces * 3;
          pm.color[c3] = dark ? 0.78 : 0.85;
          pm.color[c3 + 1] = dark ? 0.6 : 0.2;
          pm.color[c3 + 2] = dark ? 0.32 : 0.14;
          const c4 = nPieces * 4;
          pm.a[c4] = h;
          pm.a[c4 + 1] = 0;
          pm.a[c4 + 2] = h;
          pm.a[c4 + 3] = 0.9;
          pm.b[c4] = pm.b[c4 + 1] = pm.b[c4 + 2] = pm.b[c4 + 3] = 0;
          pm.c[c4] = pm.c[c4 + 1] = pm.c[c4 + 2] = pm.c[c4 + 3] = 0;
          nPieces++;
        }
      }
    } else f.hand.visible = false;
    f.pieces.commit(nPieces);

    lidK = snap ? lidTarget : lidK + (lidTarget - lidK) * Math.min(1, dt * 5);
    const lidOn = lidK > 0.01;
    f.port.visible = f.flap.visible = f.shaft.visible = lidOn;
    if (lidOn) {
      const x = drop.x;
      f.port.position.set(x, f.H + 1.3, f.T / 2);
      f.port.scale.set(lidK, 1, 1);
      f.flap.position.set(x - 5.5, f.H + 2.62, f.T / 2);
      f.flap.rotation.z = Math.PI - lidK * 2.0;
      const floorY = Math.max(4, drop.y);
      const h = f.H - floorY;
      f.shaft.position.set(x, floorY + h / 2, f.T / 2 + 0.3);
      f.shaft.scale.set(10.5, h, 1);
      f.shaftU.uK.value = lidK * (0.3 + 0.25 * env.day);
    }

    // ---- lamp ------------------------------------------------------------------------------------
    const lampSim = keeper.lampOn || sim.weather.lamp !== null;
    const lampOn = lampSim || lampEvent || fxDemo('lamp');
    const heat = keeper.lampPos ?? sim.weather.lamp;
    if (heat) toSlab(f, heat, lampAim);
    else lampAim.set(f.W * 0.8, Math.min(f.H - 4, (env.mapExtras?.surfaceY ?? f.H * 0.6) + 2), f.T / 2);
    lampAim.z = f.T / 2;
    // the head hangs above and in front of the heated end, leaning in over the lid
    lampPos.set(lampAim.x + 13, f.H + 26, f.T + 24);
    f.lamp.position.copy(lampPos);
    _v.copy(lampAim).sub(lampPos).normalize();
    _q.setFromUnitVectors(_down, _v);
    f.lamp.quaternion.copy(_q);
    lampK = snap ? (lampOn ? 1 : 0) : lampK + ((lampOn ? 1 : 0) - lampK) * Math.min(1, dt * (lampOn ? 7 : 4));
    // tungsten flicker on switch-on settles quickly
    const lk = lampK * (1 + 0.04 * Math.sin(clock * 51) * (1 - lampK));
    f.bulbMat.color.setRGB(9 * lk + 0.02, 6.2 * lk + 0.02, 3.2 * lk + 0.015);
    f.spot.position.copy(lampPos);
    f.spot.target.position.copy(lampAim);
    f.spot.intensity = lk * 7.5;
    f.cone.visible = f.dust.visible = lampK > 0.01;
    f.coneU.uK.value = lk * (0.42 + 0.2 * env.night);
    f.dustU.uK.value = lk * 2.2;
    f.dustU.uPx.value = ctx.renderer.domElement.height / (2 * Math.tan((ctx.view.camera.fov * Math.PI) / 360));
    if (lampK > 0.01) {
      fromSlab(f, lampPos.x + _v.x * 4.5, lampPos.y + _v.y * 4.5, lampPos.z + _v.z * 4.5, p);
      f.glow.add(p.x, p.y, p.z, 11, 1.0, 0.7, 0.36, lk * 0.3);
    }

    // ---- glass taps ------------------------------------------------------------------------------
    let anyTap = false;
    let fingerOn = false;
    const front = (ctx.view as { a5?: { slabSide?: number } }).a5?.slabSide !== -1;
    for (let i = 0; i < MAX_TAPS; i++) {
      const u = f.rippleU.uTaps.value[i];
      const t = taps[i];
      if (!t || clock - t.t0 > TAP_TIME || clock < t.t0) {
        u.w = 0;
        continue;
      }
      anyTap = true;
      const age = clock - t.t0;
      const hit = 0.16;
      u.set(t.x, t.y, t.t0 + hit, t.k);
      if (age < 0.75) {
        // the fingertip: flicks in from the side, touches, springs back
        fingerOn = true;
        const k = age < hit ? smooth(age / hit) : 1 - smooth((age - hit - 0.03) / 0.5);
        const away = 1 - k;
        const side = front ? 1 : -1;
        f.finger.position.set(t.x + away * 22, t.y + away * 6, (front ? f.T + 0.9 : -0.9) + side * away * 20);
        f.finger.scale.set(1.5, 1.5, 1.5 * side);
        f.finger.rotation.set(0, side * (0.18 + away * 0.5), -0.12 + away * 0.25);
      }
      if (age >= hit && !t.dusted) {
        t.dusted = true;
        fxKick(0.28 * t.k, 0.3, 1);
        // dust shaken loose from tunnel ceilings around the tap
        const world = sim.world;
        let emitted = 0;
        for (let n = 0; n < 60 && emitted < 14; n++) {
          const a = rand() * 6.283;
          const r = 2 + rand() * 15 * t.k;
          const sx = t.x + Math.cos(a) * r;
          const sy = t.y + Math.sin(a) * r;
          const sz = 0.6 + rand() * (f.T - 1.2);
          fromSlab(f, sx, sy, sz, p);
          if (world.sample(p.x, p.y, p.z) > -0.35 || world.sample(p.x, p.y + 1.3, p.z) < -0.15) continue;
          p.y += 0.5;
          particles.emitCustom('keeperDust', p, dn, undefined);
          emitted++;
        }
      }
    }
    f.ripple.visible = anyTap;
    f.ripple.position.z = front ? f.T + 0.07 : -0.07;
    f.finger.visible = fingerOn;

    // ---- tube port ----------------------------------------------------------------------------------
    const tubeOn = keeper.tubeOpen || tubeEvent || fxDemo('tube');
    tubeK = snap ? (tubeOn ? 1 : 0) : tubeK + ((tubeOn ? 1 : 0) - tubeK) * Math.min(1, dt * 3);
    if (f.tube && f.tubeMat && f.tubePos) {
      const flash = Math.exp(-Math.max(0, clock - tubeFlash) * 2.2);
      const breathe = 0.6 + 0.4 * Math.sin(clock * 1.7);
      f.tubeMat.emissiveIntensity = tubeK * (0.1 * breathe + 1.2 * flash);
      if (tubeK > 0.01) {
        const tdir = f.tubePos.x > f.W / 2 ? 1 : -1;
        fromSlab(f, f.tubePos.x + tdir * 4.2, f.tubePos.y, f.T / 2 + 1.2, p);
        f.glow.add(p.x, p.y, p.z, 8 + 6 * flash, 1.0, 0.72, 0.3, tubeK * (0.55 * breathe + 0.9 * flash));
        fromSlab(f, f.tubePos.x, f.tubePos.y, f.T + 0.2, p);
        f.glow.add(p.x, p.y, p.z, 2.2, 1.0, 0.85, 0.5, tubeK * (0.5 + 2 * flash), true);
      }
    }
    f.glow.end();

    // ---- look ---------------------------------------------------------------------------------------
    fx.warm = lampK * 0.4;
    fx.exposure = 1 + 0.07 * lampK + 0.06 * lidK;
  }

  return {
    id: 'keeperFx',
    init(ctx) {
      drop.active = false;
      taps.length = 0;
      lampK = tubeK = lidK = 0;
      lampEvent = tubeEvent = false;
      tubeFlash = winT = -1e6;
      lost = false;
      demoNext = 0;
      lastMaxId = 0;
      fxRevealAt.clear();
      particles.registerKind('keeperDust', { count: 3, color: [0.7, 0.64, 0.52], size: 0.09, sizeVar: 0.6, speed: 0.5, speedVar: 0.7, life: 1.6, lifeVar: 0.4, gravity: 2.4, drag: 2.2, spread: 0.5, radius: 0.35, additive: 0, shape: 0, grow: 2.0, opacity: 0.4, lit: 0.8 });
      if (ctx.map.flags.slab && ctx.map.environment.backdrop === 'room') farm = buildFarm(ctx);
      else nuptial = createNuptialFx(ctx);
    },

    update(ctx: RenderContext, frame: FrameInfo) {
      const sim = ctx.sim;
      const clock = fx.clock;
      // ---- shared moments: queen death / lose / win --------------------------------------------
      const events = frame.events as readonly AnySimEvent[];
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.type === 'antDied') {
          if (e.caste === 'queen' && e.colony === sim.playerColony) {
            fxDesat(1);
            // the court scatters: a slow, pale exhalation where she lay
            particles.emit('mote', e.pos, null, { count: 14, color: [0.8, 0.85, 1.0], radius: 0.6, life: 0.9, size: 1.4 });
            particles.emit('dust', e.pos, null, { count: 6, size: 1.2 });
          }
        } else if (e.type === 'colonyDied') {
          if (e.colony === sim.playerColony) fxDesat(1);
        } else if (e.type === 'lose' || (e.type === 'gameEnd' && e.result === 'lost')) {
          lost = true;
          fxDesat(1);
        } else if (e.type === 'win' || (e.type === 'gameEnd' && e.result === 'won')) winT = clock;
        else if (e.type === 'gameContinue') lost = false;
      }
      if (lost && b3StateOf(sim).goals.phase !== 'lost' && sim.goal.status !== 'lost') lost = false;
      if (lost) fxDesat(0.8);
      if (fxDemo('desat')) fxDesat(1);
      const winK = Math.exp(-Math.max(0, clock - winT) * 0.25);

      let bloom = fungusLook.bloom + 0.4 * winK;
      if (farm) updateFarm(farm, ctx, frame);
      else {
        fx.warm = 0.25 * winK;
        fx.exposure = 1 + 0.08 * winK;
      }
      if (nuptial) bloom += nuptial.update(ctx, frame);
      fx.bloom = bloom;
    },

    dispose() {
      if (farm) {
        farm.group.removeFromParent();
        farm.pieces.dispose();
        farm.glow.dispose();
        farm.spot.dispose();
        farm = null;
      }
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      nuptial?.dispose();
      nuptial = null;
    },
  };
}

export const keeperFxModule: Module = createKeeperFxModule();
