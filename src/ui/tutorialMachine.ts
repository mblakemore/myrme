/**
 * Onboarding step machine (PLAN §2: six contextual hints, each dismissed by doing the thing).
 * Pure logic — the DOM side (`./tutorial.ts`) turns input / sim observations into `TutorialSignal`s
 * and renders the current step.
 *
 * Steps run in order. A step is complete when all of its `needs` signals arrived IN ORDER while it
 * was the current step — except that things the player already did earlier still count for a
 * later single-signal step (someone who opens the colony panel first is not asked to do it again).
 */

export type TutorialStepId = 'camera' | 'select' | 'order' | 'dig' | 'possess' | 'colony';

export type TutorialSignal =
  | 'cameraMoved'
  | 'selected'
  | 'ordered'
  | 'digPainted'
  | 'possessed'
  | 'released'
  | 'colonyOpened';

export interface TutorialStepDef {
  id: TutorialStepId;
  /** Signals that complete the step, in order. */
  needs: readonly TutorialSignal[];
}

export const TUTORIAL_STEPS: readonly TutorialStepDef[] = [
  { id: 'camera', needs: ['cameraMoved'] },
  { id: 'select', needs: ['selected'] },
  { id: 'order', needs: ['ordered'] },
  { id: 'dig', needs: ['digPainted'] },
  { id: 'possess', needs: ['possessed', 'released'] },
  { id: 'colony', needs: ['colonyOpened'] },
];

export interface TutorialSnapshot {
  /** Index of the current step, or `TUTORIAL_STEPS.length` when finished. */
  index: number;
  step: TutorialStepId | null;
  /** How many of the current step's `needs` are satisfied. */
  progress: number;
  done: TutorialStepId[];
  skipped: boolean;
  finished: boolean;
  active: boolean;
}

export interface TutorialFeedResult {
  /** Steps completed by this signal (usually 0 or 1; more when later steps were pre-satisfied). */
  completed: TutorialStepId[];
  /** The current step's sub-progress moved. */
  progressed: boolean;
  finished: boolean;
}

export class TutorialMachine {
  private readonly done = new Set<TutorialStepId>();
  private skipped: boolean;
  private progress = 0;
  /** Single-signal steps whose signal was seen before their turn. */
  private readonly early = new Set<TutorialSignal>();

  constructor(saved?: { done?: readonly string[]; skipped?: boolean }) {
    this.skipped = !!saved?.skipped;
    for (const id of saved?.done ?? []) if (TUTORIAL_STEPS.some((s) => s.id === id)) this.done.add(id as TutorialStepId);
  }

  private get index(): number {
    for (let i = 0; i < TUTORIAL_STEPS.length; i++) if (!this.done.has(TUTORIAL_STEPS[i].id)) return i;
    return TUTORIAL_STEPS.length;
  }

  get finished(): boolean {
    return this.index >= TUTORIAL_STEPS.length;
  }

  /** Showing hints right now. */
  get active(): boolean {
    return !this.skipped && !this.finished;
  }

  get current(): TutorialStepDef | null {
    return this.active ? TUTORIAL_STEPS[this.index] : null;
  }

  feed(signal: TutorialSignal): TutorialFeedResult {
    const res: TutorialFeedResult = { completed: [], progressed: false, finished: this.finished };
    if (!this.active) return res;
    const cur = TUTORIAL_STEPS[this.index];
    if (cur.needs[this.progress] === signal) {
      this.progress++;
      res.progressed = true;
      if (this.progress >= cur.needs.length) this.complete(cur.id, res);
    } else {
      // remember signals of later single-need steps so they are not demanded again
      const later = TUTORIAL_STEPS.find((s) => !this.done.has(s.id) && s.id !== cur.id && s.needs.length === 1 && s.needs[0] === signal);
      if (later) this.early.add(signal);
    }
    res.finished = this.finished;
    return res;
  }

  private complete(id: TutorialStepId, res: TutorialFeedResult): void {
    this.done.add(id);
    res.completed.push(id);
    this.progress = 0;
    // cascade through steps the player already satisfied
    for (;;) {
      const next = this.finished ? null : TUTORIAL_STEPS[this.index];
      if (!next || next.needs.length !== 1 || !this.early.has(next.needs[0])) break;
      this.done.add(next.id);
      res.completed.push(next.id);
    }
  }

  skip(): void {
    this.skipped = true;
  }

  /** Start over from the first step. */
  reset(): void {
    this.done.clear();
    this.early.clear();
    this.progress = 0;
    this.skipped = false;
  }

  /** Jump so that step `index` is current (debug / replaying a hint). */
  goto(index: number): void {
    this.reset();
    for (let i = 0; i < Math.min(index, TUTORIAL_STEPS.length); i++) this.done.add(TUTORIAL_STEPS[i].id);
  }

  snapshot(): TutorialSnapshot {
    const i = this.index;
    return {
      index: i,
      step: this.active ? TUTORIAL_STEPS[i].id : null,
      progress: this.progress,
      done: TUTORIAL_STEPS.filter((s) => this.done.has(s.id)).map((s) => s.id),
      skipped: this.skipped,
      finished: this.finished,
      active: this.active,
    };
  }

  /** What to persist. */
  save(): { done: string[]; skipped: boolean } {
    return { done: this.snapshot().done, skipped: this.skipped };
  }
}

// ---- contextual first-time tips ------------------------------------------------------------

export type TipId = 'rain' | 'predator' | 'infection' | 'flood' | 'night' | 'starving' | 'raid';

/** Queue of one-time tips: each id is offered once, one at a time, in arrival order. */
export class TipQueue {
  private readonly seen: Set<string>;
  private readonly queue: TipId[] = [];
  current: TipId | null = null;

  constructor(seen: readonly string[] = []) {
    this.seen = new Set(seen);
  }

  /** Offer a tip; returns true when it was accepted (never shown before). */
  offer(id: TipId): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.queue.push(id);
    return true;
  }

  /** Advance to the next tip when none is showing; returns the tip to show now (or null). */
  next(): TipId | null {
    if (this.current === null && this.queue.length) this.current = this.queue.shift()!;
    return this.current;
  }

  dismiss(): void {
    this.current = null;
  }

  seenList(): string[] {
    return [...this.seen];
  }
}
