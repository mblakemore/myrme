/**
 * Field guide content (pure data — no DOM). Short entries in one voice: what it is, what it does
 * to the colony, what the player can do about it. Numbers come from the live species / creature
 * registries so the guide never drifts from the balance tables.
 */
import { FACTION_INFO, PHERO_NAMES, type CasteId, type CreatureId, type SpeciesId } from '../core';
import { CREATURES } from '../sim/data/creatures';
import { SPECIES } from '../sim/data/species';

export interface CodexEntry {
  id: string;
  title: string;
  icon: string;
  /** One-line summary shown under the title. */
  lead: string;
  body: string[];
  facts?: [string, string][];
  /** CSS colour swatch (pheromone channels). */
  swatch?: string;
  /** Small table: header + rows. */
  table?: { head: string[]; rows: string[][] };
}

export interface CodexCategory {
  id: string;
  title: string;
  icon: string;
  entries: CodexEntry[];
}

/**
 * Pheromone channel colours — copied from `PHERO_COLORS` in `render/modules/particles.ts` (the
 * palette `pheromoneViz` draws with; that module pulls in three.js, so the values are mirrored
 * here). Index = `Phero` channel id.
 */
export const PHERO_LEGEND_COLORS: readonly (readonly [number, number, number])[] = [
  [0.45, 1.0, 0.35], // food
  [1.0, 0.28, 0.1], // alarm
  [0.62, 0.4, 0.9], // death
  [1.0, 0.72, 0.2], // dig
  [0.2, 0.85, 1.0], // rally
  [1.0, 0.1, 0.35], // attack
  [0.75, 0.85, 1.0], // avoid
  [0.4, 0.65, 1.0], // trail
];

export function pheroCss(channel: number): string {
  const c = PHERO_LEGEND_COLORS[channel] ?? [1, 1, 1];
  return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
}

export const PHERO_INFO: readonly { name: string; label: string; short: string; text: string }[] = [
  { name: 'food', label: 'Food trail', short: 'Leads to food', text: 'Laid by foragers walking home with a load. The more ants succeed, the stronger the trail — and the more ants follow it. A Gather beacon paints the same scent.' },
  { name: 'alarm', label: 'Alarm', short: 'Danger here', text: 'Released when an ant is attacked. Soldiers run towards it, nurses and foragers away. It fades fast, so a quiet nest is a safe nest.' },
  { name: 'death', label: 'Death', short: 'A corpse lies here', text: 'The smell of a dead nestmate. Workers follow it to carry the body to the midden before disease spreads.' },
  { name: 'dig', label: 'Dig', short: 'Excavate here', text: 'Marks soil the colony wants removed. Your dig designations and Dig beacons lay it; diggers answer it.' },
  { name: 'rally', label: 'Rally', short: 'Assemble here', text: 'A gathering call. Idle ants drift to a Rally beacon and wait there for orders.' },
  { name: 'attack', label: 'Attack', short: 'Fight here', text: 'Marks an enemy or an Attack beacon. Soldiers converge on it and bite whatever is not family.' },
  { name: 'avoid', label: 'Avoid', short: 'Keep out', text: 'A repellent. Ants path around an Avoid beacon — use it to fence off an antlion pit or a flooded gallery.' },
  { name: 'trail', label: 'Trail', short: 'A nestmate walked here', text: 'The faint footprint scent every ant leaves, and the trail you lay yourself while possessing an ant. Scouts use it to explore new ground.' },
];

const CASTE_TEXT: Record<CasteId, { icon: string; lead: string; body: string[] }> = {
  queen: { icon: 'queen', lead: 'The colony is her children. Lose her and it ends.', body: ['She lays eggs for as long as she is fed; the more food in store, the faster she lays.', 'She never leaves her chamber. If the nest floods or is invaded, workers must come to her.', 'You can possess the queen, but there is rarely a good reason to.'] },
  king: { icon: 'queen', lead: 'Termites keep a king beside the queen.', body: ['The royal pair must both live. The king does no work and cannot fight — guard the royal chamber.'] },
  worker: { icon: 'ant', lead: 'Does everything that needs doing.', body: ['Young workers nurse brood and tend the queen; older ones dig, then forage outside where it is dangerous.', 'Which jobs they pick follows the colony priorities — raise a slider and more workers answer that call.'] },
  major: { icon: 'ant', lead: 'A larger worker for heavy loads.', body: ['Carries more, cuts faster and can hold its own in a scrap, but costs more food to raise.'] },
  soldier: { icon: 'soldier', lead: 'Big jaws, short temper.', body: ['Guards entrances, patrols, and answers alarm and attack scent. Never nurses.', 'Soldiers cost more food than workers and gather none. Raise as many as the threat demands and no more.'] },
  nasute: { icon: 'soldier', lead: 'Termite soldier with a glue nozzle for a head.', body: ['Sprays sticky glue from range. Glued enemies cannot move and are easy prey for the workers.'] },
  alate: { icon: 'wing', lead: 'Winged princes and princesses.', body: ['Raised only when the colony is large and rich. On a warm, dry day they gather at the entrance and fly — the nuptial flight that wins an outdoor map.', 'They do no work and are easy prey. Protect them until take-off.'] },
};

