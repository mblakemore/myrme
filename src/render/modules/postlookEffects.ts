import { BlendFunction, Effect, EffectAttribute, Pass } from 'postprocessing';
import * as THREE from 'three';

/**
 * A3 post-processing building blocks used by the Renderer's effect chain:
 *
 *  - `AOPass` + `AOCompositeEffect`: half-resolution ambient occlusion with normals reconstructed
 *    from the depth buffer (no extra geometry pass, so the cutaway discard and every custom vertex
 *    shader are respected for free), a depth-aware separable blur and a depth-aware upsample.
 *    Radius is in WORLD units — tuned for contact shadows at ant scale.
 *  - `FogEffect`: analytic exponential height fog from depth with in-scattering towards the sun.
 *  - `GradeEffect`: split-toning (shadow / highlight tints), white balance and a soft toe lift.
 */

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }`;

const DEPTH_FNS = /* glsl */ `
uniform highp sampler2D uDepth;
uniform mat4 uProjInv;
uniform vec2 uNearFar;
float viewZ(float d) { return (uNearFar.x * uNearFar.y) / ((uNearFar.y - uNearFar.x) * d - uNearFar.y); }
vec3 viewPos(vec2 uv, float d) {
  vec4 c = vec4(vec3(uv, d) * 2.0 - 1.0, 1.0);
  vec4 v = uProjInv * c;
  return v.xyz / v.w;
}`;

const AO_FRAG = /* glsl */ `
precision highp float;
${DEPTH_FNS}
uniform vec2 uTexel;      // full-res depth texel
uniform float uRadius;    // world units
uniform float uBias;
uniform float uFade;      // world distance where AO has faded out
uniform vec2 uProjScale;  // projection [0][0], [1][1]
varying vec2 vUv;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  float d = texture2D(uDepth, vUv).r;
  if (d >= 0.99999) { gl_FragColor = vec4(1.0, 1.0, 0.0, 1.0); return; }
  vec3 P = viewPos(vUv, d);
  float dist = -P.z;
  // normal from depth: use the nearer neighbour on each axis so edges stay crisp
  vec2 ox = vec2(uTexel.x, 0.0); vec2 oy = vec2(0.0, uTexel.y);
  vec3 pl = viewPos(vUv - ox, texture2D(uDepth, vUv - ox).r);
  vec3 pr = viewPos(vUv + ox, texture2D(uDepth, vUv + ox).r);
  vec3 pd = viewPos(vUv - oy, texture2D(uDepth, vUv - oy).r);
  vec3 pu = viewPos(vUv + oy, texture2D(uDepth, vUv + oy).r);
  vec3 dx = abs(pl.z - P.z) < abs(pr.z - P.z) ? P - pl : pr - P;
  vec3 dy = abs(pd.z - P.z) < abs(pu.z - P.z) ? P - pd : pu - P;
  vec3 N = normalize(cross(dx, dy));
  float fade = 1.0 - smoothstep(uFade * 0.5, uFade, dist);
  if (fade <= 0.0) { gl_FragColor = vec4(1.0, dist / uNearFar.y, 0.0, 1.0); return; }
  // screen-space radius of the world-space sphere, clamped so close-ups stay cheap and stable
  float rUv = clamp(uRadius * uProjScale.y * 0.5 / dist, 2.0 * uTexel.y, 0.16);
  float rWorld = rUv * dist / (uProjScale.y * 0.5);
  float ang = ign(gl_FragCoord.xy) * 6.2831853;
  float occ = 0.0;
  const int N_S = AO_SAMPLES;
  for (int i = 0; i < N_S; i++) {
    float fi = (float(i) + 0.5) / float(N_S);
    float a = ang + float(i) * 2.399963;
    float r = sqrt(fi);
    vec2 uv = vUv + vec2(cos(a), sin(a) * uProjScale.x / uProjScale.y) * r * rUv;
    vec3 S = viewPos(uv, texture2D(uDepth, uv).r);
    vec3 v = S - P;
    float vv = dot(v, v);
    float vn = dot(v, N) - uBias * rWorld - 0.0015 * dist;
    float range = 1.0 - smoothstep(0.6, 1.3, vv / (rWorld * rWorld));
    occ += max(vn, 0.0) / (vv + 0.0004 * rWorld * rWorld + 1e-7) * range * rWorld;
  }
  float ao = clamp(1.0 - occ * (2.2 / float(N_S)), 0.0, 1.0);
  ao = mix(1.0, ao, fade);
  gl_FragColor = vec4(ao, dist / uNearFar.y, 0.0, 1.0);
}`;

const AO_BLUR_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uAo;
uniform vec2 uDir; // one AO-buffer texel along the blur axis
varying vec2 vUv;
void main() {
  vec2 c = texture2D(uAo, vUv).rg;
  float sum = c.r * 0.3; float wsum = 0.3;
  for (int i = -3; i <= 3; i++) {
    if (i == 0) continue;
    vec2 s = texture2D(uAo, vUv + uDir * float(i)).rg;
    float w = (1.0 - abs(float(i)) * 0.22) * max(0.0, 1.0 - abs(s.g - c.g) / (0.03 * c.g + 1e-5));
    sum += s.r * w; wsum += w;
  }
  gl_FragColor = vec4(sum / wsum, c.g, 0.0, 1.0);
}`;

