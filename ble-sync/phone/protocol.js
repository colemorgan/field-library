// Field Sync BLE protocol v1 — framing and message helpers.
// See ../PROTOCOL.md. Plain ES module, no dependencies; works in browsers and Node.

export const PROTOCOL_VERSION = 1;
export const APP_NAME = 'field-sync-web';
export const APP_VERSION = '0.1.0';

export const SERVICE_UUID = '6f1d0001-5a1e-4c8b-9f3e-2b7c1a0e5d10';
export const RX_UUID = '6f1d0002-5a1e-4c8b-9f3e-2b7c1a0e5d10'; // phone -> reader
export const TX_UUID = '6f1d0003-5a1e-4c8b-9f3e-2b7c1a0e5d10'; // reader -> phone
export const NAME_PREFIX = 'FieldSync-';

export const FLAG_FIRST = 0x01;
export const FLAG_LAST = 0x02;
export const HEADER_BYTES = 2;
export const MIN_MTU = 23;
export const MAX_MESSAGE_BYTES = 16384;
export const INTER_CHUNK_TIMEOUT_MS = 5000;

export const ERROR_CODES = Object.freeze([
  'network',
  'timeout',
  'origin_not_allowed',
  'bad_request',
  'too_large',
]);

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
export function utf8Length(text) {
  return encoder.encode(text).length;
}

/** Payload bytes per chunk for a given ATT MTU: (MTU - 3) - 2. */
export function payloadSizeForMtu(mtu = MIN_MTU) {
  if (!Number.isInteger(mtu) || mtu < MIN_MTU || mtu > 517) {
    throw new RangeError(`invalid ATT MTU: ${mtu}`);
  }
  return mtu - 3 - HEADER_BYTES;
}

/**
 * Split one message into chunks.
 * @param {string|Uint8Array} message JSON text or its UTF-8 bytes
 * @param {number} msgId 0-255
 * @param {{mtu?: number, maxBytes?: number}} [opts]
 * @returns {Uint8Array[]}
 */
export function encodeFrames(message, msgId, { mtu = MIN_MTU, maxBytes = MAX_MESSAGE_BYTES } = {}) {
  if (!Number.isInteger(msgId) || msgId < 0 || msgId > 255) {
    throw new RangeError(`invalid msgId: ${msgId}`);
  }
  const bytes = typeof message === 'string' ? encoder.encode(message) : message;
  if (!(bytes instanceof Uint8Array)) throw new TypeError('message must be a string or Uint8Array');
  if (bytes.length > maxBytes) {
    const err = new RangeError(`message is ${bytes.length} bytes; limit is ${maxBytes}`);
    err.code = 'too_large';
    throw err;
  }
  const size = payloadSizeForMtu(mtu);
  const chunks = [];
  let offset = 0;
  do {
    const end = Math.min(offset + size, bytes.length);
    let flags = 0;
    if (offset === 0) flags |= FLAG_FIRST;
    if (end === bytes.length) flags |= FLAG_LAST;
    const chunk = new Uint8Array(HEADER_BYTES + (end - offset));
    chunk[0] = flags;
    chunk[1] = msgId;
    chunk.set(bytes.subarray(offset, end), HEADER_BYTES);
    chunks.push(chunk);
    offset = end;
  } while (offset < bytes.length);
  return chunks;
}

/**
 * Reassembles chunks received on one characteristic.
 * push() returns null while a message is incomplete, {ok:true,text,msgId,bytes} when one
 * completes, or {ok:false,error} when something was dropped. Raw bytes are reassembled before
 * UTF-8 decoding, so multi-byte characters may be split across chunks.
 */
export class FrameDecoder {
  constructor({
    maxBytes = MAX_MESSAGE_BYTES,
    timeoutMs = INTER_CHUNK_TIMEOUT_MS,
    now = () => Date.now(),
  } = {}) {
    this.maxBytes = maxBytes;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.reset();
  }

  reset() {
    this.parts = null; // Uint8Array[] while a message is in progress
    this.length = 0;
    this.msgId = -1;
    this.lastAt = 0;
    this.dropping = -1; // msgId of an oversize message whose remaining chunks are ignored
  }

  /** True if a partial message is buffered. */
  get pending() {
    return this.parts !== null;
  }

  /** Discard a stale partial message. Returns true if something was discarded. */
  expire() {
    if (this.parts !== null && this.now() - this.lastAt > this.timeoutMs) {
      this.reset();
      return true;
    }
    return false;
  }

