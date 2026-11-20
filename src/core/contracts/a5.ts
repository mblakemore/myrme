/**
 * Contract extensions owned by stream A5 (PLAN §10.2, D22).
 * Add types here when `core/contracts.ts` lacks something you need to share; report additions.
 * Additive only — never redefine or widen a type from `core/contracts.ts`.
 *
 * A5 publishes extra *presentation* state for render modules (A4: selection rings, order / beacon
 * / designation markers, brush preview) next to the frozen `ViewState`. The input layer is the
 * single writer. It lives on the same shared view object under the optional key `a5`:
 *
 *     const ext = viewExt(ctx.view);          // undefined until the input layer has initialised
 *     if (ext?.brush) drawBrush(ext.brush);
 *
 * Everything in it is plain data, replaced or mutated in place once per frame by the input layer
 * (read it during `RenderModule.update`, do not keep references across frames).
 */
import type { BeaconKind, EntityId, EntityKind, OrderKind, Vec3, ViewState } from '../contracts';

/** The tool the cursor currently carries. `ViewState.tool` mirrors the dig/build subset. */
export type ActiveTool = 'dig' | 'build' | `beacon:${BeaconKind}` | null;

/** Live preview of the spherical paint brush under the cursor (dig / build tools). */
export interface BrushPreview {
  kind: 'dig' | 'build';
  /** Centre of the sphere that a click would designate. */
  center: Vec3;
  /** Surface normal at the cursor hit (points out of the solid). */
  normal: Vec3;
  radius: number;
  /** True while the brush removes designations instead of adding them. */
  erase: boolean;
  /** True when the cursor is on the cutaway cross-section (centre is snapped onto the plane). */
  onCutFace: boolean;
}

/** One stamp of the stroke being painted (shown until the sim's designation appears). */
export interface StrokeStamp {
  kind: 'dig' | 'build';
  center: Vec3;
  radius: number;
  erase: boolean;
}

/** Preview of the beacon a click would place — or the existing beacon it would remove. */
export interface BeaconPreview {
  kind: BeaconKind;
  pos: Vec3;
  radius: number;
  /** Id of the existing beacon under the cursor (a click removes it), else 0. */
  removeId: number;
}

/**
 * Feedback for an order the player just issued (A4 draws a short-lived marker). Entries live for
 * `ORDER_PING_SECONDS` of render time and are then dropped by the input layer.
 */
export interface OrderPing {
  /** Monotonic sequence number (stable key for marker pooling). */
  seq: number;
  order: OrderKind;
  /** World position of the order target (terrain point or the target entity's position). */
  pos: Vec3 | null;
  /** Target entity (0 = terrain order). */
  targetId: EntityId;
  ids: EntityId[];
  /** Shift-queued behind existing orders. */
  queued: boolean;
  /** `FrameInfo.time` (render clock, seconds) when it was issued. */
  time: number;
}

export const ORDER_PING_SECONDS = 1.6;

export interface PointerState {
  /** Cursor position in CSS pixels relative to the canvas. */
  x: number;
  y: number;
  /** True while the cursor is over the 3D canvas (false over HUD panels / outside the window). */
  over: boolean;
}

/** Extra view state published by the input layer (see file header). */
export interface ViewExtA5 {
  /** Kind of `ViewState.hoverId` (null when nothing is hovered). */
  hoverKind: EntityKind | null;
  /** The hovered entity is an enemy ant or a hostile creature (attack cursor / red ring). */
  hoverHostile: boolean;
  /** "Primary" ant of the selection (detail panel, Tab cycling, possess target). 0 = none. */
  primaryId: EntityId;
  activeTool: ActiveTool;
  brushRadius: number;
  erase: boolean;
  brush: BrushPreview | null;
  /** Stamps of the paint stroke in progress (cleared shortly after the button is released). */
  stroke: StrokeStamp[];
  beaconPreview: BeaconPreview | null;
  orderPings: OrderPing[];
  pointer: PointerState;
  /** Ant the RTS/slab camera is following (0 = free camera). */
  followId: EntityId;
  /** Possession fly-in / fly-out blend: 0 at the start of a transition, 1 when settled. */
  transition: number;
  /** Slab maps: which pane the camera looks through (+1 = from the +axis side, -1 = the other). */
  slabSide: 1 | -1;
}

/** `ViewState` plus the A5 extension slot. */
export type ViewStateA5 = ViewState & { a5?: ViewExtA5 };

/** The A5 extension of a shared view object, or undefined before the input layer initialised. */
export function viewExt(view: ViewState): ViewExtA5 | undefined {
  return (view as ViewStateA5).a5;
}
