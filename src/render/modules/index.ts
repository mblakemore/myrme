import type { Module } from '../shared';
import { antsModule } from './ants';
import { broodModule } from './brood';
import { combatFxModule } from './combatFx';
import { creaturesModule } from './creatures';
import { cutawayLightModule } from './cutawayLight';
import { fungusFxModule } from './fungusFx';
import { habitatModule } from './habitat';
import { itemsModule } from './items';
import { keeperFxModule } from './keeperFx';
import { lightingModule } from './lighting';
import { particlesModule } from './particles';
import { pheromoneVizModule } from './pheromoneViz';
import { postlookModule } from './postlook';
import { selectionModule } from './selection';
import { skyModule } from './sky';
import { terrainModule } from './terrain';
import { vegetationModule } from './vegetation';
import { waterFxModule } from './waterFx';
import { weatherFxModule } from './weatherFx';

/**
 * Render module registry (§5.1, §5.3). Pre-populated by M0; wave agents fill in the module files
 * and never edit this list. Modules are initialised and updated in this order every frame:
 * environment first (sky, lights, terrain, habitat, vegetation), then entities, then effects,
 * and `postlook` last so it sees the final state of the frame when it adjusts `ctx.look`.
 *
 * Ownership: A3 — terrain, sky, lighting, vegetation, habitat, postlook, cutawayLight ·
 * A4 — ants, brood, items, selection, pheromoneViz, particles ·
 * B4 — weatherFx, waterFx, fungusFx, combatFx, creatures, keeperFx.
 */
export const MODULES: readonly Module[] = [
  skyModule,
  lightingModule,
  terrainModule,
  habitatModule,
  vegetationModule,
  cutawayLightModule,
  antsModule,
  creaturesModule,
  broodModule,
  itemsModule,
  selectionModule,
  pheromoneVizModule,
  particlesModule,
  waterFxModule,
  weatherFxModule,
  fungusFxModule,
  combatFxModule,
  keeperFxModule,
  postlookModule,
];
