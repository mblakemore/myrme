import type { SimEvent } from './contracts';

/**
 * D19 event buffer. The sim pushes during ticks; the host drains once per render frame, so
 * events survive several ticks per frame at 4× speed. Capped to avoid unbounded growth when
 * nobody drains (headless soak tests): the oldest events are dropped first.
 */
export class EventBuffer {
  private buf: SimEvent[] = [];
  /** Total events ever pushed (tests / stats). */
  total = 0;

  constructor(private readonly cap = 8192) {}

  push(e: SimEvent): void {
    this.total++;
    if (this.buf.length >= this.cap) this.buf.splice(0, this.buf.length - this.cap + 1);
    this.buf.push(e);
  }

  /** Returns all buffered events and clears the buffer. */
  drain(): SimEvent[] {
    const out = this.buf;
    this.buf = [];
    return out;
  }

  get length(): number {
    return this.buf.length;
  }
}
