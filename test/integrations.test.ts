import dgram from 'node:dgram';
import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { LocalFrame } from '../src/dis/geodesy.js';
import { CotPublisher, cotType, entityToCot, parseCotUrl, type CotSink } from '../src/integrations/cot.js';
import { entitiesGeoJSON, graphicsGeoJSON, sceneKML } from '../src/integrations/gis.js';
import { formatPayload, signPayload, WebhookDispatcher } from '../src/integrations/webhooks.js';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';

const terrain = Terrain.generate({ size: 6000, seed: 3, towns: 2 });

function engineWithEntities() {
  const eng = new Engine({ terrain });
  eng.newScenario('int', terrain.spec);
  const t = terrain.towns[0];
  eng.createEntity({ typeId: 'us-m1a2', force: 1, x: t.x, y: t.y, name: 'Tank <1> & co' });
  eng.createEntity({ typeId: 'ru-mi24', force: 2, x: t.x + 500, y: t.y });
  eng.addGraphic('area', [t, { x: t.x + 300, y: t.y }, { x: t.x + 300, y: t.y + 300 }], 'Obj');
  eng.addGraphic('route', [t, { x: t.x + 300, y: t.y }], 'Rte');
  return eng;
}

describe('Cursor-on-Target', () => {
  it('maps entities to CoT types', () => {
    expect(cotType({ force: 1, domain: 'ground', symbol: 'armor' })).toBe('a-f-G-U-C-A');
    expect(cotType({ force: 2, domain: 'air', symbol: 'rotary' })).toBe('a-h-A-M-H');
    expect(cotType({ force: 3, domain: 'surface', symbol: 'boat' })).toBe('a-n-S-C-P');
    expect(cotType({ force: 0, domain: 'lifeform', symbol: 'generic' })).toBe('a-u-G');
  });

  it('builds well-formed CoT events with escaped callsigns', () => {
    const eng = engineWithEntities();
    const snap = eng.snapshot().entities[0];
    const frame = new LocalFrame(terrain.spec.origin.lat, terrain.spec.origin.lon);
    const xml = entityToCot(snap, frame, new Date('2026-01-01T00:00:00Z'), 30);
    expect(xml).toContain('uid="WeRForces-E1"');
    expect(xml).toContain('type="a-f-G-U-C-A"');
    expect(xml).toContain('callsign="Tank &lt;1&gt; &amp; co"');
    expect(xml).toContain('stale="2026-01-01T00:00:30.000Z"');
    const lat = Number(/lat="([^"]+)"/.exec(xml)![1]);
    expect(lat).toBeCloseTo(terrain.spec.origin.lat + snap.y / 111_200, 2);
  });

  it('validates URLs', () => {
    expect(parseCotUrl('udp://239.2.3.1:6969')).toEqual({ protocol: 'udp', host: '239.2.3.1', port: 6969 });
    expect(() => parseCotUrl('http://x:1')).toThrow();
  });

  it('publishes on its interval and sends removals for deleted entities', () => {
    const eng = engineWithEntities();
    const sent: string[] = [];
    const sink: CotSink = { send: (x) => sent.push(x), close: () => {}, connected: () => true };
    const pub = new CotPublisher(() => eng.snapshot(), () => eng.terrain.spec, () => sink);
    pub.configure({ enabled: true, url: 'udp://127.0.0.1:1', interval: 2 });
    pub.tick(100);
    expect(sent).toHaveLength(2);
    pub.tick(101);
    expect(sent).toHaveLength(2);
    eng.deleteObject('E2');
    pub.tick(102);
    expect(sent).toHaveLength(4);
    const removal = sent[3];
    expect(removal).toContain('uid="WeRForces-E2"');
    expect(/time="([^"]+)"/.exec(removal)![1]).toBe(/stale="([^"]+)"/.exec(removal)![1]);
    expect(pub.status().eventsSent).toBe(4);
  });

  it('delivers CoT over real UDP', async () => {
    const eng = engineWithEntities();
    const rx = dgram.createSocket('udp4');
    await new Promise<void>((r) => rx.bind(0, '127.0.0.1', () => r()));
    const port = (rx.address() as { port: number }).port;
    const got = new Promise<string>((r) => rx.once('message', (m) => r(m.toString('utf8'))));
    const pub = new CotPublisher(() => eng.snapshot(), () => eng.terrain.spec);
    pub.configure({ enabled: true, url: `udp://127.0.0.1:${port}` });
    pub.publish();
    expect(await got).toMatch(/^<\?xml.*<event version="2.0"/);
    pub.close();
    rx.close();
  });
});

