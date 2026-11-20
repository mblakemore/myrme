import type { HudComponent, HudContext } from './context';
import { h, setShown, setText } from './dom';

/** Debug overlay (F9): fps, frame / sim cost, draw calls… Hidden by default; costs nothing then. */
export function createDebugOverlay(ctx: HudContext): HudComponent & { toggle(): void } {
  const { app } = ctx;
  const el = h('div', 'mh-panel mh-debug mh-hidden', { testid: 'debug' });
  let shown = false;
  return {
    el,
    toggle() {
      shown = !shown;
      setShown(el, shown);
    },
    update() {
      if (!shown) return;
      const sim = app.sim;
      const rs = app.renderStats();
      const ss = sim.stats();
      const cam = app.view.camera;
      setText(
        el,
        `${sim.mapId} · seed ${sim.options.seed} · ${app.params.quality}\n` +
          `fps ${rs.fps.toFixed(0).padStart(3)}   frame ${rs.frameMs.toFixed(1)} ms   res ×${rs.resolutionScale.toFixed(2)}\n` +
          `sim ${ss.msPerTick.toFixed(2)} ms/tick   tick ${ss.tick}   ${sim.paused ? 'paused' : `${sim.speed}×`}\n` +
          `draws ${rs.drawCalls}   tris ${(rs.triangles / 1000).toFixed(0)}k   geo ${rs.geometries}   tex ${rs.textures}\n` +
          `chunks pending ${rs.pendingChunks}   paths pending ${ss.pendingPaths}\n` +
          `ants ${ss.ants}   creatures ${ss.creatures}   brood ${ss.brood}   items ${ss.items}\n` +
          `cam ${cam.pos.x.toFixed(1)}, ${cam.pos.y.toFixed(1)}, ${cam.pos.z.toFixed(1)}   focus ${cam.focusDist.toFixed(1)}   ${app.view.mode}` +
          (app.view.cut.enabled ? `\ncut ${app.view.cut.axis} @ ${app.view.cut.pos.toFixed(1)} (${app.view.cut.sign > 0 ? '+' : '−'})` : ''),
      );
    },
  };
}
