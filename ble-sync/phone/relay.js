// Transport-agnostic relay: turns the reader's `req` messages into fetch() calls.
// No DOM, no Web Bluetooth, no storage — everything is injected so it can be tested in Node.

import {
  MAX_MESSAGE_BYTES,
  MIN_MTU,
  FrameDecoder,
  MsgIdCounter,
  buildBye,
  buildError,
  buildErrorRes,
  buildHello,
  buildRes,
  encodeFrames,
  isCompatibleVersion,
  parseMessage,
  serialize,
  validateReaderHello,
  validateReqShape,
} from './protocol.js';

export const DEFAULT_ALLOWLIST = Object.freeze([
  'https://sync.crosspointreader.com',
  'https://sync.koreader.rocks',
]);

export const FETCH_TIMEOUT_MS = 20000;
export const HELLO_TIMEOUT_MS = 15000;
export const ALLOWED_METHODS = Object.freeze(['GET', 'PUT', 'POST']);
export const STRIPPED_HEADERS = Object.freeze(['host', 'content-length', 'connection', 'cookie']);

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// ---- origins --------------------------------------------------------------

/**
 * Normalize a user- or reader-supplied URL to its origin ("https://host[:port]").
 * Only https is accepted, plus http on localhost (for local testing). Returns null if invalid.
 */
export function normalizeOrigin(input) {
  if (typeof input !== 'string') return null;
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return url.origin;
  return null;
}

/** True if baseUrl's origin is in the allowlist (entries are normalized before comparing). */
export function isOriginAllowed(baseUrl, allowlist) {
  const origin = normalizeOrigin(baseUrl);
  if (!origin) return false;
  return allowlist.some((entry) => normalizeOrigin(entry) === origin);
}

// ---- request validation ---------------------------------------------------

/** Returns null if the path is acceptable, otherwise a reason string. */
export function validatePath(path) {
  if (typeof path !== 'string' || path.length === 0) return 'path must be a string';
  if (path.length > 2048) return 'path too long';
  if (!path.startsWith('/')) return 'path must start with /';
  if (path.startsWith('//')) return 'path must not start with //';
  if (path.includes('://')) return 'path must not contain ://';
  // Backslashes are treated as "/" by URL parsers for http(s); control chars and spaces are
  // never valid in a request target.
  if (/[\\\u0000- \u007f]/.test(path)) return 'path contains illegal characters';
  const pathname = path.split(/[?#]/, 1)[0];
  for (const segment of pathname.split('/')) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return 'path has bad percent-encoding';
    }
    if (segment === '..' || decoded === '..' || decoded === '.' || segment === '.') {
      return 'path must not contain . or .. segments';
    }
  }
  return null;
}

/**
 * fetch() header values are ByteStrings (one char per byte). The reader's own HTTP client would
 * put the UTF-8 bytes of the value on the wire, so do the same: "Zoë" -> "Zo\u00c3\u00ab".
 */
export function toHeaderByteString(value) {
  if (!/[^\x00-\x7f]/.test(value)) return value;
  let out = '';
  for (const b of new TextEncoder().encode(value)) out += String.fromCharCode(b);
  return out;
}

/** Drop Host/Content-Length/Connection/Cookie; validate names. Returns {ok,headers}|{ok:false}. */
export function sanitizeHeaders(headers) {
  const out = {};
  if (headers === undefined || headers === null) return { ok: true, headers: out };
  if (typeof headers !== 'object' || Array.isArray(headers)) return { ok: false, reason: 'bad headers' };
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') return { ok: false, reason: 'header values must be strings' };
    if (!HEADER_NAME_RE.test(name)) return { ok: false, reason: 'bad header name' };
    if (/[\r\n\0]/.test(value)) return { ok: false, reason: 'bad header value' };
    if (STRIPPED_HEADERS.includes(name.toLowerCase())) continue;
    out[name] = toHeaderByteString(value);
  }
  return { ok: true, headers: out };
}

