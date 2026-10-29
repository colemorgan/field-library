// In-memory BLE link plus a scripted fake reader, for tests. Not loaded by the web app.
import { FrameDecoder, MsgIdCounter, encodeFrames } from '../protocol.js';

/**
 * Create a connected pair: `phone` implements the link interface RelaySession expects, and
 * `reader` is the peripheral side. Chunks are delivered asynchronously, one at a time, and every
 * chunk is checked against the MTU.
 */
export function createLinkPair({ mtu = 23 } = {}) {
  const maxChunk = mtu - 3;
  const phoneData = [];
  const phoneDisc = [];
  const readerData = [];
  let connected = true;
  const stats = { phoneChunks: 0, readerChunks: 0, closedBy: null };

  const disconnect = (by) => {
    if (!connected) return;
    connected = false;
    stats.closedBy = by;
    queueMicrotask(() => phoneDisc.forEach((cb) => cb()));
  };

  const check = (chunk) => {
    if (!connected) throw new Error('not connected');
    if (chunk.length > maxChunk) throw new Error(`chunk of ${chunk.length} bytes exceeds MTU-3 (${maxChunk})`);
  };

  const phone = {
    mtu,
    name: 'FieldSync-TEST',
    async write(chunk) {
      check(chunk);
      stats.phoneChunks++;
      const copy = chunk.slice();
      await new Promise((r) => setImmediate(r));
      if (connected) readerData.forEach((cb) => cb(copy));
    },
    onData: (cb) => phoneData.push(cb),
    onDisconnect: (cb) => phoneDisc.push(cb),
    close: () => disconnect('phone'),
  };

  const reader = {
    async notify(chunk) {
      check(chunk);
      stats.readerChunks++;
      const copy = chunk.slice();
      await new Promise((r) => setImmediate(r));
      if (connected) phoneData.forEach((cb) => cb(copy));
    },
    onData: (cb) => readerData.push(cb),
    disconnect: () => disconnect('reader'),
    get connected() {
      return connected;
    },
  };
  return { phone, reader, stats };
}

/** A minimal reader that speaks the protocol through real framing. */
export class FakeReader {
  constructor(side, { mtu = 23, baseUrl, v = 1 } = {}) {
    this.side = side;
    this.mtu = mtu;
    this.baseUrl = baseUrl;
    this.v = v;
    this.ids = new MsgIdCounter(200);
    this.decoder = new FrameDecoder();
    this.inbox = [];
    this.waiters = [];
    side.onData((chunk) => {
      const r = this.decoder.push(chunk);
      if (r === null) return;
      if (!r.ok) throw new Error(`reader decode error: ${r.error}`);
      const msg = JSON.parse(r.text);
      const w = this.waiters.shift();
      if (w) w(msg);
      else this.inbox.push(msg);
    });
  }

  next(timeoutMs = 2000) {
    if (this.inbox.length) return Promise.resolve(this.inbox.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('reader timed out waiting for a message')), timeoutMs);
      this.waiters.push((m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  }

  async send(msg) {
    for (const c of encodeFrames(JSON.stringify(msg), this.ids.next(), { mtu: this.mtu })) {
      await this.side.notify(c);
    }
  }

  async handshake() {
    const hello = await this.next();
    await this.send({ t: 'hello', v: this.v, device: 'CrossPoint', fw: 'test', baseUrl: this.baseUrl });
    return hello;
  }

  async request(req) {
    await this.send({ t: 'req', headers: {}, body: null, ...req });
    return this.next();
  }
}
