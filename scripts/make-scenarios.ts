// Generates the sample scenarios in ./scenarios from the default procedural terrain.
// Run with: npx tsx scripts/make-scenarios.ts

import { writeFileSync } from 'node:fs';
import { simplifyPolyline } from '../src/sim/pathfinding.js';
import { DEFAULT_TERRAIN, Terrain } from '../src/sim/terrain.js';
import type { EntityRecord, Graphic, ScenarioFile, UnitRecord, Vec2 } from '../src/shared/types.js';
import { Engine } from '../src/sim/engine.js';

const terrain = Terrain.generate(DEFAULT_TERRAIN);
const town = (name: string) => {
  const t = terrain.towns.find((x) => x.name === name);
  if (!t) throw new Error(`no town ${name}`);
  return { x: t.x, y: t.y };
};

/** A road-following route between two points, as a tactical graphic. */
function roadRoute(id: string, name: string, from: Vec2, to: Vec2, force: 0 | 1 | 2 | 3): Graphic {
  const path = terrain.planRoute(from, to, 'ground', 0.4);
  if (!path) throw new Error(`no route for ${name}`);
  const pts = simplifyPolyline([from, ...path], 60).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  return { id, kind: 'route', name, points: pts, force };
}

function box(id: string, name: string, c: Vec2, r: number, force: 0 | 1 | 2 | 3): Graphic {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    pts.push({ x: Math.round(c.x + Math.sin(a) * r), y: Math.round(c.y + Math.cos(a) * r) });
  }
  return { id, kind: 'area', name, points: pts, force };
}

/** Build a scenario through the engine so unit templates are expanded consistently. */
function build(
  name: string,
  description: string,
  graphics: Graphic[],
  setup: (eng: Engine) => void,
): ScenarioFile {
  const eng = new Engine({ terrain });
  eng.newScenario(name);
  for (const g of graphics) eng.addGraphic(g.kind, g.points, g.name, g.force, g.id);
  setup(eng);
  const s = eng.toScenario();
  s.description = description;
  return s;
}

const calloway = town('Calloway');
const eastwick = town('Eastwick');
const fallow = town('Fallow Cross');
const brenham = town('Brenham');
const dunmore = town('Dunmore');

const advanceStart = { x: eastwick.x - 300, y: eastwick.y + 900 };
const crossroads = build(
  'Calloway Crossroads',
  'Combined-arms meeting engagement. A US armor/mech task force advances from Eastwick to seize the town of Calloway, held by a Russian tank platoon, infantry and an SA-8. Apaches screen the advance; F-16s fly CAP over the assembly area; a Russian supply convoy and civilians move on the road network.',
  [
    roadRoute('G1', 'Route IRON', advanceStart, calloway, 1),
    box('G2', 'OBJ CALLOWAY', calloway, 900, 1),
    { id: 'G3', kind: 'phaseLine', name: 'PL AMBER', points: [{ x: 2000, y: 9000 }, { x: 15500, y: 9000 }], force: 1 },
    roadRoute('G4', 'Route SUPPLY', fallow, calloway, 2),
    { id: 'G5', kind: 'route', name: 'Apache Screen', points: [{ x: 9500, y: 6000 }, { x: 12500, y: 8000 }, { x: 9500, y: 10000 }, { x: 6500, y: 8000 }, { x: 9500, y: 6000 }], force: 1 },
    roadRoute('G6', 'Civil Traffic', brenham, eastwick, 3),
  ],
  (eng) => {
    const tanks = eng.createUnitFromTemplate('us-tank-platoon', 1, advanceStart.x, advanceStart.y, 0, 'Team ARMOR');
    eng.assignPlan(tanks.id, {
      name: 'Seize OBJ CALLOWAY',
      statements: [
        { kind: 'setFormation', formation: 'column' },
        { kind: 'task', task: { type: 'followRoute', routeId: 'G1' } },
        { kind: 'setFormation', formation: 'wedge' },
        { kind: 'task', task: { type: 'moveTo', target: calloway } },
      ],
    });
    const mech = eng.createUnitFromTemplate('us-mech-platoon', 1, advanceStart.x + 200, advanceStart.y - 600, 0, 'Team MECH');
    eng.assignPlan(mech.id, {
      name: 'Follow and support',
      statements: [
        { kind: 'waitUntil', condition: { type: 'simTime', time: 90 } },
        { kind: 'setFormation', formation: 'column' },
        { kind: 'task', task: { type: 'followRoute', routeId: 'G1' } },
        { kind: 'task', task: { type: 'moveTo', target: { x: calloway.x + 400, y: calloway.y - 500 } } },
      ],
    });
    const scouts = eng.createUnitFromTemplate('us-scout-section', 1, advanceStart.x - 200, advanceStart.y + 400, 0, 'Scout 1');
    eng.setRoe(scouts.id, 'returnFire');
    eng.assignTask(scouts.id, { type: 'moveTo', target: { x: calloway.x + 2600, y: calloway.y - 3200 } });
    const apaches = eng.createUnitFromTemplate('us-attack-team', 1, eastwick.x + 800, eastwick.y - 600, 0, 'Gunslinger');
    eng.assignPlan(apaches.id, {
      name: 'Screen',
      statements: [
        { kind: 'waitUntil', condition: { type: 'simTime', time: 60 } },
        { kind: 'task', task: { type: 'patrol', routeId: 'G5' } },
      ],
    });
    const cap = eng.createUnitFromTemplate('us-fighter-flight', 1, 13000, 2500, 0, 'Viper');
    eng.assignTask(cap.id, { type: 'orbit', center: { x: 13500, y: 3000 }, radius: 2000 });

    const redTanks = eng.createUnitFromTemplate('ru-tank-platoon', 2, calloway.x + 300, calloway.y - 600, Math.PI, 'Tank Plt 1');
    eng.stop(redTanks.id);
    const redInf = eng.createUnitFromTemplate('ru-rifle-squad', 2, calloway.x - 150, calloway.y - 250, Math.PI, 'Squad 1');
    eng.stop(redInf.id);
    const bmps = eng.createUnitFromTemplate('ru-mech-platoon', 2, calloway.x - 900, calloway.y - 400, Math.PI * 0.8, 'Mech Plt 2');
    eng.assignPlan(bmps.id, {
      name: 'Counterattack',
      statements: [
        { kind: 'setRoe', roe: 'holdFire' },
        { kind: 'waitUntil', condition: { type: 'enemyDetected' } },
        { kind: 'setRoe', roe: 'fireAtWill' },
        { kind: 'task', task: { type: 'moveTo', target: { x: calloway.x + 900, y: calloway.y - 2200 } } },
      ],
    });
    eng.createEntity({ typeId: 'ru-sa8', force: 2, x: calloway.x + 500, y: calloway.y + 600, heading: Math.PI, name: 'Osa 1' });
    const convoy = eng.createUnitFromTemplate('ru-supply-convoy', 2, fallow.x, fallow.y, Math.PI, 'Convoy 7');
    eng.setRoe(convoy.id, 'returnFire');
    eng.assignTask(convoy.id, { type: 'followRoute', routeId: 'G4' });
    for (let i = 0; i < 3; i++) {
      const c = eng.createEntity({ typeId: 'civ-car', force: 3, x: brenham.x + i * 30, y: brenham.y - i * 30, name: `Civ Car ${i + 1}` });
      eng.assignPlan(c.id, { name: 'Commute', statements: [{ kind: 'task', task: { type: 'wait', duration: i * 45 } }, { kind: 'task', task: { type: 'patrol', routeId: 'G6' } }] });
    }
  },
);

