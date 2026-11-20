import * as THREE from 'three';
import { acquireNoiseTextures, releaseNoiseTextures, type NoiseTextures } from '../../assets/textures/noiseTextures';
import type { MapId } from '../../core';
import type { Module, RenderContext } from '../shared';
import { getEnv } from './skyEnv';
import { LED_COLOR } from './terrainMaterial';

/**
 * Farm habitats (§5.3): everything around the voxel slab that makes it a desk-top ant farm.
 *
 *  - analytic glass panes (front / back) just outside the world box: fresnel reflections of the
 *    room cube map, greasy smudges and wipe marks, scratches that catch the light, bright cut
 *    edges with LED light piping along the bottom. No depth write, so DoF / AO see through.
 *  - back diffuser (B4, integration item e): tunnels pierce both panes, so every hollow used to
 *    be a hole straight to the room / the dark desk. A frosted, softly backlit sheet now sits
 *    behind whichever pane faces away from the camera: LED-lit from below on the gel farm, warm
 *    daylight acrylic on the sand farm and formicarium. Tunnels read as bright hollows with the
 *    ants silhouetted in them; above the fill line it fades out so the room still shows through
 *    the empty top of the farm (dithered). Opaque + depth-writing, so DoF keeps the hollows (and
 *    the selection rings drawn over them) in focus and AO grounds the tunnel edges.
 *  - frame: posts, lid rail and a satin base with a glowing LED slot (bloom source) under the
 *    slab; a soft shadowless up-light so ants near the bottom pick up the LED colour.
 *  - desk: wood-grain plane with varnish reflections, receiving the farm's shadow and LED spill;
 *    a few large, far, out-of-focus desk objects for parallax (medium quality and up).
 *
 * The gel / sand / plaster themselves are terrain materials (see terrainMaterial.ts). Built in
 * "slab space" (x = long axis, y = up, z = thickness) and rotated for `slabAxis: 'x'` maps.
 */

interface HabitatStyle {
  /** Back diffuser: colour at the top / bottom of the sheet (linear, HDR-safe: below the bloom threshold) and opacity. */
  diffTop: THREE.Color;
  diffBottom: THREE.Color;
  diffAlpha: number;
  /** LED strip colour and strength (0 = no strip). */
  led: THREE.Color;
  ledPower: number;
  frame: THREE.Color;
  frameRough: number;
  frameMetal: number;
}

const STYLES: Partial<Record<MapId, HabitatStyle>> = {
  gelFarm: { diffTop: new THREE.Color(0.1, 0.26, 0.62), diffBottom: new THREE.Color(0.42, 0.74, 1.0), diffAlpha: 0.9, led: LED_COLOR.clone(), ledPower: 1, frame: new THREE.Color(0.012, 0.02, 0.045), frameRough: 0.32, frameMetal: 0.55 },
  sandFarm: { diffTop: new THREE.Color(0.8, 0.7, 0.54), diffBottom: new THREE.Color(0.66, 0.54, 0.4), diffAlpha: 0.93, led: new THREE.Color(1.0, 0.82, 0.6), ledPower: 0.25, frame: new THREE.Color(0.1, 0.045, 0.02), frameRough: 0.5, frameMetal: 0.0 },
  formicarium: { diffTop: new THREE.Color(0.74, 0.72, 0.66), diffBottom: new THREE.Color(0.6, 0.57, 0.5), diffAlpha: 0.93, led: new THREE.Color(1.0, 0.9, 0.78), ledPower: 0.15, frame: new THREE.Color(0.55, 0.55, 0.53), frameRough: 0.45, frameMetal: 0.0 },
};

const GLASS_VERT = /* glsl */ `
varying vec3 vW;
varying vec2 vUv2;
void main() {
  vUv2 = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const GLASS_FRAG = /* glsl */ `