  push(chunk) {
    if (!(chunk instanceof Uint8Array)) chunk = new Uint8Array(chunk);
    if (chunk.length < HEADER_BYTES) return { ok: false, error: 'short_chunk' };
    const flags = chunk[0];
    const msgId = chunk[1];
    const payload = chunk.subarray(HEADER_BYTES);
    const first = (flags & FLAG_FIRST) !== 0;
    const last = (flags & FLAG_LAST) !== 0;
    const timedOut = this.expire();

    if (first) {
      this.reset(); // FIRST discards any partial message
      this.parts = [];
      this.msgId = msgId;
    } else if (this.parts === null) {
      if (this.dropping === msgId) {
        if (last) this.dropping = -1;
        return null; // tail of an oversize message
      }
      this.dropping = -1;
      return { ok: false, error: timedOut ? 'timeout' : 'orphan_chunk' };
    } else if (msgId !== this.msgId) {
      this.reset();
      return { ok: false, error: 'msgid_mismatch' };
    }

    if (this.length + payload.length > this.maxBytes) {
      this.reset();
      if (!last) this.dropping = msgId;
      return { ok: false, error: 'too_large' };
    }
    this.parts.push(payload.slice());
    this.length += payload.length;
    this.lastAt = this.now();
    if (!last) return null;

    const bytes = new Uint8Array(this.length);
    let off = 0;
    for (const p of this.parts) {
      bytes.set(p, off);
      off += p.length;
    }
    this.reset();
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, error: 'utf8' };
    }
    return { ok: true, msgId, bytes, text };
  }
}

/** Rotating 0-255 message id. */
export class MsgIdCounter {
  constructor(start = 0) {
    this.value = start & 0xff;
  }
  next() {
    const id = this.value;
    this.value = (this.value + 1) & 0xff;
    return id;
  }
}

// ---- messages -------------------------------------------------------------

export function buildHello() {
  return { t: 'hello', v: PROTOCOL_VERSION, app: APP_NAME, appVersion: APP_VERSION };
}

export function buildRes(id, status, body = null, error = undefined) {
  const msg = { t: 'res', id, status, body };
  if (error !== undefined) msg.error = error;
  return msg;
}

export function buildErrorRes(id, error) {
  return buildRes(id, 0, null, error);
}

export function buildBye(reason = 'done') {
  return { t: 'bye', reason };
}

export function buildError(code, message) {
  const msg = { t: 'error', code };
  if (message !== undefined) msg.message = message;
  return msg;
}

/** JSON-encode a message and return [text, utf8ByteLength]. */
export function serialize(msg) {
  const text = JSON.stringify(msg);
  return [text, utf8Length(text)];
}

/**
 * Parse a received message. Returns {ok:true,msg} or {ok:false,error}.
 * Only checks the envelope; type-specific checks live in the validators below.
 */
export function parseMessage(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') {
    return { ok: false, error: 'invalid_message' };
  }
  return { ok: true, msg };
}

/** Validate the reader's hello reply. Returns null if valid, else an error string. */
export function validateReaderHello(msg) {
  if (!msg || msg.t !== 'hello') return 'not a hello';
  if (!Number.isInteger(msg.v)) return 'missing version';
  if (typeof msg.baseUrl !== 'string' || msg.baseUrl.length === 0) return 'missing baseUrl';
  return null;
}

/** Same major version? `v` is an integer major version in protocol v1. */
export function isCompatibleVersion(v) {
  return Number.isInteger(v) && v === PROTOCOL_VERSION;
}

/** Validate the envelope of a `req`. Path/header policy is enforced by relay.js. */
export function validateReqShape(msg) {
  if (!msg || msg.t !== 'req') return 'not a req';
  if (!Number.isInteger(msg.id) || msg.id < 1 || msg.id > 65535) return 'bad id';
  if (typeof msg.method !== 'string') return 'bad method';
  if (typeof msg.path !== 'string') return 'bad path';
  if (msg.headers !== undefined && msg.headers !== null) {
    if (typeof msg.headers !== 'object' || Array.isArray(msg.headers)) return 'bad headers';
    for (const v of Object.values(msg.headers)) if (typeof v !== 'string') return 'bad header value';
  }
  if (msg.body !== undefined && msg.body !== null && typeof msg.body !== 'string') return 'bad body';
  return null;
}