const lakeCenter = { x: 6200, y: 2600 };
/** First land point walking north from the lake, plus a margin. */
function northShore(x: number): Vec2 {
  let y = lakeCenter.y;
  while (y < terrain.spec.size && terrain.isWater(x, y)) y += 25;
  return { x, y: y + 250 };
}
const shore = northShore(6900);
const lake = build(
  'Lakeside Patrol',
  'Small-unit scenario on the southern lake. US patrol boats sweep the lake while a rifle squad holds the north shore; a Russian recon patrol probes along the shore road and a Hind hunts the boats.',
  [
    { id: 'G1', kind: 'route', name: 'Lake Sweep', points: [{ x: 4600, y: 2000 }, { x: 6400, y: 4600 }, { x: 7900, y: 2200 }, { x: 6200, y: 900 }, { x: 4600, y: 2000 }], force: 1 },
    roadRoute('G2', 'Shore Road', dunmore, { x: 9400, y: 7200 }, 2),
    box('G3', 'OP NORTH SHORE', shore, 500, 1),
  ],
  (eng) => {
    const boats = [
      eng.createEntity({ typeId: 'us-patrol-boat', force: 1, x: lakeCenter.x - 900, y: lakeCenter.y, name: 'PB 101' }),
      eng.createEntity({ typeId: 'us-patrol-boat', force: 1, x: lakeCenter.x - 900, y: lakeCenter.y - 150, name: 'PB 102' }),
    ];
    const pb = eng.groupUnit(boats.map((b) => b.id), 'Boat Section', 'echelonRight', 120, 'section');
    eng.assignTask(pb.id, { type: 'patrol', routeId: 'G1' });
    const sq = eng.createUnitFromTemplate('us-rifle-squad', 1, shore.x, shore.y, Math.PI, '1st Squad');
    eng.stop(sq.id);
    eng.createEntity({ typeId: 'us-stinger-team', force: 1, x: shore.x + 100, y: shore.y + 100, heading: Math.PI, name: 'Stinger 1' });
    const recon = eng.createUnitFromTemplate('ru-recon-patrol', 2, dunmore.x, dunmore.y, 0, 'Dozor');
    eng.assignTask(recon.id, { type: 'patrol', routeId: 'G2' });
    const hind = eng.createEntity({ typeId: 'ru-mi24', force: 2, x: 1500, y: 9000, heading: Math.PI * 0.7, name: 'Hind 21' });
    eng.assignPlan(hind.id, {
      name: 'Hunt boats',
      statements: [
        { kind: 'task', task: { type: 'wait', duration: 120 } },
        { kind: 'task', task: { type: 'moveTo', target: lakeCenter } },
        { kind: 'task', task: { type: 'orbit', center: lakeCenter, radius: 2000 } },
      ],
    });
  },
);

const records = (s: ScenarioFile) => `${s.entities.length} entities, ${s.units.length} units, ${s.graphics.length} graphics`;
for (const [file, s] of [
  ['calloway-crossroads', crossroads],
  ['lakeside-patrol', lake],
] as const) {
  writeFileSync(`scenarios/${file}.json`, JSON.stringify(s, null, 2) + '\n');
  console.log(`scenarios/${file}.json: ${records(s)}`);
}
export type { EntityRecord, UnitRecord };
