// End-to-end test of the DIS/HLA bridge (hla/): a real OHLA RTI process, two bridge
// federates and two engines. Engine A and engine B never exchange DIS directly; each
// talks unicast UDP to its own bridge, and the bridges talk HLA through the RTI.
//
//   engine A (127.0.0.2) <-DIS-> bridge A (127.0.0.3) <-HLA-> RTI <-HLA-> bridge B (127.0.0.5) <-DIS-> engine B (127.0.0.4)
//
// Skipped unless hla/fetch-ohla.sh and hla/build.sh have been run and Java is installed.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUdpTransport, DisGateway } from '../src/dis/gateway.js';
import { Engine } from '../src/sim/engine.js';
import type { Entity } from '../src/sim/entity.js';
import { Terrain } from '../src/sim/terrain.js';

const HLA = path.resolve('hla');

async function canBind(address: string): Promise<boolean> {
  const sock = dgram.createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => {
      sock.once('error', reject);
      sock.bind(0, address, () => resolve());
    });
    return true;
  } catch {
    return false;
  } finally {
    sock.close();
  }
}

function whyMissing(): string | undefined {
  if (!existsSync(path.join(HLA, 'vendor', 'ohla-0.6.1', 'ohla-rti.jar'))) return 'hla/vendor is missing (run hla/fetch-ohla.sh)';
  for (const jar of ['werforces-hla-bridge.jar', 'ieee-1516e-java9.jar', 'ohla-rti-port.jar']) {
    if (!existsSync(path.join(HLA, 'build', jar))) return `hla/build/${jar} is missing (run hla/build.sh)`;
  }
  if (spawnSync('java', ['-version']).status !== 0) return 'java is not installed';
  return undefined;
}

// The two sides use separate loopback addresses so that each engine hears only its bridge.
const ADDR = { engineA: '127.0.0.2', bridgeA: '127.0.0.3', engineB: '127.0.0.4', bridgeB: '127.0.0.5' };
const skip = whyMissing() ?? ((await canBind(ADDR.bridgeB)) ? undefined : 'loopback addresses 127.0.0.2-5 cannot be bound');
if (skip) console.warn(`[hla.test] skipping the DIS/HLA bridge test: ${skip}`);

interface Child {
  name: string;
  proc: ChildProcess;
  log: string[];
}

const children: Child[] = [];

function start(name: string, script: string, args: string[]): Child {
  const proc = spawn('bash', [path.join(HLA, script), ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, OHLA_LOG_LEVEL: 'WARN' } });
  const child: Child = { name, proc, log: [] };
  const collect = (b: Buffer) => child.log.push(...b.toString().split('\n').filter((l) => l && !l.startsWith('Picked up JAVA_TOOL_OPTIONS')));
  proc.stdout!.on('data', collect);
  proc.stderr!.on('data', collect);
  children.push(child);
  return child;
}

function logs(): string {
  return children.map((c) => `--- ${c.name} (exit ${c.proc.exitCode ?? 'running'})\n${c.log.slice(-25).join('\n')}`).join('\n');
}

async function waitFor<T>(what: string, fn: () => T | undefined | null | false, ms = 10000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}\n${logs()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function freePort(kind: 'tcp' | 'udp'): Promise<number> {
  if (kind === 'tcp') {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, r));
    const port = (srv.address() as net.AddressInfo).port;
    await new Promise((r) => srv.close(r));
    return port;
  }
  const sock = dgram.createSocket('udp4');
  await new Promise<void>((r) => sock.bind(0, r));
  const port = sock.address().port;
  sock.close();
  return port;
}

async function rtiListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

