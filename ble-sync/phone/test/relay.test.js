import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ALLOWLIST,
  RelaySession,
  buildTargetUrl,
  displayPath,
  isOriginAllowed,
  normalizeOrigin,
  performRequest,
  sanitizeHeaders,
  validatePath,
  validateRequest,
} from '../relay.js';
import { MAX_MESSAGE_BYTES } from '../protocol.js';
import { FakeReader, createLinkPair } from '../test-support/fake-reader.js';

const BASE = 'https://sync.crosspointreader.com';

// ---- path validation ------------------------------------------------------

test('accepts normal KOSync paths', () => {
  for (const p of [
    '/users/auth',
    '/syncs/progress',
    '/syncs/progress/0123abcd?position_kinds=locator,percentage',
    '/a/b.c/d..e/...', // dots inside names are fine; only whole "." / ".." segments are not
    '/',
  ]) {
    assert.equal(validatePath(p), null, p);
  }
});

test('rejects dangerous paths', () => {
  for (const p of [
    '',
    'syncs/progress',
    '//evil.example/x',
    '/x?u=https://evil.example',
    '/redirect/http://evil',
    '/../admin',
    '/a/../../b',
    '/a/..',
    '/a/%2e%2e/b',
    '/a/%2E%2e/b',
    '/a/./b',
    '/\\evil.example',
    '/a b',
    '/a\nb',
    '/a\u0000',
    '/a/%zz',
    `/${'a'.repeat(3000)}`,
    null,
    42,
  ]) {
    assert.notEqual(validatePath(p), null, JSON.stringify(p));
  }
});

test('target URL stays on the base origin and keeps a base path prefix', () => {
  assert.equal(buildTargetUrl(BASE, '/syncs/progress/ab?x=1'), `${BASE}/syncs/progress/ab?x=1`);
  assert.equal(buildTargetUrl('https://h.example/kosync', '/users/auth'), 'https://h.example/kosync/users/auth');
  assert.equal(buildTargetUrl('https://h.example:8443', '/x'), 'https://h.example:8443/x');
});

// ---- headers --------------------------------------------------------------

test('strips Host, Content-Length, Connection, Cookie (any case) and keeps the rest', () => {
  const r = sanitizeHeaders({
    Host: 'evil',
    'content-length': '5',
    CONNECTION: 'close',
    Cookie: 'a=b',
    Accept: 'application/vnd.koreader.v1+json',
    'x-auth-user': 'cole',
    'x-auth-key': 'k',
    'Content-Type': 'application/json',
  });
  assert.deepEqual(r, {
    ok: true,
    headers: {
      Accept: 'application/vnd.koreader.v1+json',
      'x-auth-user': 'cole',
      'x-auth-key': 'k',
      'Content-Type': 'application/json',
    },
  });
});

test('non-ASCII header values are sent as their UTF-8 bytes', () => {
  assert.deepEqual(sanitizeHeaders({ 'x-auth-user': 'Zoë' }).headers, { 'x-auth-user': 'Zo\u00c3\u00ab' });
  assert.deepEqual(sanitizeHeaders({ 'x-auth-user': '漢' }).headers, { 'x-auth-user': '\u00e6\u00bc\u00a2' });
  // Valid ByteString, so the Headers constructor accepts it.
  assert.doesNotThrow(() => new Headers(sanitizeHeaders({ a: '😀' }).headers));
});

test('rejects bad header names and values', () => {
  assert.equal(sanitizeHeaders({ 'bad name': 'x' }).ok, false);
  assert.equal(sanitizeHeaders({ ok: 'a\r\nInjected: 1' }).ok, false);
  assert.equal(sanitizeHeaders({ ok: 5 }).ok, false);
  assert.equal(sanitizeHeaders(['x']).ok, false);
  assert.deepEqual(sanitizeHeaders(null), { ok: true, headers: {} });
});

// ---- request validation ---------------------------------------------------