const CREATURE_TEXT: Record<CreatureId, { icon: string; lead: string; body: string[] }> = {
  jumpingSpider: { icon: 'spider', lead: 'A stalking hunter that carries ants off one at a time.', body: ['It creeps close, pounces, and retreats to its lair to eat. Too big to enter your tunnels.', 'Mob it with soldiers: ants that latch on slow it down until it cannot leap.'] },
  antlion: { icon: 'warn', lead: 'A pair of jaws at the bottom of a sand pit.', body: ['It never moves. Ants that step on the slope slide to the centre.', 'Drop an Avoid beacon on the pit and the colony will path around it.'] },
  groundBeetle: { icon: 'shield', lead: 'An armoured raider with an appetite for your food.', body: ['Bites hardly dent its shell. It bullies foragers at the entrance and eats what they drop.', 'Acid, venom and numbers get through armour. Or let it eat and leave.'] },
  wasp: { icon: 'wing', lead: 'Death from above for anything caught in the open.', body: ['Swoops on lone workers and avoids soldiers. It cannot follow ants underground.', 'Escort foragers with soldiers, or keep trails short and busy.'] },
  mantis: { icon: 'skull', lead: 'The boss. Slow to turn, lethal in front.', body: ['Each strike kills. Attack from behind and from all sides at once.', 'When it falls it is a mountain of food.'] },
  aphid: { icon: 'drop', lead: 'Livestock. Tended herds drip honeydew.', body: ['Garden ants that find a herd on a plant stem guard and milk it for a steady trickle of food.', 'Predators eat aphids too — a herd is worth a guard post.'] },
  caterpillar: { icon: 'food', lead: 'A walking feast that thrashes when bitten.', body: ['Harmless but strong. It takes a mob to bring one down; the carcass feeds the nest for days.'] },
  worm: { icon: 'food', lead: 'Soft prey from the soil.', body: ['Often uncovered by digging. Easy food if enough workers pile on.'] },
};

const fmt = (n: number): string => (Number.isFinite(n) ? (Math.abs(n) >= 10 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(1)) : '∞');

function casteEntries(): CodexEntry[] {
  const out: CodexEntry[] = [];
  const order: CasteId[] = ['queen', 'king', 'worker', 'major', 'soldier', 'nasute', 'alate'];
  for (const c of order) {
    const rows: string[][] = [];
    for (const id of Object.keys(SPECIES) as SpeciesId[]) {
      const sp = SPECIES[id];
      const d = sp.castes[c];
      if (!d) continue;
      rows.push([sp.name, d.name, fmt(d.maxHealth), fmt(d.attack), fmt(d.speed), fmt(d.foodCost)]);
    }
    if (!rows.length) continue;
    const t = CASTE_TEXT[c];
    out.push({ id: `caste.${c}`, title: c[0].toUpperCase() + c.slice(1), icon: t.icon, lead: t.lead, body: t.body, table: { head: ['Species', 'Called', 'Health', 'Attack', 'Speed', 'Food'], rows } });
  }
  return out;
}

function creatureEntries(): CodexEntry[] {
  return (Object.keys(CREATURES) as CreatureId[]).map((id) => {
    const d = CREATURES[id];
    const t = CREATURE_TEXT[id];
    const facts: [string, string][] = [
      ['Role', d.role[0].toUpperCase() + d.role.slice(1)],
      ['Health', fmt(d.maxHealth)],
      ['Attack', d.attack > 0 ? `${fmt(d.attack)} (${d.attackKind})` : 'None'],
      ['Size', `${fmt(d.length)} voxels${d.clearance > 1.5 ? ' — cannot enter tunnels' : ''}`],
      ['Food value', fmt(d.foodValue)],
    ];
    return { id: `creature.${id}`, title: d.name, icon: t.icon, lead: t.lead, body: t.body, facts };
  });
}

function factionEntries(): CodexEntry[] {
  return FACTION_INFO.map((f) => {
    const sp = SPECIES[f.id];
    const caps = sp.caps;
    const flags: string[] = [];
    if (caps.herdsAphids) flags.push('herds aphids');
    if (caps.rafts) flags.push('rafts on floods');
    if (caps.farmsFungus) flags.push('farms fungus');
    if (caps.eatsWood) flags.push('eats wood');
    if (caps.canFill) flags.push('builds with mud');
    if (caps.sunSensitive) flags.push('burns in open sun');
    return {
      id: `faction.${f.id}`,
      title: f.name,
      icon: sp.kind === 'termite' ? 'wood' : 'ant',
      lead: f.tagline,
      body: f.traits,
      facts: [
        ['Difficulty', f.difficulty[0].toUpperCase() + f.difficulty.slice(1)],
        ['Traits', flags.join(', ') || 'none'],
        ['Castes', Object.values(sp.castes).map((c) => c!.name).join(', ')],
        ['Starts with', `${sp.startingWorkers} workers, ${fmt(sp.startingFood)} food`],
      ],
    };
  });
}

