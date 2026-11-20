import * as THREE from 'three';
import type { RenderContext } from '../shared';

/**
 * Tiny additive billboard batch (B4 keeper / nuptial FX): soft round glows and 4-point glints,
 * one draw call, rewritten every frame. `begin()` → `add(...)`* → `end()`.
 * `kind` 0 = soft glow, 1 = star glint (wing flashes, dust in a light beam).
 */
const VERT = /* glsl */ `
attribute vec4 aGlowP; // xyz, size
attribute vec4 aGlowC; // rgb, intensity (negative = glint)
varying vec2 vUv;
varying vec4 vCol;
varying vec3 vWorld;
void main() {
  vUv = position.xy;
  vCol = aGlowC;
  vWorld = aGlowP.xyz;
  vec4 mv = viewMatrix * vec4(aGlowP.xyz, 1.0);
  mv.xy += position.xy * aGlowP.w;
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = /* glsl */ `
uniform vec4 uCutPlane;
varying vec2 vUv;
varying vec4 vCol;
varying vec3 vWorld;
void main() {
  if (dot(uCutPlane.xyz, vWorld) + uCutPlane.w > 0.0) discard;
  float r2 = dot(vUv, vUv);
  float a;
  if (vCol.a < 0.0) {
    float core = exp(-r2 * 26.0);
    float star = exp(-abs(vUv.x) * 26.0) * exp(-abs(vUv.y) * 3.5) + exp(-abs(vUv.y) * 26.0) * exp(-abs(vUv.x) * 3.5);
    a = core + star * 0.6;
  } else a = exp(-r2 * 4.5) - 0.011;
  if (a <= 0.0) discard;
  gl_FragColor = vec4(vCol.rgb * abs(vCol.a) * a, 0.0);
}`;

export class GlowBatch {
  readonly mesh: THREE.Mesh;
  private readonly p: Float32Array;
  private readonly c: Float32Array;
  private n = 0;

  constructor(
    ctx: RenderContext,
    private readonly max: number,
    name: string,
  ) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.p = new Float32Array(max * 4);
    this.c = new Float32Array(max * 4);
    const ap = new THREE.InstancedBufferAttribute(this.p, 4);
    const ac = new THREE.InstancedBufferAttribute(this.c, 4);
    ap.setUsage(THREE.DynamicDrawUsage);
    ac.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aGlowP', ap);
    g.setAttribute('aGlowC', ac);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const m = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uCutPlane: ctx.uniforms.uCutPlane },
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 22;
    this.mesh.visible = false;
    ctx.scene.add(this.mesh);
  }

  begin(): void {
    this.n = 0;
  }

  add(x: number, y: number, z: number, size: number, r: number, g: number, b: number, k: number, glint = false): void {
    if (this.n >= this.max || k <= 0.002) return;
    const i = this.n++ * 4;
    this.p[i] = x;
    this.p[i + 1] = y;
    this.p[i + 2] = z;
    this.p[i + 3] = size;
    this.c[i] = r;
    this.c[i + 1] = g;
    this.c[i + 2] = b;
    this.c[i + 3] = glint ? -k : k;
  }

  end(): void {
    const g = this.mesh.geometry as THREE.InstancedBufferGeometry;
    g.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n === 0) return;
    const a1 = g.attributes.aGlowP as THREE.BufferAttribute;
    const a2 = g.attributes.aGlowC as THREE.BufferAttribute;
    a1.clearUpdateRanges();
    a1.addUpdateRange(0, this.n * 4);
    a1.needsUpdate = true;
    a2.clearUpdateRanges();
    a2.addUpdateRange(0, this.n * 4);
    a2.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