test('validateRequest enforces method, path, headers, body', () => {
  const base = { t: 'req', id: 5, method: 'GET', path: '/syncs/progress/a', headers: {}, body: null };
  assert.equal(validateRequest(base).ok, true);
  assert.equal(validateRequest({ ...base, body: '' }).body, null);
  for (const bad of [
    { method: 'DELETE' },
    { method: 'get' },
    { path: '//x' },
    { body: 'x' }, // GET with a body
    { headers: { a: 1 } },
  ]) {
    const r = validateRequest({ ...base, ...bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.error, 'bad_request');
    assert.equal(r.id, 5);
  }
  assert.equal(validateRequest({ ...base, method: 'PUT', body: '{"a":1}' }).body, '{"a":1}');
  assert.equal(validateRequest({ ...base, id: 0 }).id, null);
});

// ---- origins --------------------------------------------------------------

test('origin allowlist', () => {
  assert.equal(isOriginAllowed(BASE, DEFAULT_ALLOWLIST), true);
  assert.equal(isOriginAllowed('https://sync.koreader.rocks', DEFAULT_ALLOWLIST), true);
  assert.equal(isOriginAllowed('https://SYNC.koreader.rocks:443/', DEFAULT_ALLOWLIST), true);
  assert.equal(isOriginAllowed('https://sync.koreader.rocks/kosync', DEFAULT_ALLOWLIST), true);
  assert.equal(isOriginAllowed('http://sync.koreader.rocks', DEFAULT_ALLOWLIST), false);
  assert.equal(isOriginAllowed('https://sync.koreader.rocks.evil.example', DEFAULT_ALLOWLIST), false);
  assert.equal(isOriginAllowed('https://user:pw@sync.koreader.rocks', DEFAULT_ALLOWLIST), false);
  assert.equal(isOriginAllowed('https://sync.koreader.rocks:8443', DEFAULT_ALLOWLIST), false);
  assert.equal(isOriginAllowed('not a url', DEFAULT_ALLOWLIST), false);
  assert.equal(isOriginAllowed('https://my.example', [...DEFAULT_ALLOWLIST, 'https://my.example/']), true);
});

test('normalizeOrigin accepts https and http on localhost only', () => {
  assert.equal(normalizeOrigin(' https://Sync.Example.com/path '), 'https://sync.example.com');
  assert.equal(normalizeOrigin('http://localhost:8080'), 'http://localhost:8080');
  assert.equal(normalizeOrigin('http://127.0.0.1:9'), 'http://127.0.0.1:9');
  assert.equal(normalizeOrigin('http://sync.example.com'), null);
  assert.equal(normalizeOrigin('ftp://x'), null);
  assert.equal(normalizeOrigin('javascript:alert(1)'), null);
});

// ---- performRequest -------------------------------------------------------

function fakeResponse(status, text, headers = {}) {
  return {
    status,
    headers: new Headers(headers),
    text: async () => text,
  };
}

const goodReq = { id: 3, method: 'GET', path: '/syncs/progress/abc', headers: { 'x-auth-user': 'u' }, body: null };

test('performRequest passes method, headers, body and safe fetch options', async () => {
  let seen;
  const res = await performRequest(
    { id: 9, method: 'PUT', path: '/syncs/progress', headers: { 'x-auth-key': 'k' }, body: '{"p":1}' },
    {
      baseUrl: BASE,
      fetch: async (url, init) => {
        seen = { url, init };
        return fakeResponse(200, '{"ok":true}');
      },
    },
  );
  assert.deepEqual(res, { t: 'res', id: 9, status: 200, body: '{"ok":true}' });
  assert.equal(seen.url, `${BASE}/syncs/progress`);
  assert.equal(seen.init.method, 'PUT');
  assert.deepEqual(seen.init.headers, { 'x-auth-key': 'k' });
  assert.equal(seen.init.body, '{"p":1}');
  assert.equal(seen.init.credentials, 'omit');
  assert.equal(seen.init.redirect, 'error');
});

test('non-2xx statuses are passed through', async () => {
  const res = await performRequest(goodReq, { baseUrl: BASE, fetch: async () => fakeResponse(401, '{"message":"no"}') });
  assert.deepEqual(res, { t: 'res', id: 3, status: 401, body: '{"message":"no"}' });
});

test('network/CORS failure (TypeError) -> status 0 network', async () => {
  const res = await performRequest(goodReq, {
    baseUrl: BASE,
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  assert.deepEqual(res, { t: 'res', id: 3, status: 0, body: null, error: 'network' });
});

test('fetch timeout -> status 0 timeout (20 s default, aborts the fetch)', async () => {
  let aborted = false;
  let scheduled;
  const res = await performRequest(goodReq, {
    baseUrl: BASE,
    setTimeout: (fn, ms) => {
      scheduled = ms;
      setImmediate(fn); // fire "20 s" immediately
      return 1;
    },
    clearTimeout: () => {},
    fetch: (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
  });
  assert.equal(scheduled, 20000);
  assert.equal(aborted, true);
  assert.deepEqual(res, { t: 'res', id: 3, status: 0, body: null, error: 'timeout' });
});

test('too_large when the encoded res would exceed 16384 bytes', async () => {
  // Body that fits raw but not after JSON escaping inside the res message.
  const body = '"'.repeat(9000); // 9000 bytes raw, ~18000 escaped
  const res = await performRequest(goodReq, { baseUrl: BASE, fetch: async () => fakeResponse(200, body) });
  assert.deepEqual(res, { t: 'res', id: 3, status: 0, body: null, error: 'too_large' });

  const big = await performRequest(goodReq, {
    baseUrl: BASE,
    fetch: async () => fakeResponse(200, 'x', { 'content-length': String(MAX_MESSAGE_BYTES + 1) }),
  });
  assert.equal(big.error, 'too_large');

  // Largest body that still fits is accepted.
  const overhead = JSON.stringify({ t: 'res', id: 3, status: 200, body: '' }).length;
  const fits = 'x'.repeat(MAX_MESSAGE_BYTES - overhead);
  const ok = await performRequest(goodReq, { baseUrl: BASE, fetch: async () => fakeResponse(200, fits) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.length, fits.length);
});

test('multi-byte response bodies are measured in UTF-8 bytes', async () => {
  const body = 'é'.repeat(8200); // 8200 chars, 16400 bytes
  const res = await performRequest(goodReq, { baseUrl: BASE, fetch: async () => fakeResponse(200, body) });
  assert.equal(res.error, 'too_large');
});

// ---- session behaviour (fake fetch) ---------------------------------------

function startSession({ mtu = 23, baseUrl = BASE, fetch, allowlist = DEFAULT_ALLOWLIST, ...rest } = {}) {
  const { phone, reader, stats } = createLinkPair({ mtu });
  const events = [];
  const session = new RelaySession({
    link: phone,
    fetch,
    mtu,
    getAllowlist: () => allowlist,
    onEvent: (e) => events.push(e),
    ...rest,
  });
  const done = session.run();
  const fake = new FakeReader(reader, { mtu, baseUrl });
  return { session, done, fake, events, stats, reader };
}

test('session: origin not on allowlist -> origin_not_allowed, no fetch', async () => {
  let fetched = false;
  const allowlist = [...DEFAULT_ALLOWLIST];
  const { fake, events, done } = startSession({
    baseUrl: 'https://evil.example',
    allowlist,
    fetch: async () => {
      fetched = true;
      return fakeResponse(200, '{}');
    },
  });
  await fake.handshake();
  const res = await fake.request({ id: 1, method: 'GET', path: '/syncs/progress/a' });
  assert.deepEqual(res, { t: 'res', id: 1, status: 0, body: null, error: 'origin_not_allowed' });
  assert.equal(fetched, false);
  assert.ok(events.some((e) => e.type === 'blocked' && e.origin === 'https://evil.example'));

  // The UI can allow the origin mid-session; later requests then go through.
  allowlist.push('https://evil.example');
  const res2 = await fake.request({ id: 2, method: 'GET', path: '/syncs/progress/a' });
  assert.equal(res2.status, 200);
  await fake.send({ t: 'bye', reason: 'done' });
  assert.deepEqual(await done, { reason: 'done' });
});

test('session: version mismatch sends error and ends', async () => {
  const { phone, reader } = createLinkPair();
  const session = new RelaySession({ link: phone, fetch: async () => fakeResponse(200, '') });
  const done = session.run();
  const fake = new FakeReader(reader, { baseUrl: BASE, v: 2 });
  await fake.handshake();
  assert.deepEqual(await fake.next(), { t: 'error', code: 'version', message: 'phone supports protocol v1' });
  assert.deepEqual(await done, { reason: 'version mismatch' });
});

test('session: req before hello and invalid req get bad_request; events never carry secrets', async () => {
  const { fake, events, done } = startSession({ fetch: async () => fakeResponse(200, '{}') });
  await fake.next(); // phone hello
  const early = await fake.request({ id: 1, method: 'GET', path: '/x', headers: { 'x-auth-key': 'SECRET' } });
  assert.equal(early.error, 'bad_request');
  await fake.send({ t: 'hello', v: 1, baseUrl: BASE });
  const bad = await fake.request({ id: 2, method: 'GET', path: '/../x', headers: { 'x-auth-key': 'SECRET' } });
  assert.equal(bad.error, 'bad_request');
  const good = await fake.request({ id: 3, method: 'PUT', path: '/syncs/progress', headers: { 'x-auth-key': 'SECRET' }, body: '{"secretbody":1}' });
  assert.equal(good.status, 200);
  await fake.send({ t: 'bye', reason: 'done' });
  await done;
  const dump = JSON.stringify(events);
  assert.ok(!dump.includes('SECRET'));
  assert.ok(!dump.includes('secretbody'));
});

test('session: requests are handled one at a time, in order', async () => {
  let active = 0;
  let maxActive = 0;
  const order = [];
  const { fake, done } = startSession({
    fetch: async (url) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      order.push(url);
      active--;
      return fakeResponse(200, '{}');
    },
  });
  await fake.handshake();
  // Fire three requests without waiting for responses.
  await fake.send({ t: 'req', id: 1, method: 'GET', path: '/a', headers: {}, body: null });
  await fake.send({ t: 'req', id: 2, method: 'GET', path: '/b', headers: {}, body: null });
  await fake.send({ t: 'req', id: 3, method: 'GET', path: '/c', headers: {}, body: null });
  const ids = [(await fake.next()).id, (await fake.next()).id, (await fake.next()).id];
  assert.deepEqual(ids, [1, 2, 3]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, [`${BASE}/a`, `${BASE}/b`, `${BASE}/c`]);
  await fake.send({ t: 'bye', reason: 'done' });
  await done;
});

test('session: reader disconnect ends the session and aborts an in-flight fetch', async () => {
  let aborted = false;
  const { fake, done, reader } = startSession({
    fetch: (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
  });
  await fake.handshake();
  await fake.send({ t: 'req', id: 1, method: 'GET', path: '/a', headers: {}, body: null });
  await new Promise((r) => setTimeout(r, 10));
  reader.disconnect();
  assert.deepEqual(await done, { reason: 'disconnected' });
  assert.equal(aborted, true);
});

test('session: no hello from reader ends the session', async () => {
  const { phone } = createLinkPair();
  const session = new RelaySession({ link: phone, fetch: async () => {}, helloTimeoutMs: 20 });
  assert.deepEqual(await session.run(), { reason: 'no hello from reader' });
});

test('session: cancel sends bye to the reader', async () => {
  const { fake, session, done } = startSession({ fetch: async () => fakeResponse(200, '{}') });
  await fake.handshake();
  await session.cancel();
  assert.deepEqual(await fake.next(), { t: 'bye', reason: 'cancelled' });
  assert.deepEqual(await done, { reason: 'cancelled' });
});

test('session: reader bye with a failure reason is not reported as done', async () => {
  const { fake, done } = startSession({ fetch: async () => fakeResponse(200, '{}') });
  await fake.handshake();
  await fake.send({ t: 'bye', reason: 'error' });
  assert.deepEqual(await done, { reason: 'reader ended: error' });
});

test('session: reader error message ends the session', async () => {
  const { fake, done } = startSession({ fetch: async () => fakeResponse(200, '{}') });
  await fake.handshake();
  await fake.send({ t: 'error', code: 'too_large' });
  assert.deepEqual(await done, { reason: 'reader error: too_large' });
});

// ---- display --------------------------------------------------------------

test('displayPath shortens document hashes and hides query strings', () => {
  assert.equal(displayPath('/syncs/progress/0123456789abcdef0123456789abcdef'), '/syncs/progress/012345…');
  assert.equal(displayPath('/syncs/progress/0123456789abcdef0123456789abcdef?position_kinds=x'), '/syncs/progress/012345…?…');
  assert.equal(displayPath('/users/auth'), '/users/auth');
});

test('default timers are not called as methods (browsers throw "Illegal invocation")', async () => {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const strict = (real) =>
    function (...args) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return real(...args);
    };
  globalThis.setTimeout = strict(realSet);
  globalThis.clearTimeout = strict(realClear);
  try {
    const { phone } = createLinkPair();
    const session = new RelaySession({ link: phone, fetch: async () => {}, helloTimeoutMs: 10 });
    assert.deepEqual(await session.run(), { reason: 'no hello from reader' });
    const res = await performRequest(goodReq, { baseUrl: BASE, fetch: async () => fakeResponse(200, '{}') });
    assert.equal(res.status, 200);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});

test('session: hello timeout starts only after the hello write completes (passkey entry)', async () => {
  const { phone } = createLinkPair();
  let releaseWrite;
  const pending = new Promise((r) => (releaseWrite = r));
  const write = phone.write;
  let first = true;
  phone.write = async (chunk) => {
    if (first) {
      first = false;
      await pending; // first write blocks while the user types the passkey
    }
    return write(chunk);
  };
  const session = new RelaySession({ link: phone, fetch: async () => {}, helloTimeoutMs: 20 });
  let result = null;
  const done = session.run().then((r) => (result = r));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(result, null, 'session must not time out while the hello write is pending');
  releaseWrite();
  await done;
  assert.deepEqual(result, { reason: 'no hello from reader' });
});

test('session: cancel ends the session while the hello write is still pending', async () => {
  const { phone } = createLinkPair();
  phone.write = () => new Promise(() => {}); // pairing never finishes
  const session = new RelaySession({ link: phone, fetch: async () => {} });
  const done = session.run();
  await new Promise((r) => setTimeout(r, 10));
  await session.cancel();
  assert.deepEqual(await done, { reason: 'cancelled' });
});

test('session: a failed first hello write (pairing in progress) is retried', async () => {
  const { phone, reader } = createLinkPair();
  const write = phone.write;
  let failures = 1;
  phone.write = async (chunk) => {
    if (failures > 0) {
      failures--;
      throw new Error('GATT operation failed: insufficient authentication');
    }
    return write(chunk);
  };
  const fast = (fn, ms) => globalThis.setTimeout(fn, Math.min(ms, 5));
  const session = new RelaySession({ link: phone, fetch: async () => {}, setTimeout: fast });
  const done = session.run();
  const fake = new FakeReader(reader, { mtu: 23, baseUrl: BASE });
  const hello = await fake.handshake();
  assert.equal(hello.t, 'hello');
  await session.cancel();
  assert.deepEqual(await done, { reason: 'cancelled' });
});