/**
 * Validate a `req` message against the policy in PROTOCOL.md.
 * Returns {ok:true, id, method, path, headers, body} or {ok:false, id, error:'bad_request', reason}.
 */
export function validateRequest(req) {
  const id = req && Number.isInteger(req.id) && req.id >= 1 && req.id <= 65535 ? req.id : null;
  const fail = (reason) => ({ ok: false, id, error: 'bad_request', reason });
  const shape = validateReqShape(req);
  if (shape) return fail(shape);
  if (!ALLOWED_METHODS.includes(req.method)) return fail('method not allowed');
  const pathError = validatePath(req.path);
  if (pathError) return fail(pathError);
  const h = sanitizeHeaders(req.headers);
  if (!h.ok) return fail(h.reason);
  let body = req.body ?? null;
  if (req.method === 'GET') {
    if (body !== null && body !== '') return fail('GET must not have a body');
    body = null;
  }
  return { ok: true, id, method: req.method, path: req.path, headers: h.headers, body };
}

/** Build the target URL; double-checks that it stays on baseUrl's origin and path prefix. */
export function buildTargetUrl(baseUrl, path) {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/+$/, '');
  const url = new URL(base.origin + prefix + path);
  if (url.origin !== base.origin) return null;
  if (prefix && !url.pathname.startsWith(prefix + '/')) return null;
  return url.href;
}

// ---- display ---------------------------------------------------------------

/** Show a path without secrets-adjacent detail: long hex ids shortened, query hidden. */
export function displayPath(path) {
  if (typeof path !== 'string') return '?';
  const [pathname, query] = path.split(/\?(.*)/s, 2);
  const short = pathname
    .split('/')
    .map((seg) => (/^[0-9a-f]{12,}$/i.test(seg) ? `${seg.slice(0, 6)}…` : seg))
    .join('/');
  return (short.length > 60 ? `${short.slice(0, 57)}…` : short) + (query ? '?…' : '');
}

// ---- performing a request -------------------------------------------------

/**
 * Perform one validated request. Always resolves to a `res` message (never throws).
 * @param {{id:number, method:string, path:string, headers:object, body:string|null}} req
 * @param {{baseUrl:string, fetch:Function, timeoutMs?:number, maxBytes?:number,
 *          setTimeout?:Function, clearTimeout?:Function, signal?:AbortSignal}} opts
 */
