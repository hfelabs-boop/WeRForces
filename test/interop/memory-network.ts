// An in-memory "network" for DIS gateway tests: every transport hears every datagram sent,
// including its own (as with broadcast loopback), and `sent` keeps them all in order.

import type { DisTransport } from '../../src/dis/gateway.js';

export function memoryNetwork() {
  const handlers: ((b: Uint8Array) => void)[] = [];
  const sent: Uint8Array[] = [];
  const make = (): DisTransport => {
    let mine: (b: Uint8Array) => void = () => {};
    handlers.push((b) => mine(b));
    return {
      send: (b) => {
        sent.push(b);
        for (const h of handlers) h(b);
      },
      onMessage: (fn) => {
        mine = fn;
      },
      close: () => {},
    };
  };
  return { make, sent };
}
