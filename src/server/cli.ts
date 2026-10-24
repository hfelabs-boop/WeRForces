#!/usr/bin/env node
// WeRForces command line: starts the simulation back-end with the web front-end,
// optional DIS networking, or runs a scenario headless as a batch job.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createUdpTransport, DisGateway } from '../dis/gateway.js';
import { DEFAULT_CATALOG, mergeCatalog } from '../sim/catalog.js';
import { Engine } from '../sim/engine.js';
import type { ScenarioFile } from '../shared/types.js';
import { IntegrationHub, type IntegrationOptions } from '../integrations/hub.js';
import { parsePlayer } from './fog.js';
import { datasetLoader } from '../terrain/store.js';
import { SimRunner } from './runner.js';
import { type OidcOptions, parseRole, parseRoleRule } from './oidc.js';
import { SimServer } from './server.js';

const HELP = `WeRForces - computer generated forces simulator

Usage: werforces [options]

Options:
  -s, --scenario <file|name>  Scenario JSON file, or a name from ./scenarios
      --catalog <file>        JSON catalog extension: extra/replacement entity types, weapons, sensors, unit templates
  -p, --port <n>              HTTP/WebSocket port (default 8080)
      --host <addr>           Interface to listen on (default 127.0.0.1)
      --run                   Start the simulation running immediately
      --time-scale <x>        Time multiplier (default 1)
      --dis                   Enable DIS networking over UDP
      --dis-port <n>          DIS UDP port (default 3000)
      --dis-announce          send Start/Resume and Stop/Freeze PDUs on run/pause (act as simulation manager)
      --dis-ignore-siman      do not run/pause on other simulation managers' Start/Resume and Stop/Freeze PDUs
      --dis-address <addr>    DIS destination: broadcast/multicast/unicast (default 255.255.255.255)
      --exercise <n>          DIS exercise id (default 1)
      --site <n>              DIS site id (default 1)
      --application <n>       DIS application id (default 3001)
      --api-key <key>         Require this key on /api, /ws and /mcp (or env WERFORCES_API_KEY)
      --player <force:key>    Player key for a force (blue, red, neutral): fog of war, own force only; repeatable.
                              Requires --api-key, which stays the exercise-control (full view) key
      --cors <origin>         Allow cross-origin browser access from an origin ('*' for any); repeatable
      --oidc-issuer <url>     Sign in with OpenID Connect (Keycloak, Entra ID, Okta, Auth0, Google...)
      --oidc-client-id <id>   OIDC client id (redirect URI: <public url>/auth/callback)
      --oidc-client-secret <s> Confidential clients (or env WERFORCES_OIDC_CLIENT_SECRET); public clients use PKCE only
      --oidc-public-url <url> This server's public URL, e.g. https://sim.example.org (default: from the Host header)
      --oidc-scope <scope>    Extra scope to request, e.g. groups; repeatable
      --oidc-role <rule>      claim=value:role, e.g. groups=sim-control:controller or groups=red-cell:red; repeatable,
                              first match wins (roles: controller, blue, red, neutral)
      --oidc-default-role <r> Role for signed-in users no rule matches (default: refuse them)
      --cot <url>             Stream Cursor-on-Target to TAK: udp://239.2.3.1:6969 or tcp://host:8087
      --cot-interval <s>      Seconds between CoT position reports (default 2)
      --webhook <url>         POST simulation events to a URL (Slack/Discord URLs get chat formatting); repeatable
      --terrains <dir>        Folder of imported terrain datasets (default ./terrains; see werforces-terrain)
      --record-interval <s>   Seconds of simulated time between recorded frames for playback/AAR (default 1, 0 = off)
      --headless              No web server; run the scenario and print events
      --duration <s>          Headless only: simulated seconds to run as fast as possible
  -h, --help                  Show this help

MCP: the server exposes an MCP endpoint at /mcp (streamable HTTP). For stdio clients run
\`node dist/mcp/stdio.js --url http://127.0.0.1:8080\`.

Documentation: docs/ in the repository, or /docs on the running server.
`;

function projectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