export async function performRequest(req, opts) {
  const {
    baseUrl,
    fetch: fetchImpl,
    timeoutMs = FETCH_TIMEOUT_MS,
    maxBytes = MAX_MESSAGE_BYTES,
    setTimeout: setT = (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: clearT = (t) => globalThis.clearTimeout(t),
    signal: outerSignal,
  } = opts;

  let url;
  try {
    url = buildTargetUrl(baseUrl, req.path);
  } catch {
    url = null;
  }
  if (!url) return buildErrorRes(req.id, 'bad_request');

  const controller = new AbortController();
  let timedOut = false;
  const timer = setT(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    const response = await fetchImpl(url, {
      method: req.method,
      headers: req.headers,
      body: req.body ?? undefined,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error', // never forward credential headers to a redirect target
      referrerPolicy: 'no-referrer',
    });
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      controller.abort();
      return buildErrorRes(req.id, 'too_large');
    }
    const text = await response.text();
    const res = buildRes(req.id, response.status, text);
    const [, size] = serialize(res);
    if (size > maxBytes) return buildErrorRes(req.id, 'too_large');
    return res;
  } catch {
    // TypeError: network failure, CORS rejection, or redirect. AbortError: timeout or cancel.
    return buildErrorRes(req.id, timedOut ? 'timeout' : 'network');
  } finally {
    clearT(timer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }
}

// ---- session --------------------------------------------------------------

/**
 * One relay session over a link.
 *
 * link: {
 *   write(chunk: Uint8Array): Promise<void>,   // one chunk per call, <= MTU-3 bytes
 *   onData(cb: (chunk: Uint8Array) => void),   // reader -> phone chunks
 *   onDisconnect(cb: () => void),
 *   close(): void | Promise<void>,
 * }
 *
 * Events (onEvent) never contain header values or bodies:
 *   {type:'hello', device, fw, baseUrl, origin, allowed}
 *   {type:'request', id, method, path, status, error?, ms}
 *   {type:'blocked', origin}
 *   {type:'log', level, text}
 *   {type:'end', reason}
 */
export class RelaySession {
  constructor({
    link,
    fetch: fetchImpl,
    getAllowlist = () => DEFAULT_ALLOWLIST,
    mtu = MIN_MTU,
    now = () => Date.now(),
    setTimeout: setT = (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: clearT = (t) => globalThis.clearTimeout(t),
    fetchTimeoutMs = FETCH_TIMEOUT_MS,
    helloTimeoutMs = HELLO_TIMEOUT_MS,
    maxBytes = MAX_MESSAGE_BYTES,
    onEvent = () => {},
  }) {
    this.link = link;
    this.fetch = fetchImpl;
    this.getAllowlist = getAllowlist;
    this.mtu = mtu;
    this.now = now;
    this.setTimeout = setT;
    this.clearTimeout = clearT;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.helloTimeoutMs = helloTimeoutMs;
    this.maxBytes = maxBytes;
    this.onEvent = onEvent;

    this.decoder = new FrameDecoder({ maxBytes, now });
    this.ids = new MsgIdCounter();
    this.readerHello = null;
    this.ended = false;
    this.queue = Promise.resolve(); // serializes request handling: one at a time
    this.writes = Promise.resolve(); // serializes chunk writes so messages never interleave
    this.abort = new AbortController();
    this.helloTimer = null;
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
  }

  emit(event) {
    try {
      this.onEvent(event);
    } catch {
      /* UI errors must not break the relay */
    }
  }

  log(level, text) {
    this.emit({ type: 'log', level, text });
  }

  /** Start the session (sends hello). Resolves with {reason} when the session ends. */
  async run() {
    this.link.onData((chunk) => this.onChunk(chunk));
    this.link.onDisconnect(() => this.end('disconnected', { close: false }));
    this.helloTimer = this.setTimeout(() => {
      if (!this.readerHello) this.end('no hello from reader');
    }, this.helloTimeoutMs);
    this.send(buildHello()).catch((err) => this.end(`write failed: ${err?.message ?? err}`));
    return this.done;
  }

  /** User-initiated stop: tell the reader, then disconnect. */
  async cancel(reason = 'cancelled') {
    if (this.ended) return this.done;
    try {
      await this.send(buildBye(reason));
    } catch {
      /* link may already be gone */
    }
    return this.end(reason);
  }

  onChunk(chunk) {
    if (this.ended) return;
    const result = this.decoder.push(chunk);
    if (result === null) return;
    if (!result.ok) {
      this.log('warn', `Dropped incoming data (${result.error})`);
      return;
    }
    const parsed = parseMessage(result.text);
    if (!parsed.ok) {
      this.log('warn', `Ignored unreadable message (${parsed.error})`);
      return;
    }
    const msg = parsed.msg;
    this.queue = this.queue.then(() => this.handle(msg)).catch((err) => {
      this.log('error', `Relay error: ${err?.message ?? err}`);
    });
  }

  async handle(msg) {
    if (this.ended) return;
    switch (msg.t) {
      case 'hello':
        return this.handleHello(msg);
      case 'req':
        return this.handleReq(msg);
      case 'bye':
        this.log('info', `Reader finished (${typeof msg.reason === 'string' ? msg.reason : 'bye'})`);
        return this.end('done');
      case 'error':
        this.log('error', `Reader reported error: ${typeof msg.code === 'string' ? msg.code : 'unknown'}`);
        return this.end(`reader error: ${msg.code}`);
      default:
        this.log('warn', `Ignored unknown message type "${String(msg.t).slice(0, 20)}"`);
    }
  }

  async handleHello(msg) {
    if (this.readerHello) return;
    const invalid = validateReaderHello(msg);
    if (invalid) {
      this.log('error', `Bad hello from reader: ${invalid}`);
      if (Number.isInteger(msg.v) && !isCompatibleVersion(msg.v)) return this.versionMismatch(msg.v);
      return;
    }
    if (!isCompatibleVersion(msg.v)) return this.versionMismatch(msg.v);
    this.readerHello = msg;
    this.clearTimeout(this.helloTimer);
    const origin = normalizeOrigin(msg.baseUrl);
    const allowed = isOriginAllowed(msg.baseUrl, this.getAllowlist());
    this.emit({
      type: 'hello',
      device: typeof msg.device === 'string' ? msg.device : '',
      fw: typeof msg.fw === 'string' ? msg.fw : '',
      baseUrl: msg.baseUrl,
      origin,
      allowed,
    });
    if (!allowed) this.emit({ type: 'blocked', origin: origin ?? msg.baseUrl });
  }

  async versionMismatch(v) {
    this.log('error', `Reader speaks protocol v${v}; this app speaks v1. Update one of them.`);
    try {
      await this.send(buildError('version', 'phone supports protocol v1'));
    } catch {
      /* ignore */
    }
    return this.end('version mismatch');
  }

  async handleReq(msg) {
    const started = this.now();
    const v = validateRequest(msg);
    let res;
    const method = typeof msg.method === 'string' ? msg.method.slice(0, 8) : '?';
    const path = typeof msg.path === 'string' ? msg.path : '?';
    if (v.id === null) {
      this.log('warn', 'Ignored request without a valid id');
      return;
    }
    if (!this.readerHello) {
      res = buildErrorRes(v.id, 'bad_request');
    } else if (!v.ok) {
      res = buildErrorRes(v.id, 'bad_request');
    } else if (!isOriginAllowed(this.readerHello.baseUrl, this.getAllowlist())) {
      res = buildErrorRes(v.id, 'origin_not_allowed');
    } else {
      res = await performRequest(v, {
        baseUrl: this.readerHello.baseUrl,
        fetch: this.fetch,
        timeoutMs: this.fetchTimeoutMs,
        maxBytes: this.maxBytes,
        setTimeout: this.setTimeout,
        clearTimeout: this.clearTimeout,
        signal: this.abort.signal,
      });
    }
    if (this.ended) return;
    const event = { type: 'request', id: v.id, method, path, status: res.status, ms: this.now() - started };
    if (res.error) event.error = res.error;
    if (!v.ok) event.reason = v.reason;
    this.emit(event);
    try {
      await this.send(res);
    } catch (err) {
      this.end(`write failed: ${err?.message ?? err}`);
    }
  }

  /** Frame and write one message. Oversize `res` messages become too_large errors. */
  send(msg) {
    let [text, size] = serialize(msg);
    if (size > this.maxBytes) {
      if (msg.t !== 'res') return Promise.reject(new Error('message too large'));
      [text] = serialize(buildErrorRes(msg.id, 'too_large'));
    }
    const chunks = encodeFrames(text, this.ids.next(), { mtu: this.mtu, maxBytes: this.maxBytes });
    const write = this.writes.then(async () => {
      for (const chunk of chunks) {
        if (this.ended) throw new Error('session ended');
        await this.link.write(chunk);
      }
    });
    this.writes = write.catch(() => {});
    return write;
  }

  end(reason, { close = true } = {}) {
    if (this.ended) return this.done;
    this.ended = true;
    this.clearTimeout(this.helloTimer);
    this.abort.abort();
    this.decoder.reset();
    if (close) {
      try {
        Promise.resolve(this.link.close()).catch(() => {});
      } catch {
        /* ignore */
      }
    }
    this.emit({ type: 'end', reason });
    this.resolveDone({ reason });
    return this.done;
  }
}
