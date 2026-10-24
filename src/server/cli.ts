#!/usr/bin/env node
// WeRForces command line: starts the simulation back-end with the web front-end,
// optional DIS networking, or runs a scenario headless as a batch job.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createUdpTransport, DisGateway } from '../dis/gateway.js';
import { Engine } from '../sim/engine.js';
import type { ScenarioFile } from '../shared/types.js';
import { SimRunner } from './runner.js';
import { SimServer } from './server.js';

const HELP = `WeRForces - computer generated forces simulator

Usage: werforces [options]

Options:
  -s, --scenario <file|name>  Scenario JSON file, or a name from ./scenarios
  -p, --port <n>              HTTP/WebSocket port (default 8080)
      --host <addr>           Interface to listen on (default 127.0.0.1)
      --run                   Start the simulation running immediately
      --time-scale <x>        Time multiplier (default 1)
      --dis                   Enable DIS networking over UDP
      --dis-port <n>          DIS UDP port (default 3000)
      --dis-address <addr>    DIS destination: broadcast/multicast/unicast (default 255.255.255.255)
      --exercise <n>          DIS exercise id (default 1)
      --site <n>              DIS site id (default 1)
      --application <n>       DIS application id (default 3001)
      --headless              No web server; run the scenario and print events
      --duration <s>          Headless only: simulated seconds to run as fast as possible
  -h, --help                  Show this help
`;

function projectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function loadScenarioArg(arg: string, scenarioDir: string): ScenarioFile {
  const candidates = [arg, path.join(scenarioDir, arg), path.join(scenarioDir, `${arg}.json`)];
  const file = candidates.find((f) => existsSync(f) && f.endsWith('.json'));
  if (!file) throw new Error(`scenario not found: ${arg}`);
  return JSON.parse(readFileSync(file, 'utf8')) as ScenarioFile;
}

function fmtTime(t: number): string {
  const s = Math.floor(t);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string', short: 's' },
      port: { type: 'string', short: 'p', default: '8080' },
      host: { type: 'string', default: '127.0.0.1' },
      run: { type: 'boolean', default: false },
      'time-scale': { type: 'string', default: '1' },
      dis: { type: 'boolean', default: false },
      'dis-port': { type: 'string', default: '3000' },
      'dis-address': { type: 'string', default: '255.255.255.255' },
      exercise: { type: 'string', default: '1' },
      site: { type: 'string', default: '1' },
      application: { type: 'string', default: '3001' },
      headless: { type: 'boolean', default: false },
      duration: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const root = projectRoot();
  const scenarioDir = path.join(root, 'scenarios');
  const engine = new Engine();
  if (values.scenario) engine.loadScenario(loadScenarioArg(values.scenario, scenarioDir));
  else engine.newScenario('Untitled');

  if (values.headless && values.duration) {
    const duration = Number(values.duration);
    engine.on('event', (ev) => {
      if (ev.kind !== 'fire' && ev.kind !== 'created') console.log(`${fmtTime(ev.time)}  ${ev.kind.padEnd(10)} ${ev.text}`);
    });
    const started = Date.now();
    engine.runFor(duration);
    const all = [...engine.entities.values()];
    console.log(`\nSimulated ${duration}s in ${((Date.now() - started) / 1000).toFixed(2)}s wall time.`);
    for (const force of [1, 2, 3] as const) {
      const list = all.filter((e) => e.force === force);
      if (list.length === 0) continue;
      const lost = list.filter((e) => e.destroyed).length;
      console.log(`  ${['Other', 'Blue', 'Red', 'Neutral'][force].padEnd(8)} ${list.length - lost}/${list.length} surviving`);
    }
    return;
  }

  const runner = new SimRunner(engine);
  runner.setTimeScale(Number(values['time-scale']));
  if (values.dis) {
    const port = Number(values['dis-port']);
    const transport = await createUdpTransport({ port, address: values['dis-address']!, bindAddress: '0.0.0.0' });
    runner.gateway = new DisGateway(engine, transport, {
      port,
      address: values['dis-address'],
      exerciseId: Number(values.exercise),
      site: Number(values.site),
      application: Number(values.application),
    });
    console.log(`DIS enabled: exercise ${values.exercise}, site ${values.site}, app ${values.application}, udp ${values['dis-address']}:${port}`);
  }
  runner.setRunning(values.run || values.headless);
  runner.start();

  if (values.headless) {
    engine.on('event', (ev) => {
      if (ev.kind !== 'fire') console.log(`${fmtTime(ev.time)}  ${ev.kind.padEnd(10)} ${ev.text}`);
    });
    console.log('Running headless. Ctrl+C to stop.');
  } else {
    const server = new SimServer(runner, {
      port: Number(values.port),
      host: values.host!,
      webRoot: path.join(root, 'dist', 'web'),
      scenarioDir,
    });
    await server.listen();
    console.log(`WeRForces running at ${server.address}  (scenario: ${engine.scenarioName})`);
  }
  const shutdown = () => {
    runner.stop();
    runner.gateway?.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(`werforces: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
