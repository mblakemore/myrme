import type * as THREE from 'three';
import type { FxDebug, FxScreenState } from '../../core';

/**
 * B4 shared FX runtime (not a module — plain state every FX module imports).
 *
 *  - `fx.uClock`: animation clock uniform in seconds. Unlike `uTime` it keeps advancing with the
 *    sim while the render clock is frozen (shots: `step(n)` moves it n/30 s), so every FX shader /
 *    CPU animation should run on it. Written by the ants module once per frame (`fx.dAnim` = its
 *    delta this frame; 0 when nothing advanced).
 *  - screen feedback (`FxScreenState`, see `core/contracts/b4.ts`): pulses via `fxKick`, `fxHurt`,
 *    `fxDesat`; per-frame levels by plain assignment (`fx.flash = …`). Applied by `postlook`.
 *  - demos: `fxDemo('rain')` is true when `?fxdemo=rain,…` or `__myrmeFx.demo = 'rain,…'` names it.
 */
export const fx: FxScreenState & { uClock: THREE.IUniform<number>; clock: number; dAnim: number } = {
  uClock: { value: 0 },
  clock: 0,
  dAnim: 0,
  kick: 0,
  kickX: 0,
  kickY: 1,
  hurt: 0,
  desat: 0,
  flash: 0,
  shimmer: 0,
  shimmerY: 0,
  fog: 0,
  dim: 0,
  warm: 0,
  bloom: 0,
  exposure: 1,
};

/** Raise the possession bite / impact kick (screen direction optional, default = up). */
export function fxKick(amount: number, dx = 0, dy = 1): void {
  if (amount <= fx.kick) return;
  fx.kick = Math.min(1, amount);
  const l = Math.hypot(dx, dy) || 1;
  fx.kickX = dx / l;
  fx.kickY = dy / l;
}

/** Raise the damage-taken vignette pulse. */
export function fxHurt(amount: number): void {
  fx.hurt = Math.min(1, Math.max(fx.hurt, amount));
}

/** Raise the desaturation pulse (queen death, lose). */
export function fxDesat(amount: number): void {
  fx.desat = Math.min(1, Math.max(fx.desat, amount));
}

/** Central decay of the pulses; called once per frame by `postlook` with the animation delta. */
export function fxDecay(dt: number): void {
  if (dt <= 0) return;
  fx.kick *= Math.exp(-dt * 9);
  fx.hurt *= Math.exp(-dt * 2.6);
  fx.desat *= Math.exp(-dt * 0.3);
  if (fx.kick < 1e-3) fx.kick = 0;
  if (fx.hurt < 1e-3) fx.hurt = 0;
  if (fx.desat < 1e-3) fx.desat = 0;
}

/** Resets every channel (module init on a new map). */
export function fxReset(): void {
  fx.kick = fx.hurt = fx.desat = fx.flash = fx.shimmer = fx.fog = fx.dim = fx.warm = fx.bloom = 0;
  fx.exposure = 1;
}

/** The debug object on `globalThis.__myrmeFx` (seeded from `?fxdemo=`). */
export function fxDebug(): FxDebug {
  const g = globalThis as { __myrmeFx?: FxDebug; location?: { search?: string } };
  if (!g.__myrmeFx) {
    const d: FxDebug = {};
    try {
      d.demo = new URLSearchParams(g.location?.search ?? '').get('fxdemo');
    } catch {
      /* no URL (tests) */
    }
    g.__myrmeFx = d;
  }
  return g.__myrmeFx;
}

/** True when the named demo is switched on. Cheap enough to call per frame. */
export function fxDemo(name: string): boolean {
  const d = fxDebug().demo;
  if (!d) return false;
  if (d === name) return true;
  return (',' + d + ',').includes(',' + name + ',');
}

/** Numeric demo knob with a default (`__myrmeFx.<key>`). */
export function fxKnob(key: string, def: number): number {
  const v = fxDebug()[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}

/**
 * Nasute glue, render-side memory: entity id → FX-clock time of the last glue hit. The sim's hard
 * `st.glued` status lasts ~1.2 s (too short to read on screen); the coat and strands linger for
 * `GLUE_LINGER` seconds while the victim is still slowed. Written by combatFx from `attack`
 * events, read by ants / creatures (coat) and combatFx (strands).
 */
export const fxGlueAt = new Map<number, number>();
export const GLUE_LINGER = 6.5;

/** 1 right after a glue hit, holding ~1.5 s, then easing to 0 at `GLUE_LINGER` (0 = never hit). */
export function fxGlueLevel(id: number): number {
  if (fxGlueAt.size === 0) return 0;
  const at = fxGlueAt.get(id);
  if (at === undefined) return 0;
  const t = fx.clock - at;
  if (t < 0 || t >= GLUE_LINGER) {
    fxGlueAt.delete(id);
    return 0;
  }
  return t < 1.5 ? 1 : 1 - (t - 1.5) / (GLUE_LINGER - 1.5);
}

/**
 * Entities whose appearance is staged by an effect: entity id → FX-clock time at which it becomes
 * visible (the keeper's food exists in the sim from the moment the hand starts moving; the items
 * module keeps it hidden until the tweezers' pieces have landed, then pops it in).
 */
export const fxRevealAt = new Map<number, number>();

/** 0 while a staged entity is still hidden, easing to 1 over 0.45 s afterwards (1 if not staged). */
export function fxReveal(id: number): number {
  if (fxRevealAt.size === 0) return 1;
  const at = fxRevealAt.get(id);
  if (at === undefined) return 1;
  const t = (fx.clock - at) / 0.45;
  if (t >= 1) {
    fxRevealAt.delete(id);
    return 1;
  }
  if (t < -30) {
    // the FX clock was reset under us (new game): drop the stale entry
    fxRevealAt.delete(id);
    return 1;
  }
  return t <= 0 ? 0 : t * t * (3 - 2 * t);
}