uniform samplerCube uEnvCube;
uniform sampler2D uNoiseFbm;
uniform sampler2D uNoiseMisc;
uniform vec3 uPaneN;
uniform vec2 uPaneSize;
uniform vec3 uLed;
uniform float uLedPower;
uniform float uStrength;
uniform vec4 uCutPlane;
varying vec3 vW;
varying vec2 vUv2;
void main() {
  if (dot(uCutPlane.xyz, vW) + uCutPlane.w > 0.0) discard;
  vec3 V = normalize(cameraPosition - vW);
  vec3 N = uPaneN * sign(dot(uPaneN, V));
  vec2 p = vUv2 * uPaneSize; // pane-space, world units
  // faint waviness of the sheet + greasy smudges make the reflection uneven
  vec4 n1 = texture2D(uNoiseFbm, p * 0.011);
  vec4 n2 = texture2D(uNoiseFbm, p * 0.045 + 0.31);
  vec4 ms = texture2D(uNoiseMisc, vec2(p.x * 0.02 + p.y * 0.012, p.y * 0.006 - p.x * 0.003));
  float smudge = smoothstep(0.52, 0.78, n1.a * 0.65 + n2.r * 0.35);
  float wipe = smoothstep(0.55, 0.85, ms.a) * smoothstep(0.35, 0.7, n1.r);
  vec3 Np = normalize(N + vec3(n1.g - 0.5, n1.b - 0.5, 0.0) * 0.05);
  float ndv = max(dot(Np, V), 0.0);
  float fres = 0.035 + 0.965 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, Np);
  float haze = smudge * 0.5 + wipe * 0.12;
  // head-on the pane only carries a soft, blurred sheen of the room (a sharp mirror image of the
  // window read as a pale rectangle pasted over the gel); the crisp reflection is kept for grazing angles
  float graze = smoothstep(0.25, 0.75, 1.0 - ndv);
  vec3 env = textureCube(uEnvCube, R, mix(3.4, 1.0, graze) + 3.0 * haze).rgb;
  env = min(env, vec3(mix(1.6, 8.0, graze)));
  vec3 col = env * (fres * mix(0.7, 1.0, graze) + haze * 0.035) * uStrength;
  float alpha = haze * 0.035;
  // fine scratches glint where the reflection is bright
  float scr = smoothstep(0.86, 0.97, texture2D(uNoiseMisc, vec2(p.x * 0.09 - p.y * 0.05, p.y * 0.012 + p.x * 0.004)).a);
  // (short and broken up: long parallel glints over a bright reflection looked like rain indoors)
  scr *= smoothstep(0.5, 0.75, n2.g) * smoothstep(0.45, 0.7, n1.b);
  col += env * scr * 0.012;
  // cut edges: light piping (LED along the bottom, room light elsewhere)
  vec2 e = min(p, uPaneSize - p);
  float edge = smoothstep(0.55, 0.0, min(e.x, e.y));
  float bottom = smoothstep(7.0, 0.0, p.y);
  col += edge * (vec3(0.5, 0.75, 0.7) * 0.18 + env * 0.5);
  col += uLed * uLedPower * (bottom * bottom * 0.1 + smoothstep(0.5, 0.0, p.y) * 0.9);
  gl_FragColor = vec4(col, alpha);
}`;

const DIFF_FRAG = /* glsl */ `
uniform samplerCube uEnvCube;
uniform sampler2D uNoiseFbm;
uniform vec2 uPaneSize;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec4 uDiff; // alpha, fill line y, room light level, led power
uniform vec4 uCutPlane;
uniform float uPheroVision;
varying vec3 vW;
varying vec2 vUv2;
void main() {
  if (dot(uCutPlane.xyz, vW) + uCutPlane.w > 0.0) discard;
  vec2 p = vUv2 * uPaneSize;
  vec3 V = normalize(cameraPosition - vW);
  // frosted sheet: the room behind it survives only as a very soft wash of colour
  vec3 room = textureCube(uEnvCube, -V, 6.0).rgb;
  float h = p.y / uPaneSize.y;
  // backlight falls off away from the strip; without a strip the sheet is lit by the room
  float led = exp(-h * 2.6) * uDiff.w;
  vec3 col = mix(uTop, uBottom, exp(-h * 2.2)) * mix(0.35 + 0.65 * uDiff.z, 1.0, clamp(uDiff.w, 0.0, 1.0));
  col *= 0.8 + 0.5 * led;
  // sheet imperfections: slow mottling and fine frost grain
  vec4 n1 = texture2D(uNoiseFbm, p * 0.013);
  col *= 0.9 + 0.2 * n1.r;
  // light dies towards the frame
  vec2 e = min(p, uPaneSize - p);
  col *= 0.72 + 0.28 * smoothstep(0.0, 9.0, min(e.x, e.y + 2.0));
  // a short dithered fade just above the fill line (a tall one read as a band of stipple, worst at low res)
  float a = 1.0 - smoothstep(uDiff.y + 1.2, uDiff.y + 4.2, p.y + (n1.g - 0.5) * 2.0);
  float dn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  #ifdef DIFF_SOFT_EDGE
    // low preset (no SMAA / DoF to melt the stipple, and a low-res buffer makes it a coarse band):
    // dissolve the sheet into the room wash instead and cut it once it is all wash
    if (a < 0.45) discard;
    col = mix(room, col, uDiff.x * smoothstep(0.45, 1.0, a));
  #else
    if (a < dn * 0.98 + 0.01) discard;
    col = mix(room, col, uDiff.x);
  #endif
  col = mix(col, vec3(dot(col, vec3(0.3, 0.55, 0.15))) * 0.32, uPheroVision * 0.85);
  gl_FragColor = vec4(col, 1.0);
}`;

function woodDeskMaterial(ctx: RenderContext, noise: NoiseTextures, footprint: THREE.Vector4, style: HabitatStyle): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0 });
  mat.name = 'desk';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNoiseFbm = { value: noise.fbm };
    shader.uniforms.uNoiseMisc = { value: noise.misc };
    shader.uniforms.uFoot = { value: footprint };
    shader.uniforms.uLed = { value: style.led.clone().multiplyScalar(style.ledPower) };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vDeskW;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvDeskW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D uNoiseFbm; uniform sampler2D uNoiseMisc; uniform vec4 uFoot; uniform vec3 uLed;
        varying vec3 vDeskW;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float dRough;
        {
          vec2 p = vDeskW.xz;
          // boards run along x; each board has its own tone and grain offset
          float board = floor(p.y / 62.0 + 0.37);
          float bid = fract(sin(board * 91.7) * 43758.5);
          vec2 q = vec2(p.x * 0.0045 + bid * 7.0, p.y * 0.022 + bid * 3.0);
          float warp = texture2D(uNoiseFbm, q * 0.6).r;
          float rings = 0.5 + 0.5 * sin((q.y * 5.0 + warp * 2.6) * 12.0);
          float fib = texture2D(uNoiseMisc, vec2(p.y * 0.03 + bid, p.x * 0.004)).a;
          vec3 light = vec3(0.5, 0.3, 0.15); vec3 dark = vec3(0.2, 0.1, 0.045);
          vec3 c = mix(dark, light, 0.25 + 0.5 * rings * (0.6 + 0.4 * warp) + 0.3 * (fib - 0.5));
          c *= 0.82 + 0.3 * bid;
          float gap = smoothstep(0.012, 0.0, abs(fract(p.y / 62.0 + 0.37) - 0.5) - 0.488);
          c *= 1.0 - 0.6 * gap;
          diffuseColor.rgb = c;
          dRough = 0.3 + 0.25 * fib + 0.2 * gap;
        }`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = dRough;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          // LED spill from the base onto the desk
          vec2 d2 = max(abs(vDeskW.xz - uFoot.xy) - uFoot.zw, 0.0);
          float dist = length(d2);
          totalEmissiveRadiance += diffuseColor.rgb * uLed * (1.6 * exp(-dist * 0.09) + 0.5 * exp(-dist * 0.02));
        }`,
      );
  };
  return mat;
}

export function createHabitatModule(): Module {
  let group: THREE.Group | null = null;
  let uplight: THREE.DirectionalLight | null = null;
  let noise: NoiseTextures | null = null;
  const disposables: { dispose(): void }[] = [];
  let glassMats: THREE.ShaderMaterial[] = [];
  let ledMat: THREE.MeshBasicMaterial | null = null;
  let diffU: THREE.IUniform<THREE.Vector4> | null = null;
  let style: HabitatStyle | null = null;

  return {
    id: 'habitat',
    init(ctx) {
      if (!ctx.map.flags.slab) return;
      const env = getEnv(ctx);
      const world = ctx.sim.world;
      const axisX = ctx.map.flags.slabAxis === 'x';
      const W = axisX ? world.sz : world.sx;
      const H = world.sy;
      const T = axisX ? world.sx : world.sz;
      style = STYLES[ctx.sim.mapId] ?? STYLES.gelFarm!;
      noise = acquireNoiseTextures(ctx.renderer);
      const low = ctx.quality.preset === 'low';

      group = new THREE.Group();
      group.name = 'habitat';
      if (axisX) {
        group.rotation.y = -Math.PI / 2;
        group.position.x = T;
      }
      ctx.scene.add(group);
      const add = (mesh: THREE.Mesh, cast = true, receive = true): THREE.Mesh => {
        mesh.castShadow = cast;
        mesh.receiveShadow = receive;
        group!.add(mesh);
        disposables.push(mesh.geometry);
        return mesh;
      };

      // ---- frame ----
      const frameMat = new THREE.MeshStandardMaterial({ color: style.frame, roughness: style.frameRough, metalness: style.frameMetal });
      disposables.push(frameMat);
      const post = 3.2;
      const depth = T + 2.4;
      const baseH = 7;
      const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material = frameMat): THREE.Mesh => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        m.position.set(x, y, z);
        return add(m);
      };
      box(post, H + 2.6, depth, -post / 2 - 0.02, H / 2 + 1.3 - 0.02, T / 2);
      box(post, H + 2.6, depth, W + post / 2 + 0.02, H / 2 + 1.3 - 0.02, T / 2);
      box(W + post * 2 + 0.04, 2.6, depth, W / 2, H + 1.3, T / 2); // lid rail
      // base: wide, with a chamfer-like top step
      box(W + post * 2 + 9, baseH - 1.2, T + 16, W / 2, -baseH / 2 - 0.6 - 0.02, T / 2);
      box(W + post * 2 + 3, 1.2, T + 7, W / 2, -0.6 - 0.02, T / 2);
      // LED slot: an emissive bar under the slab (bloom source), visible through the gel bottom edge
      ledMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
      disposables.push(ledMat);
      if (style.ledPower > 0) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(W - 1, 0.5, T + 3.2), ledMat);
        bar.position.set(W / 2, 0.2, T / 2);
        add(bar, false, false);
      }

      // ---- glass panes ----
      const makePane = (z: number, strength: number): void => {
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            uEnvCube: env.uniforms.uEnvCube,
            uNoiseFbm: { value: noise!.fbm },
            uNoiseMisc: { value: noise!.misc },
            uPaneN: { value: axisX ? new THREE.Vector3(-1, 0, 0) : new THREE.Vector3(0, 0, 1) },
            uPaneSize: { value: new THREE.Vector2(W, H) },
            uLed: { value: style!.led },
            uLedPower: { value: style!.ledPower },
            uStrength: { value: strength },
            uCutPlane: ctx.uniforms.uCutPlane,
          },
          vertexShader: GLASS_VERT,
          fragmentShader: GLASS_FRAG,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.CustomBlending,
          blendEquation: THREE.AddEquation,
          blendSrc: THREE.OneFactor,
          blendDst: THREE.OneMinusSrcAlphaFactor,
          toneMapped: false,
        });
        glassMats.push(mat);
        disposables.push(mat);
        const pane = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
        pane.position.set(W / 2, H / 2, z);
        pane.renderOrder = 20;
        add(pane, false, false);
      };
      makePane(T + 0.03, 1);
      makePane(-0.03, 0.6);

      // ---- back diffuser: one sheet behind each pane, each visible only from the opposite side ----
      {
        const fill = Math.min(H, (env.mapExtras?.surfaceY ?? H * 0.8) + 2);
        diffU = { value: new THREE.Vector4(style.diffAlpha, fill, 1, style.ledPower) };
        const mat = new THREE.ShaderMaterial({
          defines: ctx.quality.preset === 'low' ? { DIFF_SOFT_EDGE: '' } : {},
          uniforms: {
            uEnvCube: env.uniforms.uEnvCube,
            uNoiseFbm: { value: noise.fbm },
            uPaneSize: { value: new THREE.Vector2(W, H) },
            uTop: { value: style.diffTop },
            uBottom: { value: style.diffBottom },
            uDiff: diffU,
            uCutPlane: ctx.uniforms.uCutPlane,
            uPheroVision: ctx.uniforms.uPheroVision,
          },
          vertexShader: GLASS_VERT,
          fragmentShader: DIFF_FRAG,
          side: THREE.FrontSide,
          toneMapped: false,
        });
        disposables.push(mat);
        for (const front of [false, true]) {
          const sheet = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
          sheet.position.set(W / 2, H / 2, front ? T + 0.07 : -0.07);
          if (front) sheet.rotation.y = Math.PI;
          sheet.name = 'habitat:diffuser';
          add(sheet, false, false);
        }
      }

      // ---- desk ----
      const deskY = -baseH - 0.62;
      const foot = axisX ? new THREE.Vector4(T / 2, W / 2, (T + 16) / 2, (W + 15) / 2) : new THREE.Vector4(W / 2, T / 2, (W + 15) / 2, (T + 16) / 2);
      const deskMat = woodDeskMaterial(ctx, noise, foot, style);
      disposables.push(deskMat);
      const desk = new THREE.Mesh(new THREE.PlaneGeometry(1400, 900), deskMat);
      desk.rotation.x = -Math.PI / 2;
      desk.position.set(W / 2, deskY, T / 2 - 250);
      add(desk, false, true);

      // ---- far desk objects: only ever seen as soft shapes ----
      if (!low) {
        const std = (color: number, rough: number): THREE.MeshStandardMaterial => {
          const m = new THREE.MeshStandardMaterial({ color, roughness: rough });
          disposables.push(m);
          return m;
        };
        const mug = new THREE.Mesh(new THREE.CylinderGeometry(27, 24, 62, 28), std(0x8f4a36, 0.3));
        mug.position.set(W + 95, deskY + 31, -120);
        add(mug);
        const books: [number, number, number, number][] = [
          [0x26384a, 150, 20, 105],
          [0x6e5a34, 140, 16, 98],
          [0x4a2a30, 132, 22, 100],
        ];
        let by = deskY;
        books.forEach(([c, w, h, d], i) => {
          const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), std(c, 0.6));
          b.position.set(-105 + i * 4, by + h / 2, -150 - i * 6);
          b.rotation.y = 0.25 - i * 0.12;
          add(b);
          by += h;
        });
        const pot = new THREE.Mesh(new THREE.CylinderGeometry(34, 26, 52, 24), std(0xd9d3c5, 0.7));
        pot.position.set(W + 190, deskY + 26, -300);
        add(pot);
        const plant = new THREE.Mesh(new THREE.IcosahedronGeometry(52, 1), std(0x2f5d23, 0.8));
        plant.position.set(W + 190, deskY + 92, -300);
        plant.scale.set(1, 0.85, 1);
        add(plant);
        const pencil = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 120, 6), std(0xd9a514, 0.5));
        pencil.rotation.z = Math.PI / 2;
        pencil.rotation.y = 0.5;
        pencil.position.set(W / 2 - 30, deskY + 2.4, T + 70);
        add(pencil);
      }

      // ---- LED up-light for entities inside the slab ----
      uplight = new THREE.DirectionalLight(style.led, 0);
      uplight.name = 'led-uplight';
      uplight.position.set(W / 2, -40, T / 2 + (axisX ? 0 : 10));
      uplight.target.position.set(W / 2, H / 2, T / 2);
      group.add(uplight, uplight.target);
    },
    update(ctx) {
      if (!group || !style) return;
      const env = getEnv(ctx);
      // by day the room competes with the strip; in the evening the LEDs own the scene
      const k = style.ledPower * (0.9 + 0.5 * env.night);
      ledMat!.color.copy(style.led).multiplyScalar(3.2 * k + 0.4);
      if (uplight) uplight.intensity = 0.55 * k;
      if (diffU) {
        diffU.value.z = 0.3 + 0.7 * env.day;
        diffU.value.w = k;
      }
      const possess = ctx.view.mode === 'possess';
      for (const m of glassMats) m.uniforms.uLedPower.value = k * (possess ? 0.4 : 1);
    },
    dispose() {
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      glassMats = [];
      group?.removeFromParent();
      group = null;
      uplight = null;
      ledMat = null;
      diffU = null;
      style = null;
      if (noise) releaseNoiseTextures();
      noise = null;
    },
  };
}

export const habitatModule: Module = createHabitatModule();
