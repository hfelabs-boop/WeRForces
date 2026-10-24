// Cursor-on-Target (CoT) publisher: streams entity positions as CoT XML events to
// ATAK/WinTAK (UDP multicast "SA" feed) or a TAK Server (TCP streaming input).

import dgram from 'node:dgram';
import net from 'node:net';
import { LocalFrame } from '../dis/geodesy.js';
import type { EntitySnapshot, SimState, TerrainSpec } from '../shared/types.js';

export interface CotConfig {
  enabled: boolean;
  /** udp://239.2.3.1:6969 (ATAK SA multicast) or tcp://takserver:8087 */
  url: string;
  /** Seconds between position reports. */
  interval: number;
  /** Seconds until a report goes stale in TAK clients. */
  stale: number;
  /** Also publish entities received from other simulations over DIS. */
  includeRemote: boolean;
}

export const DEFAULT_COT_CONFIG: CotConfig = {
  enabled: false,
  url: 'udp://239.2.3.1:6969',
  interval: 2,
  stale: 30,
  includeRemote: false,
};

export interface CotStatus extends CotConfig {
  eventsSent: number;
  errors: number;
  lastError?: string;
  connected: boolean;
}

const AFFILIATION: Record<number, string> = { 0: 'u', 1: 'f', 2: 'h', 3: 'n' };

/** CoT type string (MIL-STD-2525 derived), e.g. a-f-G-U-C-A for a friendly armor unit. */
export function cotType(e: Pick<EntitySnapshot, 'force' | 'domain' | 'symbol'>): string {
  const aff = AFFILIATION[e.force] ?? 'u';
  let fn: string;
  if (e.domain === 'air') {
    fn = e.symbol === 'rotary' ? 'A-M-H' : e.symbol === 'uav' ? 'A-M-F-Q' : 'A-M-F';
  } else if (e.domain === 'surface') {
    fn = e.symbol === 'boat' ? 'S-C-P' : 'S-C';
  } else {
    const ground: Record<string, string> = {
      armor: 'G-U-C-A',
      mech: 'G-U-C-I-Z',
      infantry: 'G-U-C-I',
      recon: 'G-U-C-R',
      'air-defense': 'G-U-C-D',
      artillery: 'G-U-C-F',
      wheeled: 'G-E-V',
    };
    fn = ground[e.symbol] ?? 'G';
  }
  return `a-${aff}-${fn}`;
}

export function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

/** Build one CoT <event> for an entity. `stale` <= 0 marks it as immediately stale (removal). */
export function entityToCot(e: EntitySnapshot, frame: LocalFrame, now: Date, staleSeconds: number, uidPrefix = 'WeRForces'): string {
  const g = frame.toGeodetic(e);
  const lat = (g.lat * 180) / Math.PI;
  const lon = (g.lon * 180) / Math.PI;
  const time = now.toISOString();
  const stale = new Date(now.getTime() + Math.max(0, staleSeconds) * 1000).toISOString();
  const course = (((e.heading * 180) / Math.PI) % 360 + 360) % 360;
  const remarks = [e.typeId, e.damage !== 'none' ? `damage: ${e.damage}` : '', e.task ?? ''].filter(Boolean).join('; ');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<event version="2.0" uid="${xmlEscape(`${uidPrefix}-${e.id}`)}" type="${cotType(e)}" how="m-s" time="${time}" start="${time}" stale="${stale}">` +
    `<point lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}" hae="${e.z.toFixed(1)}" ce="5.0" le="5.0"/>` +
    `<detail>` +
    `<contact callsign="${xmlEscape(e.name)}"/>` +
    `<track course="${course.toFixed(1)}" speed="${e.speed.toFixed(1)}"/>` +
    (e.unitId ? `<__group name="${xmlEscape(e.unitId)}" role="${e.isLeader ? 'Team Lead' : 'Team Member'}"/>` : '') +
    `<remarks>${xmlEscape(remarks)}</remarks>` +
    `</detail></event>`
  );
}

export function parseCotUrl(url: string): { protocol: 'udp' | 'tcp'; host: string; port: number } {
  const m = /^(udp|tcp):\/\/([^:/]+):(\d{1,5})\/?$/.exec(url.trim());
  if (!m) throw new Error('CoT URL must look like udp://239.2.3.1:6969 or tcp://host:8087');
  const port = Number(m[3]);
  if (port < 1 || port > 65535) throw new Error('invalid CoT port');
  return { protocol: m[1] as 'udp' | 'tcp', host: m[2], port };
}

export interface CotSink {
  send(xml: string): void;
  close(): void;
  connected(): boolean;
}

