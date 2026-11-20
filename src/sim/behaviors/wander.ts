import { v3, v3rotateAbout, type Behavior } from '../../core';

const _d = v3();

/**
 * FIXTURE behavior (kept permanently, `?fixture=wander`): unbiased random crawl over whatever
 * surface the ant is on — floors, walls, ceilings, stems. Used by the crawl soak test and by the
 * render/input streams as a living scene. Only scores when the sim runs the wander fixture.
 *
 * Each think re-rolls a turn rate; every tick the heading is rotated about the local up and
 * handed to the movement system as a `dir` intent. Near the edge of an open map it steers back
 * towards the centre.
 */
export const wanderBehavior: Behavior = {
  id: 'wander',
  band: 'idle',
  score: (_ant, sim) => (sim.options.fixture === 'wander' ? 1 : 0),
  run(ant, sim, dt) {
    const mem = ant.mem;
    if (mem['w.until'] === undefined || sim.tick >= mem['w.until']) {
      mem['w.turn'] = sim.rng.range(-1.6, 1.6);
      mem['w.pause'] = sim.rng.chance(0.06) ? 1 : 0;
      mem['w.until'] = sim.tick + 8 + sim.rng.int(30);
    }
    const it = ant.intent;
    // Blocked (crevice, map edge): the movement system refused the step → turn hard.
    if (it.mode === 'dir' && !mem['w.pause'] && ant.moveSpeed < ant.speed * 0.25 && mem['w.until'] - sim.tick > 4) {
      mem['w.turn'] = sim.rng.chance(0.5) ? 4.5 : -4.5;
      mem['w.until'] = sim.tick + 4 + sim.rng.int(8);
    }
    if (mem['w.pause']) {
      it.mode = 'none';
      return;
    }
    v3rotateAbout(_d, ant.forward, ant.up, mem['w.turn'] * dt);
    const w = sim.world;
    if (w.boundary === 'open') {
      const margin = 4;
      const p = ant.pos;
      if (p.x < margin || p.z < margin || p.x > w.sx - margin || p.z > w.sz - margin) {
        _d.x = w.sx / 2 - p.x;
        _d.y = 0;
        _d.z = w.sz / 2 - p.z;
      }
    }
    it.mode = 'dir';
    it.dir.x = _d.x;
    it.dir.y = _d.y;
    it.dir.z = _d.z;
    it.speedMul = 1;
  },
};
