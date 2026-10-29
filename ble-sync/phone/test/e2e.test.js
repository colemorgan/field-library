// End to end: fake reader -> framed in-memory link -> RelaySession -> real fetch -> mock KOSync.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { RelaySession } from '../relay.js';
import { FakeReader, createLinkPair } from '../test-support/fake-reader.js';

const DOC = '0123456789abcdef0123456789abcdef';
const USER = 'zoë'; // non-ASCII in a header forces multi-byte UTF-8 through the framing
const KEY = '5f4dcc3b5aa765d61d8327deb882cf99';
let server;
let baseUrl;
const seen = [];
const store = new Map();

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const user = Buffer.from(req.headers['x-auth-user'] ?? '', 'latin1').toString('utf8');
      if (user !== USER || req.headers['x-auth-key'] !== KEY) return json(401, { message: 'Unauthorized' });
      const m = req.url.match(/^\/syncs\/progress\/([0-9a-f]+)(\?.*)?$/);
      if (req.method === 'GET' && m) {
        return json(200, store.get(m[1]) ?? {});
      }
      if (req.method === 'PUT' && req.url === '/syncs/progress') {
        const p = JSON.parse(body);
        const record = { ...p, timestamp: 1700000000 };
        store.set(p.document, record);
        return json(200, { document: p.document, timestamp: record.timestamp });
      }
      json(404, { message: 'not found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

for (const mtu of [23, 247]) {
  test(`hello -> req -> res -> req -> res -> bye round-trips at MTU ${mtu}`, async () => {
    seen.length = 0;
    store.clear();
    const { phone, reader, stats } = createLinkPair({ mtu });
    const events = [];
    const session = new RelaySession({
      link: phone,
      fetch: globalThis.fetch,
      mtu,
      getAllowlist: () => ['https://sync.crosspointreader.com', baseUrl],
      onEvent: (e) => events.push(e),
    });
    const done = session.run();
    const fake = new FakeReader(reader, { mtu, baseUrl });

    const hello = await fake.handshake();
    assert.deepEqual(hello, { t: 'hello', v: 1, app: 'field-sync-web', appVersion: '0.1.0' });

    const auth = {
      Accept: 'application/vnd.koreader.v1+json',
      'x-auth-user': USER, // relay must put UTF-8 bytes on the wire, like the reader's HTTP client
      'x-auth-key': KEY,
    };

    // PUT progress
    const progress = {
      document: DOC,
      progress: '/body/DocFragment[12]/body/p[3]/text().42',
      percentage: 0.4237,
      device: 'CrossPoint «X4»',
      device_id: 'ABCDEF',
    };
    const put = await fake.request({
      id: 1,
      method: 'PUT',
      path: '/syncs/progress',
      headers: { ...auth, 'Content-Type': 'application/json', Host: 'evil.example', Cookie: 'c=1', 'Content-Length': '1' },
      body: JSON.stringify(progress),
    });
    assert.equal(put.t, 'res');
    assert.equal(put.id, 1);
    assert.equal(put.status, 200, JSON.stringify(put));
    assert.deepEqual(JSON.parse(put.body), { document: DOC, timestamp: 1700000000 });

    // GET it back
    const get = await fake.request({
      id: 2,
      method: 'GET',
      path: `/syncs/progress/${DOC}?position_kinds=locator,percentage`,
      headers: auth,
    });
    assert.equal(get.status, 200);
    assert.deepEqual(JSON.parse(get.body), { ...progress, timestamp: 1700000000 });

    // Wrong credentials surface the server's status unchanged
    const unauth = await fake.request({ id: 3, method: 'GET', path: `/syncs/progress/${DOC}`, headers: {} });
    assert.equal(unauth.status, 401);

    await fake.send({ t: 'bye', reason: 'done' });
    assert.deepEqual(await done, { reason: 'done' });
    assert.equal(stats.closedBy, 'phone');

    // Server-side view: stripped headers never arrived; the real Host did.
    const putSeen = seen.find((s) => s.method === 'PUT');
    assert.equal(putSeen.headers.host, baseUrl.slice('http://'.length));
    assert.equal(putSeen.headers.cookie, undefined);
    assert.equal(putSeen.headers['content-length'], String(Buffer.byteLength(JSON.stringify(progress))));

    // Framing actually split messages at small MTU.
    if (mtu === 23) assert.ok(stats.readerChunks > 20 && stats.phoneChunks > 20);

    const reqEvents = events.filter((e) => e.type === 'request');
    assert.deepEqual(
      reqEvents.map((e) => [e.method, e.status]),
      [
        ['PUT', 200],
        ['GET', 200],
        ['GET', 401],
      ],
    );
    assert.ok(!JSON.stringify(events).includes(KEY));
  });
}

test('unreachable server -> status 0 network', async () => {
  const { phone, reader } = createLinkPair({ mtu: 23 });
  const dead = 'http://127.0.0.1:9'; // discard port: connection refused
  const session = new RelaySession({ link: phone, fetch: globalThis.fetch, getAllowlist: () => [dead] });
  const done = session.run();
  const fake = new FakeReader(reader, { baseUrl: dead });
  await fake.handshake();
  const res = await fake.request({ id: 7, method: 'GET', path: '/syncs/progress/ab' });
  assert.deepEqual(res, { t: 'res', id: 7, status: 0, body: null, error: 'network' });
  await fake.send({ t: 'bye', reason: 'done' });
  await done;
});