function udpSink(host: string, port: number, onError: (e: Error) => void): CotSink {
  const sock = dgram.createSocket('udp4');
  sock.on('error', onError);
  return {
    send: (xml) => sock.send(Buffer.from(xml, 'utf8'), port, host, (err) => err && onError(err)),
    close: () => sock.close(),
    connected: () => true,
  };
}

function tcpSink(host: string, port: number, onError: (e: Error) => void): CotSink {
  let sock: net.Socket | null = null;
  let up = false;
  let closed = false;
  let retry: NodeJS.Timeout | null = null;
  const connect = () => {
    if (closed) return;
    sock = net.createConnection({ host, port }, () => (up = true));
    sock.on('error', onError);
    sock.on('close', () => {
      up = false;
      if (!closed) retry = setTimeout(connect, 5000);
    });
  };
  connect();
  return {
    send: (xml) => {
      if (up && sock) sock.write(xml);
    },
    close: () => {
      closed = true;
      if (retry) clearTimeout(retry);
      sock?.destroy();
    },
    connected: () => up,
  };
}

export class CotPublisher {
  private config: CotConfig = { ...DEFAULT_COT_CONFIG };
  private sink: CotSink | null = null;
  private lastSend = -Infinity;
  /** Entities announced so far, so removals can be sent once. */
  private announced = new Set<string>();
  private eventsSent = 0;
  private errors = 0;
  private lastError?: string;

  constructor(
    private readonly getState: () => SimState,
    private readonly getSpec: () => TerrainSpec,
    private readonly sinkFactory: (proto: 'udp' | 'tcp', host: string, port: number, onError: (e: Error) => void) => CotSink = (p, h, port, err) =>
      p === 'udp' ? udpSink(h, port, err) : tcpSink(h, port, err),
  ) {}

  configure(patch: Partial<CotConfig>): CotStatus {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next: CotConfig = { ...this.config, ...defined };
    if (!Number.isFinite(next.interval) || next.interval < 0.2 || next.interval > 3600) throw new Error('interval must be 0.2-3600 s');
    if (!Number.isFinite(next.stale) || next.stale < 1) throw new Error('stale must be at least 1 s');
    const target = parseCotUrl(next.url);
    const reconnect = next.enabled && (!this.sink || next.url !== this.config.url || !this.config.enabled);
    if (this.sink && (!next.enabled || next.url !== this.config.url)) {
      this.sink.close();
      this.sink = null;
      this.announced.clear();
    }
    this.config = next;
    if (reconnect) {
      this.sink = this.sinkFactory(target.protocol, target.host, target.port, (e) => {
        this.errors++;
        this.lastError = e.message;
      });
      this.lastSend = -Infinity;
    }
    return this.status();
  }

  status(): CotStatus {
    return { ...this.config, eventsSent: this.eventsSent, errors: this.errors, lastError: this.lastError, connected: !!this.sink?.connected() };
  }

  /** Called every runner frame with wall-clock seconds. */
  tick(nowSeconds: number): void {
    if (!this.config.enabled || !this.sink) return;
    if (nowSeconds - this.lastSend < this.config.interval) return;
    this.lastSend = nowSeconds;
    this.publish(new Date(nowSeconds * 1000));
  }

  publish(now = new Date()): number {
    if (!this.sink) return 0;
    const spec = this.getSpec();
    const frame = new LocalFrame(spec.origin.lat, spec.origin.lon);
    const state = this.getState();
    const seen = new Set<string>();
    let n = 0;
    for (const e of state.entities) {
      if ((e.remote && !this.config.includeRemote) || e.embarkedIn) continue;
      seen.add(e.id);
      // Destroyed entities are reported once more with their damage, then go stale.
      const stale = e.damage === 'destroyed' ? Math.min(this.config.stale, this.config.interval * 3) : this.config.stale;
      this.sink.send(entityToCot(e, frame, now, stale));
      this.announced.add(e.id);
      n++;
    }
    for (const id of this.announced) {
      if (seen.has(id)) continue;
      // Deleted entity: send an immediately-stale event so TAK clients drop it.
      const gone: EntitySnapshot = {
        id,
        name: id,
        typeId: '',
        force: 0,
        domain: 'ground',
        symbol: 'generic',
        x: 0,
        y: 0,
        z: 0,
        agl: 0,
        heading: 0,
        pitch: 0,
        speed: 0,
        damage: 'destroyed',
        remote: false,
        roe: 'holdFire',
        ammo: [],
        contacts: [],
      };
      this.sink.send(entityToCot(gone, frame, now, 0));
      this.announced.delete(id);
      n++;
    }
    this.eventsSent += n;
    return n;
  }

  close(): void {
    this.sink?.close();
    this.sink = null;
  }
}
