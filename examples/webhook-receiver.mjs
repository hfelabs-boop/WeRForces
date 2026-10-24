// Minimal webhook receiver: prints WeRForces events and verifies the HMAC signature.
//
//   WEBHOOK_SECRET=s3cret node examples/webhook-receiver.mjs [port]
//   # then: npm start -- --webhook http://127.0.0.1:9000/hook   (or add it in the Integrations dialog)

import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const port = Number(process.argv[2] ?? 9000);
const secret = process.env.WEBHOOK_SECRET;

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (secret) {
        const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
        const got = String(req.headers['x-werforces-signature'] ?? '');
        if (got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
          console.warn('rejected: bad signature');
          res.writeHead(401).end();
          return;
        }
      }
      const payload = JSON.parse(body);
      for (const ev of payload.events ?? []) console.log(`[${payload.scenario}] ${ev.kind.padEnd(10)} ${ev.text}`);
      res.writeHead(204).end();
    });
  })
  .listen(port, () => console.log(`webhook receiver on http://127.0.0.1:${port}/hook${secret ? ' (verifying signatures)' : ''}`));
