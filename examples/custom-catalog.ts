// Extend the simulation object model without touching the source: add a new weapon,
// a new entity type and a unit template, then fight a quick duel against the stock T-72.
//
//   npx tsx examples/custom-catalog.ts

import { DEG } from '../src/shared/math.js';
import type { Catalog } from '../src/shared/types.js';
import { DEFAULT_CATALOG } from '../src/sim/catalog.js';
import { Engine } from '../src/sim/engine.js';

const catalog: Catalog = {
  ...DEFAULT_CATALOG,
  weapons: [
    ...DEFAULT_CATALOG.weapons,
    {
      id: 'gun-120mm-l55',
      name: '120mm L55 smoothbore',
      munition: { kind: 2, domain: 2, country: 78, category: 2, subcategory: 1, specific: 0, extra: 0 },
      minRange: 50,
      maxRange: 4500,
      reloadTime: 6,
      ammo: 42,
      projectileSpeed: 1750,
      pk: { armored: 0.75, light: 0.9, soft: 0.9, lifeform: 0.3, ship: 0.15 },
      targets: ['ground', 'lifeform', 'surface'],
    },
  ],
  entityTypes: [
    ...DEFAULT_CATALOG.entityTypes,
    {
      id: 'de-leopard2a6',
      name: 'Leopard 2A6',
      description: 'German main battle tank',
      domain: 'ground',
      symbol: 'armor',
      armor: 'armored',
      dis: { kind: 1, domain: 1, country: 78, category: 1, subcategory: 1, specific: 0, extra: 0 },
      maxSpeed: 19,
      cruiseSpeed: 12,
      acceleration: 2.6,
      turnRate: 35 * DEG,
      offroadFactor: 0.72,
      sensorHeight: 2.5,
      sensors: ['thermal-sight', 'eye'],
      weapons: ['gun-120mm-l55', 'mg-762'],
      crew: 4,
    },
  ],
  unitTemplates: [
    ...DEFAULT_CATALOG.unitTemplates,
    { id: 'de-tank-platoon', name: 'DE Tank Platoon', echelon: 'platoon', members: Array(4).fill('de-leopard2a6'), formation: 'wedge', spacing: 90 },
  ],
};

// The catalog is validated when the engine is created (unknown weapon/sensor ids throw).
const engine = new Engine({ catalog });
engine.newScenario('Leopard vs T-72');
const [a, b] = engine.terrain.towns;
const leos = engine.createUnitFromTemplate('de-tank-platoon', 1, a.x, a.y, 0, 'Leo Plt');
engine.createUnitFromTemplate('ru-tank-platoon', 2, b.x, b.y, 0, 'T-72 Plt');
engine.assignTask(leos.id, { type: 'moveTo', target: b });
engine.on('event', (ev) => ev.kind === 'destroyed' && console.log(`${Math.round(ev.time)}s  ${ev.text}`));
engine.runFor(3600);
for (const f of [1, 2] as const) {
  const list = [...engine.entities.values()].filter((e) => e.force === f);
  console.log(`${f === 1 ? 'Leopards' : 'T-72s'}: ${list.filter((e) => e.alive).length}/${list.length} survive`);
}
