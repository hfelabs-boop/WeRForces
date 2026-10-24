// Wires the integrations to a running simulation.

import type { SimRunner } from '../server/runner.js';
import { CotPublisher, type CotConfig } from './cot.js';
import { WebhookDispatcher, type WebhookInput } from './webhooks.js';

export interface IntegrationOptions {
  cot?: Partial<CotConfig>;
  webhooks?: WebhookInput[];
}

export class IntegrationHub {
  readonly cot: CotPublisher;
  readonly webhooks: WebhookDispatcher;
  private lastFlush = 0;

  constructor(
    readonly runner: SimRunner,
    opts: IntegrationOptions = {},
  ) {
    const engine = runner.engine;
    this.cot = new CotPublisher(
      () => runner.state(),
      () => engine.terrain.spec,
    );
    this.webhooks = new WebhookDispatcher(() => engine.scenarioName);
    engine.on('event', (ev) => this.webhooks.onEvent(ev));
    if (opts.cot) this.cot.configure({ ...opts.cot, enabled: opts.cot.enabled ?? true });
    for (const w of opts.webhooks ?? []) this.webhooks.add(w);
    runner.onFrame(() => {
      const now = Date.now() / 1000;
      this.cot.tick(now);
      if (now - this.lastFlush >= 1) {
        this.lastFlush = now;
        void this.webhooks.flush();
      }
    });
  }

  status() {
    return { cot: this.cot.status(), webhooks: this.webhooks.list() };
  }

  close(): void {
    this.cot.close();
  }
}
