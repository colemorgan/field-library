import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FLAG_FIRST,
  FLAG_LAST,
  FrameDecoder,
  MAX_MESSAGE_BYTES,
  MsgIdCounter,
  buildHello,
  encodeFrames,
  parseMessage,
  payloadSizeForMtu,
  validateReaderHello,
  validateReqShape,
} from '../protocol.js';

const vectors = JSON.parse(readFileSync(new URL('../../vectors.json', import.meta.url), 'utf8'));
const hex = (u8) => Buffer.from(u8).toString('hex');
const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));

test('vectors.json declares protocol 1 and the 16384-byte cap', () => {
  assert.equal(vectors.protocol, 1);
  assert.equal(vectors.maxMessageBytes, MAX_MESSAGE_BYTES);
  assert.ok(vectors.framing.length > 0);
});

for (const v of vectors.framing) {
  test(`vector ${v.name}: encode matches byte-for-byte`, () => {
    const chunks = encodeFrames(v.message, v.msgId, { mtu: v.mtu });
    assert.deepEqual(chunks.map(hex), v.chunks);
    for (const c of chunks) assert.ok(c.length <= v.mtu - 3);
  });

  test(`vector ${v.name}: decode reassembles the message`, () => {
    const d = new FrameDecoder();
    const results = v.chunks.map((c) => d.push(unhex(c)));
    for (const r of results.slice(0, -1)) assert.equal(r, null);
    const last = results.at(-1);
    assert.equal(last.ok, true);
    assert.equal(last.msgId, v.msgId);
    assert.equal(last.text, v.message);
    assert.equal(d.pending, false);
  });
}

test('payload size is MTU - 5', () => {
  assert.equal(payloadSizeForMtu(23), 18);
  assert.equal(payloadSizeForMtu(247), 242);
  assert.throws(() => payloadSizeForMtu(22), RangeError);
});

test('empty message is a single FIRST|LAST chunk', () => {
  const chunks = encodeFrames('', 3);
  assert.deepEqual(chunks.map(hex), ['0303']);
  assert.equal(new FrameDecoder().push(chunks[0]).text, '');
});

test('UTF-8 characters split across chunks decode correctly', () => {
  // 17 ASCII bytes then a 4-byte emoji: the emoji straddles the 18-byte payload boundary.
  const msg = JSON.stringify({ x: 'a'.repeat(9) + '😀é漢字' }); // {"x":"aaaaaaaaa😀…
  const chunks = encodeFrames(msg, 9, { mtu: 23 });
  const boundary = new TextEncoder().encode(msg).slice(0, 18);
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(boundary)); // really split
  const d = new FrameDecoder();
  let out;
  for (const c of chunks) out = d.push(c) ?? out;
  assert.equal(out.text, msg);
});

test('invalid UTF-8 is reported, not thrown', () => {
  const d = new FrameDecoder();
  assert.deepEqual(d.push(new Uint8Array([3, 1, 0xc3])), { ok: false, error: 'utf8' });
});

test('encoder refuses messages over 16384 bytes; exactly 16384 is fine', () => {
  const ok = 'x'.repeat(MAX_MESSAGE_BYTES);
  const chunks = encodeFrames(ok, 1, { mtu: 247 });
  const d = new FrameDecoder();
  let out;
  for (const c of chunks) out = d.push(c) ?? out;
  assert.equal(out.text.length, MAX_MESSAGE_BYTES);
  assert.throws(() => encodeFrames(ok + 'y', 1), (e) => e.code === 'too_large');
});

test('decoder drops an oversize message, ignores its tail, then recovers', () => {
  const big = 'x'.repeat(MAX_MESSAGE_BYTES + 100);
  const chunks = encodeFrames(big, 4, { mtu: 247, maxBytes: Infinity });
  const d = new FrameDecoder();
  const errors = [];
  for (const c of chunks) {
    const r = d.push(c);
    if (r) errors.push(r);
  }
  assert.deepEqual(errors, [{ ok: false, error: 'too_large' }]);
  const [next] = encodeFrames('{"t":"bye"}', 5);
  assert.equal(d.push(next).text, '{"t":"bye"}');
});

