// Combined arms through the REST API: a forward observer brings in artillery on a
// defended town while a mechanized platoon carries a rifle squad forward, drops it
// off and supports its assault. Prints the key events and the after-action report.
// Requires Node 20+ and a running server (npm start).
//
//   node examples/combined-arms.mjs [http://127.0.0.1:8080]

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
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const toward = (from, to, metres) => {
  const d = dist(from, to);
  return { x: Math.round(from.x + ((to.x - from.x) / d) * metres), y: Math.round(from.y + ((to.y - from.y) / d) * metres) };
};

// 1. An empty scenario on the default terrain. The objective is Calloway.
await api('POST', '/scenario/new', { name: 'Combined arms' });
const { terrain } = await api('GET', '/simulation');
const town = (name) => terrain.towns.find((t) => t.name === name);
const objective = town('Calloway');
// The attack comes from the nearest other town at least 4 km away; the guns sit further back.
const byDistance = terrain.towns.filter((t) => t !== objective).sort((a, b) => dist(a, objective) - dist(b, objective));
const start = byDistance.find((t) => dist(t, objective) > 4000);
const gunLine = byDistance.find((t) => dist(t, objective) > 8000 && dist(t, objective) < 20000 && t !== start);
console.log(`Objective ${objective.name}; attack from ${start.name} (${(dist(start, objective) / 1000).toFixed(1)} km); guns at ${gunLine.name} (${(dist(gunLine, objective) / 1000).toFixed(1)} km)`);

// 2. Red holds the town with a rifle squad. Its mech platoon waits 3 km behind the
//    town and counterattacks at the 9-minute mark, halting to fight on contact.
await api('POST', '/units', { templateId: 'ru-rifle-squad', force: 2, position: objective, name: 'Red Squad' });
const redMech = await api('POST', '/units', { templateId: 'ru-mech-platoon', force: 2, position: toward(objective, start, -3000), name: 'Red Mech' });
await api('PATCH', `/units/${redMech.id}`, { reactions: { onContact: 'halt' } });
await api('POST', `/units/${redMech.id}/plan`, {
  name: 'Counterattack',
  statements: [
    { kind: 'waitUntil', condition: { type: 'simTime', time: 540 } },
    { kind: 'task', task: { type: 'moveTo', target: objective } },
  ],
});

// 3. A forward observer on the highest spot 2-3.5 km out that can see the town.
let op = null;
for (let r = 2000; r <= 3500; r += 250) {
  for (let a = 0; a < 360; a += 15) {
    const p = { x: Math.round(objective.x + Math.sin((a * Math.PI) / 180) * r), y: Math.round(objective.y + Math.cos((a * Math.PI) / 180) * r) };
    const pt = await api('GET', `/terrain/point?x=${p.x}&y=${p.y}`).catch(() => null);
    if (!pt || pt.water || pt.forest) continue;
    const los = await api('POST', '/terrain/line-of-sight', { from: { ...p, height: 2 }, to: { ...objective, height: 2 } });
    if (los.visible && (!op || pt.elevation > op.elevation)) op = { ...p, elevation: pt.elevation };
  }
}
const fo = await api('POST', '/entities', { typeId: 'us-fo-team', force: 1, position: op, name: 'FO Hawk' });
await api('PATCH', `/entities/${fo.id}`, { roe: 'holdFire' });
console.log(`${fo.name} at (${op.x}, ${op.y}), ${Math.round(op.elevation)} m, ${(dist(op, objective) / 1000).toFixed(1)} km from ${objective.name}; reactions ${JSON.stringify(fo.reactions)}`);

// 4. Blue: a Paladin platoon at the gun line; a mech platoon with a rifle squad aboard.
const guns = await api('POST', '/units', { templateId: 'us-paladin-platoon', force: 1, position: gunLine, name: 'Steel Rain' });
const mech = await api('POST', '/units', { templateId: 'us-mech-platoon', force: 1, position: start, name: 'Team MECH' });
const squad = await api('POST', '/units', { templateId: 'us-rifle-squad', force: 1, position: toward(start, objective, -60), name: '1st Squad' });
await api('POST', `/units/${squad.id}/embark`, { carrierId: mech.id });
const carried = (await api('GET', `/units/${mech.id}`)).members.reduce((n, m) => n + (m.passengers?.length ?? 0), 0);
console.log(`${squad.name}: ${carried} of 9 mounted in ${mech.name} (6 seats per Bradley)`);

// 5. Orders. The mech platoon drives to a dismount point 1.5 km short of the town,
//    unloads, then moves up to support. The squad's own order waits until it is out:
//    assault the town, halting to fight whenever it meets the enemy.
const dismountPoint = toward(objective, start, 1500);
await api('POST', '/graphics', { kind: 'point', name: 'DISMOUNT', points: [dismountPoint] });
await api('POST', `/units/${mech.id}/plan`, {
  name: 'Carry and support',
  statements: [
    { kind: 'setFormation', formation: 'column' },
    { kind: 'task', task: { type: 'moveTo', target: dismountPoint } },
    { kind: 'task', task: { type: 'dismount' } },
    { kind: 'setFormation', formation: 'line' },
    { kind: 'task', task: { type: 'wait', duration: 120 } },
    { kind: 'task', task: { type: 'moveTo', target: toward(objective, start, 700) } },
  ],
});
await api('PATCH', `/units/${squad.id}`, { reactions: { onContact: 'halt' } });
await api('POST', `/units/${squad.id}/task`, { type: 'moveTo', target: objective });

// 6. Run 30 minutes, a minute at a time, printing what matters.
let seq = (await api('GET', '/simulation')).lastEventSeq;
const interesting = /called for fire|dismounted|bailed out| destroyed by |complete|withdrawing|halted/;
for (let minute = 1; minute <= 30; minute++) {
  const s = await api('POST', '/simulation/step', { seconds: 60 });
  const events = await api('GET', `/events?since=${seq}&kinds=task,destroyed,info&limit=1000`);
  for (const ev of events) if (interesting.test(ev.text)) console.log(`  ${clock(ev.time)}  ${ev.text}`);
  seq = s.lastEventSeq;
}

// 7. The after-action review.
const r = await api('GET', '/recording/report');
const names = ['Other', 'Blue', 'Red', 'Neutral'];
console.log('\nAfter-action review');
for (const f of r.forces) console.log(`  ${names[f.force].padEnd(5)} ${String(f.end).padStart(2)}/${f.start} left, ${f.kills} kills, ${f.shots} rounds fired`);
const byWeapon = {};
for (const k of r.kills) byWeapon[k.weaponId ?? 'unknown'] = (byWeapon[k.weaponId ?? 'unknown'] ?? 0) + 1;
console.log(`  Kills by weapon: ${Object.entries(byWeapon).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${n}`).join(', ')}`);
console.log(`  Artillery rounds: ${r.shotsByWeapon['how-155mm'] ?? 0}`);