describe('webhooks', () => {
  it('formats payloads for json, slack and discord', () => {
    const evs = [{ seq: 1, time: 65, kind: 'destroyed' as const, text: 'T-72 destroyed' }];
    expect(formatPayload('json', 'S', evs)).toEqual({ source: 'werforces', scenario: 'S', events: evs });
    expect((formatPayload('slack', 'S', evs) as { text: string }).text).toContain('`00:01:05` 💥 T-72 destroyed');
    expect(formatPayload('discord', 'S', evs)).toHaveProperty('content');
  });

  it('filters by kind, batches and signs deliveries', async () => {
    const received: { body: string; sig?: string }[] = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ body, sig: req.headers['x-werforces-signature'] as string | undefined });
        res.end('ok');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    const d = new WebhookDispatcher(() => 'Scn');
    const hook = d.add({ url: `http://127.0.0.1:${port}/x`, kinds: ['destroyed'], secret: 's3cret' });
    d.onEvent({ seq: 1, time: 1, kind: 'fire', text: 'bang' });
    d.onEvent({ seq: 2, time: 2, kind: 'destroyed', text: 'boom' });
    d.onEvent({ seq: 3, time: 3, kind: 'destroyed', text: 'boom2' });
    await d.flush();
    srv.close();
    expect(received).toHaveLength(1);
    const payload = JSON.parse(received[0].body);
    expect(payload.events.map((e: { text: string }) => e.text)).toEqual(['boom', 'boom2']);
    expect(received[0].sig).toBe(signPayload('s3cret', received[0].body));
    expect(d.view(hook.id)!.delivered).toBe(2);
    expect(d.list()[0]).not.toHaveProperty('secret');
  });

  it('records failures', async () => {
    const d = new WebhookDispatcher(() => 'S', (async () => new Response('no', { status: 500 })) as typeof fetch);
    const h = d.add({ url: 'http://example.invalid/hook' });
    d.onEvent({ seq: 1, time: 1, kind: 'info', text: 'x' });
    await d.flush();
    expect(d.view(h.id)!.failed).toBe(1);
    expect(d.view(h.id)!.lastError).toBe('HTTP 500');
  });
});

describe('GIS export', () => {
  it('produces GeoJSON features with lon/lat order', () => {
    const eng = engineWithEntities();
    const gj = entitiesGeoJSON(eng.snapshot(), terrain.spec);
    expect(gj.features).toHaveLength(2);
    const [lon, lat] = gj.features[0].geometry.coordinates;
    expect(lat).toBeCloseTo(terrain.spec.origin.lat, 0);
    expect(lon).toBeCloseTo(terrain.spec.origin.lon, 0);
    const g = graphicsGeoJSON(eng.snapshot(), terrain.spec);
    const poly = g.features.find((f) => f.geometry.type === 'Polygon')!;
    const ring = (poly.geometry as { coordinates: number[][][] }).coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(g.features.find((f) => f.geometry.type === 'LineString')).toBeDefined();
  });

  it('produces KML with styles, folders and escaped names', () => {
    const eng = engineWithEntities();
    const kml = sceneKML(eng.snapshot(), terrain.spec);
    expect(kml).toContain('<kml xmlns="http://www.opengis.net/kml/2.2">');
    expect(kml).toContain('<name>Blue force</name>');
    expect(kml).toContain('Tank &lt;1&gt; &amp; co');
    expect(kml).toContain('<altitudeMode>absolute</altitudeMode>'); // the helicopter
    expect(kml).toContain('<Polygon>');
  });
});
