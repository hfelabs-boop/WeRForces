// Loads the open-dis JavaScript library (an independent IEEE 1278.1 implementation by the
// Naval Postgraduate School MOVES Institute) from vendor-test/, where
// scripts/fetch-open-dis.mjs puts it. It is a browser-style library that defines a global
// `dis` namespace, so each build (DIS 7 and DIS 6) runs in its own VM context. Test-only.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

/** The library's `dis` namespace: PDU classes with initFromBinary / encodeToBinary. */
export type DisNamespace = Record<string, any>;
/** An open-dis object (PDU or record): plain fields, decoded by the library. */
export type OpenDisObject = Record<string, any>;

export interface OpenDis {
  /** DIS 7 classes (dist/dis7.min.js). */
  dis7: DisNamespace;
  /** DIS 6 classes (dist/dis6.min.js), used where the DIS 7 build is incomplete; the layouts are the same apart from the header status byte. */
  dis6: DisNamespace;
  version: string;
}

export const VENDOR = path.resolve('vendor-test');

function loadBuild(file: string, long: unknown): DisNamespace {
  const sandbox: Record<string, unknown> = {
    exports: {},
    console,
    require: (name: string) => {
      if (name === 'long') return long;
      throw new Error(`open-dis asked for an unexpected module: ${name}`);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox.dis as DisNamespace;
}

/** The library, or why it is not available. */
export function loadOpenDis(): { lib: OpenDis; missing?: undefined } | { lib?: undefined; missing: string } {
  const pkg = path.join(VENDOR, 'open-dis', 'package.json');
  const longJs = path.join(VENDOR, 'long', 'dist', 'long.js');
  if (!existsSync(pkg) || !existsSync(longJs)) return { missing: 'vendor-test/open-dis is missing (run node scripts/fetch-open-dis.mjs)' };
  const long = createRequire(import.meta.url)(longJs);
  const dir = path.join(VENDOR, 'open-dis', 'dist');
  return {
    lib: {
      dis7: loadBuild(path.join(dir, 'dis7.min.js'), long),
      dis6: loadBuild(path.join(dir, 'dis6.min.js'), long),
      version: (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version,
    },
  };
}

function arrayBuffer(buf: Uint8Array): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * The library's input stream over `buf`. Its readLong() (64-bit fields: the Transmitter
 * frequency, articulated part values) does not advance the read position, which shifts
 * every later field; this stream advances it, as its writeLong() does.
 */
export function theirStream(ns: DisNamespace, buf: Uint8Array): OpenDisObject {
  const is = new ns.InputStream(arrayBuffer(buf));
  const readLong = is.readLong;
  is.readLong = function (this: OpenDisObject) {
    const v = readLong.call(this);
    this.currentPosition += 8;
    return v;
  };
  return is;
}

/** Decode `buf` with the library's class `name` (e.g. "EntityStatePdu"); also returns how many octets it read. */
export function theirDecodeWithLength(ns: DisNamespace, name: string, buf: Uint8Array): { pdu: OpenDisObject; consumed: number } {
  const Ctor = ns[name];
  if (typeof Ctor !== 'function') throw new Error(`open-dis has no ${name}`);
  const pdu = new Ctor();
  const is = theirStream(ns, buf);
  pdu.initFromBinary(is);
  return { pdu, consumed: is.currentPosition as number };
}

/** Decode `buf` with the library's class `name` (e.g. "EntityStatePdu"). */
export function theirDecode(ns: DisNamespace, name: string, buf: Uint8Array): OpenDisObject {
  return theirDecodeWithLength(ns, name, buf).pdu;
}

/** A new, default-initialised library object of class `name`. */
export function theirNew(ns: DisNamespace, name: string): OpenDisObject {
  const Ctor = ns[name];
  if (typeof Ctor !== 'function') throw new Error(`open-dis has no ${name}`);
  return new Ctor();
}

/** Encode a library object; `length` is also written into its header when it has one. */
export function theirEncode(ns: DisNamespace, pdu: OpenDisObject, length: number): Uint8Array {
  if ('length' in pdu) pdu.length = length;
  if ('pduLength' in pdu) pdu.pduLength = length;
  const ab = new ArrayBuffer(length);
  const os = new ns.OutputStream(ab);
  pdu.encodeToBinary(os);
  if (os.currentPosition !== length) throw new Error(`open-dis wrote ${os.currentPosition} octets, expected ${length}`);
  return new Uint8Array(ab);
}

/** Bytes of a list of open-dis one-octet chunks (variable datums, signal data). */
export function chunkBytes(chunks: OpenDisObject[]): Uint8Array {
  return Uint8Array.from(chunks.map((c) => (c.data[0] as number) & 0xff));
}

/** One-octet open-dis chunks holding `bytes`. */
export function toChunks(ns: DisNamespace, bytes: Uint8Array): OpenDisObject[] {
  return [...bytes].map((b) => {
    const c = new ns.Chunk(1);
    c.data[0] = b > 127 ? b - 256 : b;
    return c;
  });
}