let cached: CodexCategory[] | null = null;

export function buildCodex(): CodexCategory[] {
  if (cached) return cached;
  cached = [
    { id: 'factions', title: 'Factions', icon: 'home', entries: factionEntries() },
    { id: 'castes', title: 'Castes', icon: 'ant', entries: casteEntries() },
    { id: 'creatures', title: 'Creatures', icon: 'spider', entries: creatureEntries() },
    {
      id: 'pheromones',
      title: 'Pheromones',
      icon: 'eye',
      entries: PHERO_INFO.map((p, i) => ({ id: `phero.${PHERO_NAMES[i]}`, title: p.label, icon: 'eye', lead: p.short + '.', body: [p.text, 'Pheromone vision shows every scent in its own colour. Scents evaporate; wind and rain wash them away faster.'], swatch: pheroCss(i) })),
    },
    {
      id: 'weather',
      title: 'Weather',
      icon: 'cloud',
      entries: [
        { id: 'weather.rain', title: 'Rain', icon: 'rain', lead: 'At ant scale every drop is a meteor.', body: ['Rain washes scent trails away and pours into nest entrances. Low galleries flood first; water drains again once the rain stops.', 'Move brood upward when the flooding alert sounds. Workers carry it on their own if Nurse priority is high.', 'Fire ants link bodies into a raft and float it out.'] },
        { id: 'weather.heat', title: 'Heat & drought', icon: 'temp', lead: 'Midday sun dries ants out.', body: ['Foragers lose water in the open and shelter at noon. Forage in the morning and evening; dig deep, where it stays cool.', 'Termite workers burn in direct sun unless they walk under mud cover.'] },
        { id: 'weather.cold', title: 'Cold nights', icon: 'moon', lead: 'Cold ants are slow ants.', body: ['Everything outside slows down after dark and brood develops slower in a cold nest. On farm maps the desk lamp warms one side of the glass.'] },
        { id: 'weather.wind', title: 'Wind', icon: 'wind', lead: 'Wind strips scent from the ground.', body: ['Trails fade faster on a windy day, so distant food is harder to exploit. Beacons keep a route marked.'] },
        { id: 'weather.flood', title: 'Flooding', icon: 'drop', lead: 'Water fills the lowest chambers first.', body: ['Ants under water drown after a short while. Dig a sump below the nest or a second, higher entrance to buy time.'] },
      ],
    },
    {
      id: 'fungus',
      title: 'Fungus',
      icon: 'fungus',
      entries: [
        {
          id: 'fungus.zombie',
          title: 'Zombie fungus',
          icon: 'skull',
          lead: 'Ophiocordyceps: a parasite that drives its host.',
          body: ['A forager brushes spores outside and carries them home without knowing.', 'Healthy workers smell a late infection and drag the victim to the midden. You can act sooner: select the ant and Exile it, or possess a soldier and cull it.'],
          table: {
            head: ['Stage', 'What you see'],
            rows: [
              ['Exposed', 'Nothing yet — spores on the cuticle'],
              ['Incubating', 'Nothing yet — the fungus grows inside'],
              ['Erratic', 'Stumbling, convulsing, wandering off trails'],
              ['Summit', 'Climbs the nearest stem and will not stop'],
              ['Death grip', 'Clamps its jaws on and dies'],
              ['Fruiting', 'A stalk grows from the head'],
              ['Burst', 'Spores rain on everything below'],
            ],
          },
        },
        { id: 'fungus.garden', title: 'Fungus garden', icon: 'fungus', lead: 'Leafcutters eat fungus, not leaves.', body: ['Media workers cut leaves and carry them home; minims chew them into the garden comb, and the fungus that grows is the colony\'s only food.', 'A neglected or overloaded garden grows mould and sickens. Keep Tend garden staffed and do not flood it with leaves it cannot digest.'] },
      ],
    },
    {
      id: 'keeper',
      title: 'The keeper',
      icon: 'hand',
      entries: [
        { id: 'keeper.events', title: 'Keeper events', icon: 'hand', lead: 'On farm maps, the weather has hands.', body: ['Food drops through the lid — the farm\'s only supply from outside.', 'The water dropper floods whatever lies below it.', 'The desk lamp warms one side of the farm; brood near it develops faster, ants in front of it dry out.', 'A tap on the glass panics the colony for a moment.', 'A tube opened to the neighbouring farm lets a rival colony in.', 'In sandbox mode the Keeper tab of the colony panel puts those hands on your side.'] },
      ],
    },
  ];
  return cached;
}

/** Find an entry by id (`creature.wasp`), or by a bare name (`wasp`, `alarm`). */
export function findCodexEntry(id: string): { category: CodexCategory; entry: CodexEntry } | null {
  const cats = buildCodex();
  for (const category of cats) for (const entry of category.entries) if (entry.id === id) return { category, entry };
  for (const category of cats) for (const entry of category.entries) if (entry.id.endsWith('.' + id)) return { category, entry };
  for (const category of cats) if (category.id === id && category.entries.length) return { category, entry: category.entries[0] };
  return null;
}
