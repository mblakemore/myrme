import type { FrameInfo } from '../core';
import type { Module, RenderContext } from '../render/shared';

/** Player graphics toggles that are applied on top of whatever the look modules decided. */
export interface LookToggles {
  dof: boolean;
  bloom: boolean;
  grain: boolean;
}

/**
 * Last render module of every Game: applies the settings screen's DoF / bloom / grain switches to
 * the shared `look` object after the look modules (A3 `postlook`, FX) have written it this frame.
 * It only ever turns things OFF, so with the default toggles it is a no-op (shots stay identical).
 */
export function createLookOverride(toggles: LookToggles): Module {
  return {
    id: 'b5.lookOverride',
    init(_ctx: RenderContext) {},
    update(ctx: RenderContext, _frame: FrameInfo) {
      const look = ctx.look;
      if (!toggles.dof) look.dof.strength = 0;
      if (!toggles.bloom) look.bloom.intensity = 0;
      if (!toggles.grain) look.grain = 0;
    },
    dispose() {},
  };
}