async function stopChild(c: Child): Promise<void> {
  if (c.proc.exitCode !== null || c.proc.signalCode !== null) return;
  const exited = new Promise((r) => c.proc.once('exit', r));
  c.proc.kill('SIGTERM');
  const timer = setTimeout(() => c.proc.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(timer);
}

describe.skipIf(!!skip)(`DIS/HLA bridge over the OHLA RTI${skip ? ` (skipped: ${skip})` : ''}`, () => {
  const terrain = Terrain.generate({ size: 6000, seed: 7, towns: 2 });
  const a = new Engine({ terrain, seed: 3 });
  const b = new Engine({ terrain, seed: 3 });
  const gateways: DisGateway[] = [];
  let pump: ReturnType<typeof setInterval> | undefined;
  let pumpA = true;

  beforeAll(async () => {
    a.newScenario('A', terrain.spec);
    b.newScenario('B', terrain.spec);
    const rtiPort = await freePort('tcp');
    const portA = await freePort('udp');
    const portB = await freePort('udp');
    const federation = `WeRForcesTest${process.pid}`;

    start('rti', 'run-rti.sh', [String(rtiPort)]);
    const until = Date.now() + 15000;
    while (!(await rtiListening(rtiPort))) {
      if (Date.now() > until) throw new Error(`the RTI did not start\n${logs()}`);
      await new Promise((r) => setTimeout(r, 100));
    }

    const bridge = (name: string, listen: string, port: number, engine: string, site: number) =>
      start(name, 'run-bridge.sh', [
        '--rti-host', '127.0.0.1', '--rti-port', String(rtiPort), '--federation', federation, '--federate', name,
        '--dis-bind', listen, '--dis-port', String(port), '--dis-address', engine, '--dis-send-port', String(port),
        '--site', String(site), '--application', '1', '--refresh', '3', '--heartbeat', '1', '--timeout', '3', '--verbose',
      ]);
    const bridgeA = bridge('bridge-A', ADDR.bridgeA, portA, ADDR.engineA, 11);
    await waitFor('bridge A to join', () => bridgeA.log.includes('READY'), 20000);
    const bridgeB = bridge('bridge-B', ADDR.bridgeB, portB, ADDR.engineB, 12);
    await waitFor('bridge B to join', () => bridgeB.log.includes('READY'), 20000);

    // createUdpTransport binds and sends to the same port, so the engine and its bridge
    // share the port and differ by address.
    const ta = await createUdpTransport({ port: portA, address: ADDR.bridgeA, bindAddress: ADDR.engineA });
    const tb = await createUdpTransport({ port: portB, address: ADDR.bridgeB, bindAddress: ADDR.engineB });
    gateways.push(new DisGateway(a, ta, { site: 1, application: 1, heartbeat: 1 }), new DisGateway(b, tb, { site: 2, application: 1, heartbeat: 1 }));
    pump = setInterval(() => {
      if (pumpA) gateways[0].update(true, 1);
      gateways[1].update(true, 1);
    }, 50);
  }, 60000);

  afterAll(async () => {
    if (pump) clearInterval(pump);
    for (const g of gateways) g.close();
    // Bridges first, so they can still resign from the federation.
    await Promise.all(children.filter((c) => c.name !== 'rti').map(stopChild));
    await Promise.all(children.map(stopChild));
    if (process.env.HLA_TEST_LOGS) console.log(children.map((c) => `--- ${c.name}\n${c.log.join('\n')}`).join('\n'));
  }, 20000);

  const remoteNamed = (engine: Engine, name: string): Entity | undefined => [...engine.entities.values()].find((e) => e.remote && e.name === name);
  let tank: Entity;
  let tankInB: Entity;

  it('reflects an entity created in engine A into engine B as a remote entity', async () => {
    const town = terrain.towns[0];
    tank = a.createEntity({ typeId: 'us-m1a2', force: 1, x: town.x, y: town.y, heading: 1.0, name: 'Alpha 1' });
    tankInB = await waitFor('Alpha 1 to appear in engine B', () => remoteNamed(b, 'Alpha 1'));
    expect(tankInB.id).toMatch(/^R12-1-\d+$/); // bridge B's site and application
    expect(tankInB.type.id).toBe('us-m1a2');
    expect(tankInB.force).toBe(1);
    expect(Math.hypot(tankInB.x - tank.x, tankInB.y - tank.y, tankInB.z - tank.z)).toBeLessThan(1);
    expect(tankInB.heading).toBeCloseTo(1.0, 4);
    // Nothing is echoed back: engine A still only has its own tank.
    expect([...a.entities.values()].filter((e) => e.remote)).toEqual([]);
  });

  it('moves the remote entity when the local one moves', async () => {
    tank.x += 150;
    tank.y -= 80;
    tank.heading = 2.0;
    await waitFor('Alpha 1 to move in engine B', () => Math.hypot(tankInB.x - tank.x, tankInB.y - tank.y) < 1);
    expect(Math.abs(tankInB.z - tank.z)).toBeLessThan(1);
    expect(tankInB.heading).toBeCloseTo(2.0, 4);

    // Velocity travels as an ECEF VelocityVector and comes back as the same ENU vector.
    tank.speed = 8;
    await waitFor('the velocity to reach engine B', () => Math.hypot(tankInB.velocity.x - tank.velocity.x, tankInB.velocity.y - tank.velocity.y) < 0.01);
    tank.speed = 0;
    await waitFor('Alpha 1 to stop in engine B', () => Math.hypot(tankInB.velocity.x, tankInB.velocity.y) < 0.01 && Math.hypot(tankInB.x - tank.x, tankInB.y - tank.y) < 1);
  });

  it('carries fire and detonations from engine A to engine B', async () => {
    const town = terrain.towns[0];
    const target = b.createEntity({ typeId: 'ru-t72b3', force: 2, x: town.x + 900, y: town.y, name: 'Bravo 1' });
    const targetInA = await waitFor('Bravo 1 to appear in engine A', () => remoteNamed(a, 'Bravo 1'));
    expect(targetInA.id).toMatch(/^R11-1-\d+$/);
    expect(Math.hypot(targetInA.x - target.x, targetInA.y - target.y)).toBeLessThan(1);

    const seq = b.eventsSince(0).at(-1)?.seq ?? 0;
    const weapon = a.catalog.weapon('gun-120mm');
    // Fire until a round hits, so engine B adjudicates the damage to its own Bravo 1.
    let adjudicated = false;
    for (let shot = 1; shot <= 10 && !adjudicated; shot++) {
      const range = Math.hypot(targetInA.x - tank.x, targetInA.y - tank.y);
      a.launch({ eventNumber: a.nextEventNumber(), shooterId: tank.id, targetId: targetInA.id, weapon, from: tank.position, to: targetInA.position, fireTime: a.time, impactTime: a.time, range });
      a.step(0.1);
      const det = await waitFor(`detonation ${shot} in engine B`, () =>
        b.eventsSince(seq).filter((e) => e.kind === 'detonation' && e.entityId === tankInB.id).at(shot - 1),
      );
      adjudicated = det.text.startsWith('external detonation on Bravo 1');
      if (adjudicated) expect(det.targetId).toBe(target.id);
    }
    const fires = b.eventsSince(seq).filter((e) => e.kind === 'fire');
    expect(fires.length).toBeGreaterThan(0);
    // The target identifier made the round trip DIS -> HLA object name -> DIS back to B's own entity.
    expect(fires[0].entityId).toBe(tankInB.id);
    expect(fires[0].targetId).toBe(target.id);
    expect(fires[0].text).toBe('Alpha 1 fired at Bravo 1 (DIS)');
    expect(adjudicated).toBe(true);
  }, 30000);

  it('removes the remote entity when the local one is deleted', async () => {
    a.deleteObject(tank.id);
    await waitFor('Alpha 1 to leave engine B', () => !b.entities.has(tankInB.id));
    expect(remoteNamed(b, 'Alpha 1')).toBeUndefined();
  });

  it('sends heartbeats for entities reflected from HLA', async () => {
    // Bravo 1 is static, so bridge B forwards no attribute changes, yet bridge A keeps
    // repeating its Entity State to engine A (heartbeat 1 s here, 5 s by default).
    const before = gateways[0].pdusReceived;
    await new Promise((r) => setTimeout(r, 2500));
    expect(gateways[0].pdusReceived - before).toBeGreaterThanOrEqual(2);
    expect(remoteNamed(a, 'Bravo 1')).toBeDefined();
  });

  it('deletes the HLA object when its DIS entity stops sending', async () => {
    const town = terrain.towns[0];
    a.createEntity({ typeId: 'us-hmmwv', force: 1, x: town.x - 300, y: town.y, name: 'Alpha 2' });
    const remote = await waitFor('Alpha 2 to appear in engine B', () => remoteNamed(b, 'Alpha 2'));
    pumpA = false; // engine A goes silent
    await waitFor('Alpha 2 to time out in the bridge', () => !b.entities.has(remote.id), 8000);
    pumpA = true;
  }, 15000);
});
