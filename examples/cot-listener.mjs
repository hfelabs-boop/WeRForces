// Prints Cursor-on-Target events, for checking TAK output without an ATAK device.
//
//   node examples/cot-listener.mjs [port] [multicast-group]
//   node examples/cot-listener.mjs 6969 239.2.3.1          # the ATAK SA multicast feed
//   node examples/cot-listener.mjs 16969                   # unicast: npm start -- --cot udp://127.0.0.1:16969

import dgram from 'node:dgram';

const port = Number(process.argv[2] ?? 6969);
const group = process.argv[3];
const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const attr = (xml, name) => new RegExp(`${name}="([^"]*)"`).exec(xml)?.[1];

sock.on('message', (msg) => {
  const xml = msg.toString('utf8');
  const callsign = /callsign="([^"]*)"/.exec(xml)?.[1] ?? attr(xml, 'uid');
  const stale = attr(xml, 'stale') === attr(xml, 'time') ? '  (removed)' : '';
  console.log(`${attr(xml, 'type')?.padEnd(14)} ${callsign?.padEnd(24)} ${attr(xml, 'lat')}, ${attr(xml, 'lon')}  course ${attr(xml, 'course')}°  ${attr(xml, 'speed')} m/s${stale}`);
});
sock.bind(port, () => {
  if (group) sock.addMembership(group);
  console.log(`listening for CoT on udp ${group ?? '0.0.0.0'}:${port}`);
});