export class AOPass extends Pass {
  radius = 0.9;
  bias = 0.04;
  fade = 160;
  private readonly rtA: THREE.WebGLRenderTarget;
  private readonly rtB: THREE.WebGLRenderTarget;
  private readonly aoMaterial: THREE.ShaderMaterial;
  private readonly blurMaterial: THREE.ShaderMaterial;
  private readonly cam: THREE.PerspectiveCamera;

  constructor(camera: THREE.PerspectiveCamera, samples = 10, private readonly scale = 0.5) {
    super('AOPass');
    this.cam = camera;
    this.needsSwap = false;
    this.needsDepthTexture = true;
    const opts = { depthBuffer: false, type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter } as const;
    this.rtA = new THREE.WebGLRenderTarget(1, 1, opts);
    this.rtB = new THREE.WebGLRenderTarget(1, 1, opts);
    this.aoMaterial = new THREE.ShaderMaterial({
      name: 'AO',
      defines: { AO_SAMPLES: String(samples) },
      uniforms: {
        uDepth: { value: null },
        uProjInv: { value: new THREE.Matrix4() },
        uNearFar: { value: new THREE.Vector2(0.1, 600) },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uRadius: { value: 1 },
        uBias: { value: 0.04 },
        uFade: { value: 160 },
        uProjScale: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: AO_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.blurMaterial = new THREE.ShaderMaterial({
      name: 'AOBlur',
      uniforms: { uAo: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: AO_BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.fullscreenMaterial = this.aoMaterial;
  }

  /** Blurred AO (r) + normalised view distance (g). */
  get texture(): THREE.Texture {
    return this.rtA.texture;
  }

  override setDepthTexture(depthTexture: THREE.Texture): void {
    this.aoMaterial.uniforms.uDepth.value = depthTexture;
  }

  override render(renderer: THREE.WebGLRenderer): void {
    const u = this.aoMaterial.uniforms;
    const cam = this.cam;
    (u.uProjInv.value as THREE.Matrix4).copy(cam.projectionMatrixInverse);
    (u.uNearFar.value as THREE.Vector2).set(cam.near, cam.far);
    (u.uProjScale.value as THREE.Vector2).set(cam.projectionMatrix.elements[0], cam.projectionMatrix.elements[5]);
    u.uRadius.value = this.radius;
    u.uBias.value = this.bias;
    u.uFade.value = this.fade;
    this.fullscreenMaterial = this.aoMaterial;
    renderer.setRenderTarget(this.rtA);
    renderer.render(this.scene, this.camera);
    const b = this.blurMaterial.uniforms;
    this.fullscreenMaterial = this.blurMaterial;
    b.uAo.value = this.rtA.texture;
    (b.uDir.value as THREE.Vector2).set(1 / this.rtA.width, 0);
    renderer.setRenderTarget(this.rtB);
    renderer.render(this.scene, this.camera);
    b.uAo.value = this.rtB.texture;
    (b.uDir.value as THREE.Vector2).set(0, 1 / this.rtA.height);
    renderer.setRenderTarget(this.rtA);
    renderer.render(this.scene, this.camera);
  }

  override setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width * this.scale));
    const h = Math.max(1, Math.round(height * this.scale));
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
    (this.aoMaterial.uniforms.uTexel.value as THREE.Vector2).set(1 / Math.max(1, width), 1 / Math.max(1, height));
  }

  override dispose(): void {
    this.rtA.dispose();
    this.rtB.dispose();
    this.aoMaterial.dispose();
    this.blurMaterial.dispose();
    super.dispose();
  }
}

const AO_COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D uAo;
uniform vec2 uAoTexel;
uniform float uIntensity;
uniform vec3 uAoTint;
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  float dist = -getViewZ(depth) / cameraFar;
  // depth-aware 4-tap upsample of the half-resolution AO
  vec2 p = uv / uAoTexel - 0.5;
  vec2 f = fract(p);
  vec2 b = (floor(p) + 0.5) * uAoTexel;
  float ao = 0.0; float ws = 0.0;
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    vec2 s = texture2D(uAo, b + vec2(float(i), float(j)) * uAoTexel).rg;
    float w = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
    w *= 1.0 / (1e-4 + abs(s.g - dist) / max(dist, 1e-5) * 40.0 + 0.02);
    ao += s.r * w; ws += w;
  }
  ao = depth >= 0.99999 ? 1.0 : ao / max(ws, 1e-6);
  float k = clamp((1.0 - ao) * uIntensity, 0.0, 1.0);
  // occluded light is not black: it picks up a little bounced colour
  outputColor = vec4(inputColor.rgb * mix(vec3(1.0), uAoTint, k), inputColor.a);
}`;

export class AOCompositeEffect extends Effect {
  constructor(private readonly ao: AOPass) {
    super('AOCompositeEffect', AO_COMPOSITE_FRAG, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, THREE.Uniform>([
        ['uAo', new THREE.Uniform(ao.texture)],
        ['uAoTexel', new THREE.Uniform(new THREE.Vector2(1, 1))],
        ['uIntensity', new THREE.Uniform(1)],
        ['uAoTint', new THREE.Uniform(new THREE.Color(0.02, 0.016, 0.02))],
      ]),
    });
  }
  set intensity(v: number) {
    this.uniforms.get('uIntensity')!.value = v;
  }
  get tint(): THREE.Color {
    return this.uniforms.get('uAoTint')!.value as THREE.Color;
  }
  override update(): void {
    const t = this.ao.texture;
    this.uniforms.get('uAo')!.value = t;
    const img = t.image as { width: number; height: number };
    (this.uniforms.get('uAoTexel')!.value as THREE.Vector2).set(1 / img.width, 1 / img.height);
  }
}

const FOG_FRAG = /* glsl */ `
uniform mat4 uProjInvF;
uniform mat4 uViewInvF;
uniform vec3 uCamPos;
uniform vec3 uFogColor;
uniform vec3 uFogSun;
uniform vec3 uFogSunDir;
uniform vec3 uFogParams; // density, 1/height, base
uniform vec4 uCloudSh;   // strength, drift x, drift z, 1/scale
float csHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float csNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(csHash(i), csHash(i + vec2(1, 0)), f.x), mix(csHash(i + vec2(0, 1)), csHash(i + vec2(1, 1)), f.x), f.y);
}
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  if (depth >= 0.99999 || (uFogParams.x <= 0.0 && uCloudSh.x <= 0.0)) { outputColor = inputColor; return; }
  vec4 c = uProjInvF * vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
  vec3 vp = c.xyz / c.w;
  vec3 ray = (uViewInvF * vec4(vp, 0.0)).xyz;
  vec3 lit = inputColor.rgb;
  if (uCloudSh.x > 0.001) {
    // drifting cloud shadows (B4): soft patches of shade sliding over everything above ground
    vec3 wp = uCamPos + ray;
    vec2 q = (wp.xz + uCloudSh.yz) * uCloudSh.w;
    float n = csNoise(q) * 0.6 + csNoise(q * 2.3 + 7.1) * 0.3 + csNoise(q * 5.1 + 3.3) * 0.1;
    float shade = smoothstep(0.42, 0.68, n) * smoothstep(uFogParams.z - 4.0, uFogParams.z - 1.0, wp.y);
    lit *= 1.0 - uCloudSh.x * shade * vec3(1.0, 0.94, 0.86);
  }
  if (uFogParams.x <= 0.0) { outputColor = vec4(lit, inputColor.a); return; }
  float L = length(ray);
  vec3 dir = ray / max(L, 1e-5);
  float k = uFogParams.y;
  // (density is capped at its base-level value: no fog wall underground)
  float dy = max(ray.y, min(0.0, uFogParams.z - uCamPos.y)) * k;
  float base = uFogParams.x * exp(-max(uCamPos.y - uFogParams.z, 0.0) * k);
  float integ = abs(dy) > 1e-3 ? (1.0 - exp(-dy)) / dy : 1.0 - 0.5 * dy;
  float tau = base * L * integ;
  float f = 1.0 - exp(-tau);
  float sun = pow(max(dot(dir, uFogSunDir), 0.0), 6.0);
  vec3 col = uFogColor + uFogSun * sun;
  outputColor = vec4(mix(lit, col, clamp(f, 0.0, 1.0)), inputColor.a);
}`;

export class FogEffect extends Effect {
  constructor(private readonly cam: THREE.PerspectiveCamera) {
    super('FogEffect', FOG_FRAG, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, THREE.Uniform>([
        ['uProjInvF', new THREE.Uniform(new THREE.Matrix4())],
        ['uViewInvF', new THREE.Uniform(new THREE.Matrix4())],
        ['uCamPos', new THREE.Uniform(new THREE.Vector3())],
        ['uFogColor', new THREE.Uniform(new THREE.Color(0.7, 0.8, 0.9))],
        ['uFogSun', new THREE.Uniform(new THREE.Color(0, 0, 0))],
        ['uFogSunDir', new THREE.Uniform(new THREE.Vector3(0, 1, 0))],
        ['uFogParams', new THREE.Uniform(new THREE.Vector3(0, 1 / 30, 0))],
        ['uCloudSh', new THREE.Uniform(new THREE.Vector4(0, 0, 0, 1 / 46))],
      ]),
    });
  }
  get color(): THREE.Color {
    return this.uniforms.get('uFogColor')!.value as THREE.Color;
  }
  get sunColor(): THREE.Color {
    return this.uniforms.get('uFogSun')!.value as THREE.Color;
  }
  get sunDir(): THREE.Vector3 {
    return this.uniforms.get('uFogSunDir')!.value as THREE.Vector3;
  }
  /** Drifting cloud shadows: strength 0..1 and the pattern offset in world units. */
  setCloudShadow(strength: number, ox: number, oz: number): void {
    const v = this.uniforms.get('uCloudSh')!.value as THREE.Vector4;
    v.x = strength;
    v.y = ox;
    v.z = oz;
  }
  setParams(density: number, height: number, base: number): void {
    (this.uniforms.get('uFogParams')!.value as THREE.Vector3).set(density, 1 / Math.max(0.5, height), base);
  }
  override update(): void {
    (this.uniforms.get('uProjInvF')!.value as THREE.Matrix4).copy(this.cam.projectionMatrixInverse);
    (this.uniforms.get('uViewInvF')!.value as THREE.Matrix4).copy(this.cam.matrixWorld);
    (this.uniforms.get('uCamPos')!.value as THREE.Vector3).setFromMatrixPosition(this.cam.matrixWorld);
  }
}

const GRADE_FRAG = /* glsl */ `
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform float uTemperature;
uniform float uLift;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c *= mix(uShadowTint, uHighlightTint, smoothstep(0.0, 0.7, l));
  c *= vec3(1.0 + 0.12 * uTemperature, 1.0, 1.0 - 0.12 * uTemperature);
  c = c * (1.0 - uLift) + uLift * vec3(0.9, 0.95, 1.0) * (1.0 - l);
  outputColor = vec4(max(c, 0.0), inputColor.a);
}`;

export class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', GRADE_FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['uShadowTint', new THREE.Uniform(new THREE.Color(1, 1, 1))],
        ['uHighlightTint', new THREE.Uniform(new THREE.Color(1, 1, 1))],
        ['uTemperature', new THREE.Uniform(0)],
        ['uLift', new THREE.Uniform(0)],
      ]),
    });
  }
  set(shadow: readonly number[], highlight: readonly number[], temperature: number, lift: number): void {
    (this.uniforms.get('uShadowTint')!.value as THREE.Color).setRGB(shadow[0], shadow[1], shadow[2]);
    (this.uniforms.get('uHighlightTint')!.value as THREE.Color).setRGB(highlight[0], highlight[1], highlight[2]);
    this.uniforms.get('uTemperature')!.value = temperature;
    this.uniforms.get('uLift')!.value = lift;
  }
}

const FX_SCREEN_FRAG = /* glsl */ `
uniform vec4 uFxKick;   // xy uv offset, z shimmer strength, w clock
uniform vec4 uFxTone;   // hurt, desat, flash, unused
uniform vec4 uFxGround; // camera height above the hot ground, unused…
uniform mat4 uFxProjInv;
uniform mat4 uFxViewInv;
void mainUv(inout vec2 uv) {
  uv += uFxKick.xy * (1.0 - 0.7 * length(uv - 0.5));
  if (uFxKick.z > 0.001) {
    // heat shimmer: strongest where the view ray grazes the hot ground far away
    vec4 c = uFxProjInv * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
    vec3 dir = normalize((uFxViewInv * vec4(c.xyz / c.w, 0.0)).xyz);
    float dist = dir.y < -0.003 ? uFxGround.x / -dir.y : 400.0;
    float k = smoothstep(5.0, 45.0, dist) * (1.0 - smoothstep(0.03, 0.22, dir.y));
    float t = uFxKick.w;
    vec2 n = vec2(sin(uv.y * 150.0 + t * 5.3 + sin(uv.x * 31.0 + t * 1.3) * 2.0), cos(uv.y * 95.0 - t * 3.7 + uv.x * 43.0));
    n += 0.5 * vec2(sin(uv.y * 310.0 - t * 8.1 + uv.x * 17.0), cos(uv.y * 250.0 + t * 6.3));
    uv += n * 0.0013 * uFxKick.z * k;
  }
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // queen death / lose: the colour drains out, shadows cool
  c = mix(c, vec3(l) * vec3(0.94, 0.98, 1.06), uFxTone.y * 0.92);
  // lightning: a cold lift that clips the highlights
  c += vec3(0.75, 0.82, 1.0) * uFxTone.z * (0.1 + 0.3 * l);
  // damage taken: a dark red pulse closing in from the edges
  float r = length((uv - 0.5) * vec2(1.0, 0.82));
  float edge = smoothstep(0.28, 0.78, r);
  c = mix(c, vec3(0.42, 0.02, 0.0) + c * vec3(0.9, 0.25, 0.2), edge * uFxTone.x * 0.85);
  outputColor = vec4(c, inputColor.a);
}`;

/** B4 screen feedback (see `fxShared.ts`): bite kick + heat shimmer (UV), hurt vignette, desaturation, lightning lift. */
export class FxScreenEffect extends Effect {
  constructor(private readonly cam: THREE.PerspectiveCamera) {
    super('FxScreenEffect', FX_SCREEN_FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['uFxKick', new THREE.Uniform(new THREE.Vector4())],
        ['uFxTone', new THREE.Uniform(new THREE.Vector4())],
        ['uFxGround', new THREE.Uniform(new THREE.Vector4(10, 0, 0, 0))],
        ['uFxProjInv', new THREE.Uniform(new THREE.Matrix4())],
        ['uFxViewInv', new THREE.Uniform(new THREE.Matrix4())],
      ]),
    });
  }
  set(kickX: number, kickY: number, shimmer: number, clock: number, hurt: number, desat: number, flash: number, camAboveGround: number): void {
    (this.uniforms.get('uFxKick')!.value as THREE.Vector4).set(kickX, kickY, shimmer, clock);
    (this.uniforms.get('uFxTone')!.value as THREE.Vector4).set(hurt, desat, flash, 0);
    (this.uniforms.get('uFxGround')!.value as THREE.Vector4).x = Math.max(0.2, camAboveGround);
  }
  override update(): void {
    (this.uniforms.get('uFxProjInv')!.value as THREE.Matrix4).copy(this.cam.projectionMatrixInverse);
    (this.uniforms.get('uFxViewInv')!.value as THREE.Matrix4).copy(this.cam.matrixWorld);
  }
}