test('more than 5 s between chunks discards the partial message', () => {
  let now = 1000;
  const d = new FrameDecoder({ now: () => now });
  const chunks = encodeFrames('{"t":"hello","v":1,"padding":"0123456789"}', 1, { mtu: 23 });
  assert.equal(d.push(chunks[0]), null);
  now += 5000; // exactly 5 s is still OK
  assert.equal(d.push(chunks[1]), null);
  now += 5001;
  assert.deepEqual(d.push(chunks[2]), { ok: false, error: 'timeout' });
  assert.equal(d.pending, false);
  // a fresh message after the timeout works
  let out;
  for (const c of chunks) out = d.push(c) ?? out;
  assert.equal(out.ok, true);
});

test('expire() discards a stale partial without a new chunk', () => {
  let now = 0;
  const d = new FrameDecoder({ now: () => now });
  d.push(encodeFrames('x'.repeat(40), 1)[0]);
  assert.equal(d.expire(), false);
  now = 6000;
  assert.equal(d.expire(), true);
  assert.equal(d.pending, false);
});

test('FIRST discards a partial message', () => {
  const d = new FrameDecoder();
  const a = encodeFrames('{"t":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}', 1);
  const b = encodeFrames('{"t":"bye"}', 2);
  assert.equal(d.push(a[0]), null);
  assert.equal(d.push(b[0]).text, '{"t":"bye"}');
  // the rest of `a` is now orphaned
  assert.deepEqual(d.push(a[1]), { ok: false, error: 'orphan_chunk' });
});

test('FIRST with the same msgId also restarts', () => {
  const d = new FrameDecoder();
  const a = encodeFrames('{"t":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}', 7);
  d.push(a[0]);
  let out;
  for (const c of a) out = d.push(c) ?? out;
  assert.equal(out.text, '{"t":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}');
});

test('continuation chunk with a different msgId drops the partial', () => {
  const d = new FrameDecoder();
  d.push(new Uint8Array([FLAG_FIRST, 1, 0x7b]));
  assert.deepEqual(d.push(new Uint8Array([FLAG_LAST, 2, 0x7d])), { ok: false, error: 'msgid_mismatch' });
  assert.equal(d.pending, false);
});

test('short chunks are rejected', () => {
  assert.deepEqual(new FrameDecoder().push(new Uint8Array([FLAG_FIRST | FLAG_LAST])), {
    ok: false,
    error: 'short_chunk',
  });
});

test('msgId rotates through 0-255', () => {
  const ids = new MsgIdCounter(254);
  assert.deepEqual([ids.next(), ids.next(), ids.next()], [254, 255, 0]);
  assert.throws(() => encodeFrames('x', 256), RangeError);
});

test('message builders and validators', () => {
  assert.deepEqual(buildHello(), { t: 'hello', v: 1, app: 'field-sync-web', appVersion: '0.1.0' });
  assert.equal(JSON.stringify(buildHello()), vectors.framing[0].message);
  assert.equal(parseMessage('nope').ok, false);
  assert.equal(parseMessage('[1]').ok, false);
  assert.equal(parseMessage('{"x":1}').ok, false);
  assert.equal(parseMessage('{"t":"bye"}').ok, true);
  assert.equal(validateReaderHello({ t: 'hello', v: 1, baseUrl: 'https://a' }), null);
  assert.ok(validateReaderHello({ t: 'hello', v: 1 }));
  assert.equal(validateReqShape({ t: 'req', id: 1, method: 'GET', path: '/', headers: {}, body: null }), null);
  assert.ok(validateReqShape({ t: 'req', id: 0, method: 'GET', path: '/' }));
  assert.ok(validateReqShape({ t: 'req', id: 65536, method: 'GET', path: '/' }));
  assert.ok(validateReqShape({ t: 'req', id: 1, method: 'GET', path: '/', headers: { a: 1 } }));
  assert.ok(validateReqShape({ t: 'req', id: 1, method: 'GET', path: '/', body: {} }));
});
