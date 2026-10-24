// Drive WeRForces through the REST API: set up a small engagement, give a unit a plan,
// simulate it and print what happened. Requires Node 20+ and a running server (npm start).
//
//   node examples/rest-client.mjs [http://127.0.0.1:8080]
//   WERFORCES_API_KEY=secret node examples/rest-client.mjs   # if the server uses --api-key

const BASE = process.argv[2] ?? process.env.WERFORCES_URL ?? 'http://127.0.0.1:8080';
const KEY = process.env.WERFORCES_API_KEY;

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (KEY) headers.Authorization = `Bearer ${KEY}`;
  const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error?.message ?? res.status}`);
  return data;
}

const clock = (t) => new Date(t * 1000).toISOString().slice(11, 19);

// 1. Start from an empty scenario on the default terrain.
await api('POST', '/scenario/new', { name: 'REST example' });
const sim = await api('GET', '/simulation');
const town = (name) => sim.terrain.towns.find((t) => t.name === name);
console.log(`Terrain ${sim.terrain.size / 1000} km square; towns: ${sim.terrain.towns.map((t) => t.name).join(', ')}`);

// 2. A blue tank platoon at Eastwick; a red mech platoon defending Brenham.
const blue = await api('POST', '/units', { templateId: 'us-tank-platoon', force: 1, position: { town: 'Eastwick' }, name: 'Blue Armor' });
const red = await api('POST', '/units', { templateId: 'ru-mech-platoon', force: 2, position: { town: 'Brenham' }, name: 'Red Mech' });
console.log(`Created ${blue.name} (${blue.id}, ${blue.members.length} tanks) and ${red.name} (${red.id}, ${red.members.length} BMPs)`);

// 3. A staging point 3 km short of Brenham on the line from Eastwick, drawn as a point graphic.
const [e, b] = [town('Eastwick'), town('Brenham')];
const len = Math.hypot(e.x - b.x, e.y - b.y);
const staging = { x: Math.round(b.x + ((e.x - b.x) / len) * 3000), y: Math.round(b.y + ((e.y - b.y) / len) * 3000) };
await api('POST', '/graphics', { kind: 'point', name: 'Staging', points: [staging] });

// 4. The plan: road march in column with return-fire ROE, deploy into a wedge at the
//    staging point, go weapons free, then assault the town.
await api('POST', `/units/${blue.id}/plan`, {
  name: 'Seize Brenham',
  statements: [
    { kind: 'setFormation', formation: 'column' },
    { kind: 'setRoe', roe: 'returnFire' },
    { kind: 'task', task: { type: 'moveTo', target: staging } },
    { kind: 'setFormation', formation: 'wedge' },
    { kind: 'setRoe', roe: 'fireAtWill' },
    { kind: 'task', task: { type: 'wait', duration: 30 } },
    { kind: 'task', task: { type: 'moveTo', target: { town: 'Brenham' } } },
  ],
});

// 5. Simulate one minute at a time and print the important events as they happen.
let seq = (await api('GET', '/simulation')).lastEventSeq;
for (let minute = 1; minute <= 45; minute++) {
  const s = await api('POST', '/simulation/step', { seconds: 60 });
  const events = await api('GET', `/events?since=${seq}&kinds=destroyed,damaged,task&limit=200`);
  for (const ev of events) console.log(`  ${clock(ev.time)}  ${ev.text}`);
  seq = s.lastEventSeq;
  if (s.strength.some((f) => f.alive === 0)) break;
}

const final = await api('GET', '/simulation');
console.log(`\nAfter ${clock(final.time)}: ${final.strength.map((f) => `${f.name} ${f.alive}/${f.total}`).join(', ')}`);