/** https://github.com/owner/repo/blob/main from package.json's repository field, if any. */
function repoBlobUrl(root: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    const m = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url ?? '');
    return m ? `https://github.com/${m[1]}/blob/main` : undefined;
  } catch {
    return undefined;
  }
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
      catalog: { type: 'string' },
      port: { type: 'string', short: 'p', default: '8080' },
      host: { type: 'string', default: '127.0.0.1' },
      run: { type: 'boolean', default: false },
      'time-scale': { type: 'string', default: '1' },
      dis: { type: 'boolean', default: false },
      'dis-port': { type: 'string', default: '3000' },
      'dis-address': { type: 'string', default: '255.255.255.255' },
      'dis-announce': { type: 'boolean', default: false },
      'dis-ignore-siman': { type: 'boolean', default: false },
      exercise: { type: 'string', default: '1' },
      site: { type: 'string', default: '1' },
      application: { type: 'string', default: '3001' },
      'api-key': { type: 'string', default: process.env.WERFORCES_API_KEY },
      cors: { type: 'string', multiple: true },
      cot: { type: 'string' },
      'cot-interval': { type: 'string', default: '2' },
      'record-interval': { type: 'string', default: '1' },
      terrains: { type: 'string' },
      player: { type: 'string', multiple: true },
      'oidc-issuer': { type: 'string' },
      'oidc-client-id': { type: 'string' },
      'oidc-client-secret': { type: 'string' },
      'oidc-public-url': { type: 'string' },
      'oidc-scope': { type: 'string', multiple: true },
      'oidc-role': { type: 'string', multiple: true },
      'oidc-default-role': { type: 'string' },
      webhook: { type: 'string', multiple: true },
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
  let catalog = DEFAULT_CATALOG;
  if (values.catalog) {
    catalog = mergeCatalog(DEFAULT_CATALOG, JSON.parse(readFileSync(values.catalog, 'utf8')));
    console.log(`Catalog extension: ${values.catalog}`);
  }
  const terrainDir = path.resolve(values.terrains ?? path.join(root, 'terrains'));
  const engine = new Engine({ catalog, terrainLoader: datasetLoader(terrainDir) });
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

  const recordInterval = Number(values['record-interval']);
  if (!Number.isFinite(recordInterval) || recordInterval < 0) throw new Error('--record-interval must be a number of seconds (0 = off)');
  const runner = new SimRunner(engine, undefined, undefined, recordInterval);
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
      announceRunState: values['dis-announce'],
      obeySimulationManager: !values['dis-ignore-siman'],
    });
    runner.gateway.control = { setRunning: (run) => runner.setRunning(run) };
    console.log(`DIS enabled: exercise ${values.exercise}, site ${values.site}, app ${values.application}, udp ${values['dis-address']}:${port}`);
  }
  runner.setRunning(values.run || values.headless);
  runner.start();

  const integrations: IntegrationOptions = {
    cot: values.cot ? { enabled: true, url: values.cot, interval: Number(values['cot-interval']) } : undefined,
    webhooks: (values.webhook ?? []).map((url) => ({
      url,
      format: /hooks\.slack\.com/.test(url) ? 'slack' : /discord(app)?\.com\/api\/webhooks/.test(url) ? 'discord' : 'json',
    })),
  };
  if (values.cot) console.log(`Cursor-on-Target: ${values.cot}`);
  for (const w of integrations.webhooks ?? []) console.log(`Webhook (${w.format}): ${w.url}`);

  if (values.headless) {
    const hub = new IntegrationHub(runner, integrations);
    process.on('exit', () => hub.close());
    engine.on('event', (ev) => {
      if (ev.kind !== 'fire') console.log(`${fmtTime(ev.time)}  ${ev.kind.padEnd(10)} ${ev.text}`);
    });
    console.log('Running headless. Ctrl+C to stop.');
  } else {
    const players = (values.player ?? []).map(parsePlayer);
    if (players.length && !values['api-key']) throw new Error('--player needs --api-key (the exercise-control key)');
    if (new Set(players.map((p) => p.key)).size !== players.length || players.some((p) => p.key === values['api-key'])) throw new Error('player keys must be unique and differ from --api-key');
    for (const p of players) console.log(`Player key for ${['Other', 'Blue', 'Red', 'Neutral'][p.force]}: fog of war on`);
    let oidc: OidcOptions | undefined;
    if (values['oidc-issuer']) {
      if (!values['oidc-client-id']) throw new Error('--oidc-issuer needs --oidc-client-id');
      oidc = {
        issuer: values['oidc-issuer'],
        clientId: values['oidc-client-id'],
        clientSecret: values['oidc-client-secret'] ?? process.env.WERFORCES_OIDC_CLIENT_SECRET,
        publicUrl: values['oidc-public-url'],
        scopes: values['oidc-scope'],
        roles: (values['oidc-role'] ?? []).map(parseRoleRule),
        defaultRole: values['oidc-default-role'] ? parseRole(values['oidc-default-role']) : undefined,
      };
      if (!oidc.roles.length && !oidc.defaultRole) throw new Error('--oidc-issuer needs --oidc-role rules or --oidc-default-role');
      console.log(`OpenID Connect sign-in: ${oidc.issuer} (${oidc.roles.length} role rule${oidc.roles.length === 1 ? '' : 's'})`);
    }
    const server = new SimServer(runner, {
      oidc,
      players,
      port: Number(values.port),
      host: values.host!,
      webRoot: path.join(root, 'dist', 'web'),
      scenarioDir,
      terrainDir,
      apiKey: values['api-key'] || undefined,
      docsDir: path.join(root, 'docs'),
      repoBlobUrl: repoBlobUrl(root),
      corsOrigins: values.cors,
      integrations,
    });
    await server.listen();
    console.log(`WeRForces running at ${server.address}  (scenario: ${engine.scenarioName})`);
    console.log(`  Docs ${server.address}/docs/  ·  REST API ${server.address}/api/docs  ·  MCP ${server.address}/mcp${values['api-key'] ? '  ·  API key required' : ''}`);
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
