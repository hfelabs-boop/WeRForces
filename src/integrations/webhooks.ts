// Outbound webhooks: batches simulation events and POSTs them to configured URLs as
// generic JSON, or as Slack/Discord-compatible messages. Payloads can be signed.

import { createHmac, randomUUID } from 'node:crypto';
import type { SimEvent, SimEventKind } from '../shared/types.js';

export type WebhookFormat = 'json' | 'slack' | 'discord';

export interface WebhookInput {
  url: string;
  /** Event kinds to deliver; empty means damage, kills, task changes and info. */
  kinds?: SimEventKind[];
  format?: WebhookFormat;
  /** Optional shared secret; adds X-WeRForces-Signature: sha256=<hmac>. */
  secret?: string;
  name?: string;
}

export interface Webhook extends Required<Omit<WebhookInput, 'secret'>> {
  id: string;
  hasSecret: boolean;
  delivered: number;
  failed: number;
  lastStatus?: number;
  lastError?: string;
  lastDelivery?: string;
}

const ALL_KINDS: SimEventKind[] = ['fire', 'detonation', 'damaged', 'destroyed', 'detected', 'task', 'created', 'deleted', 'info'];
const DEFAULT_KINDS: SimEventKind[] = ['damaged', 'destroyed', 'task', 'info'];
const MAX_BATCH = 100;

function fmtTime(t: number): string {
  const s = Math.floor(t);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function validateWebhook(input: unknown): WebhookInput {
  if (!input || typeof input !== 'object') throw new Error('webhook must be an object');
  const w = input as Record<string, unknown>;
  if (typeof w.url !== 'string') throw new Error('url is required');
  let u: URL;
  try {
    u = new URL(w.url);
  } catch {
    throw new Error('url is not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('url must be http or https');
  const kinds = w.kinds === undefined ? undefined : w.kinds;
  if (kinds !== undefined && (!Array.isArray(kinds) || kinds.some((k) => !ALL_KINDS.includes(k as SimEventKind)))) {
    throw new Error(`kinds must be a list of: ${ALL_KINDS.join(', ')}`);
  }
  const format = w.format ?? 'json';
  if (!['json', 'slack', 'discord'].includes(format as string)) throw new Error('format must be json, slack or discord');
  if (w.secret !== undefined && typeof w.secret !== 'string') throw new Error('secret must be a string');
  return {
    url: u.toString(),
    kinds: kinds as SimEventKind[] | undefined,
    format: format as WebhookFormat,
    secret: w.secret as string | undefined,
    name: typeof w.name === 'string' ? w.name.slice(0, 80) : undefined,
  };
}

export function signPayload(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function formatPayload(format: WebhookFormat, scenario: string, events: SimEvent[]): unknown {
  if (format === 'json') return { source: 'werforces', scenario, events };
  const lines = events.map((e) => `\`${fmtTime(e.time)}\` ${e.kind === 'destroyed' ? '💥 ' : ''}${e.text}`);
  let text = `*WeRForces — ${scenario}*\n${lines.join('\n')}`;
  if (text.length > 1900) text = `${text.slice(0, 1890)}\n…`;
  return format === 'slack' ? { text } : { content: text };
}

export class WebhookDispatcher {
  private hooks = new Map<string, Webhook & { secret?: string; queue: SimEvent[] }>();
  private inFlight = new Set<string>();

  constructor(
    private readonly scenarioName: () => string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  add(input: WebhookInput): Webhook {
    const v = validateWebhook(input);
    const id = randomUUID().slice(0, 8);
    this.hooks.set(id, {
      id,
      url: v.url,
      name: v.name ?? new URL(v.url).host,
      kinds: v.kinds && v.kinds.length ? v.kinds : DEFAULT_KINDS,
      format: v.format ?? 'json',
      secret: v.secret,
      hasSecret: !!v.secret,
      delivered: 0,
      failed: 0,
      queue: [],
    });
    return this.view(id)!;
  }

  remove(id: string): boolean {
    return this.hooks.delete(id);
  }

  list(): Webhook[] {
    return [...this.hooks.keys()].map((id) => this.view(id)!);
  }

  view(id: string): Webhook | undefined {
    const h = this.hooks.get(id);
    if (!h) return undefined;
    const { secret: _s, queue: _q, ...rest } = h;
    return { ...rest };
  }

  /** Queue an event for every hook that subscribes to its kind. */
  onEvent(ev: SimEvent): void {
    for (const h of this.hooks.values()) {
      if (!h.kinds.includes(ev.kind)) continue;
      h.queue.push(ev);
      if (h.queue.length > 1000) h.queue.splice(0, h.queue.length - 1000);
    }
  }

  /** Deliver queued events; one request in flight per hook. */
  async flush(): Promise<void> {
    await Promise.all([...this.hooks.values()].map((h) => this.deliver(h)));
  }

  /** Send a test message to one hook. */
  async test(id: string): Promise<Webhook> {
    const h = this.hooks.get(id);
    if (!h) throw new Error('unknown webhook');
    const ev: SimEvent = { seq: 0, time: 0, kind: 'info', text: 'WeRForces webhook test' };
    h.queue.unshift(ev);
    await this.deliver(h);
    return this.view(id)!;
  }

  private async deliver(h: Webhook & { secret?: string; queue: SimEvent[] }): Promise<void> {
    if (h.queue.length === 0 || this.inFlight.has(h.id)) return;
    const batch = h.queue.splice(0, MAX_BATCH);
    const body = JSON.stringify(formatPayload(h.format, this.scenarioName(), batch));
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'WeRForces-Webhook/1' };
    if (h.secret) headers['X-WeRForces-Signature'] = signPayload(h.secret, body);
    this.inFlight.add(h.id);
    try {
      const res = await this.fetchImpl(h.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
      h.lastStatus = res.status;
      h.lastDelivery = new Date().toISOString();
      if (res.ok) {
        h.delivered += batch.length;
        h.lastError = undefined;
      } else {
        h.failed += batch.length;
        h.lastError = `HTTP ${res.status}`;
      }
    } catch (err) {
      h.failed += batch.length;
      h.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.inFlight.delete(h.id);
    }
  }
}
