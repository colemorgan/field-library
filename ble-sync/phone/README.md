# Field Sync — phone relay (Web Bluetooth)

A static web app that relays the e-reader's KOReader-sync HTTP requests to the sync server over
Bluetooth LE. It implements the phone side of [`../PROTOCOL.md`](../PROTOCOL.md) (protocol v1).
There are no runtime dependencies or build step: just ES modules, HTML and CSS.

## Use

1. On the reader: **Settings → Connectivity → CrossPoint Sync → Sync Transport → Phone (Bluetooth)**
   (or Auto), then **Sync Progress**.
2. On the phone, open the app and tap **Sync with reader**. Pick `FieldSync-XXXX`.
3. The first time, the phone asks for a 6-digit passkey. Type the number shown on the reader.
4. The activity list shows each relayed request (method, shortened path, status, time). When the
   reader sends `bye`, the app shows "Sync finished".

## Host

The app is just files (`index.html`, `app.js`, `ble.js`, `relay.js`, `protocol.js`, `style.css`,
`manifest.webmanifest`, `icon.svg`), and any HTTPS static host works (GitHub Pages, Netlify, an
nginx directory). Web Bluetooth only works in a secure context: HTTPS, or `http://localhost` /
`127.0.0.1`. **It has not been published anywhere yet.** You can add it to the home screen from
the browser menu. It has no service worker, so updates show up on the next reload.

Local testing:

```sh
pnpm run serve        # http://127.0.0.1:8080/  (or: node serve.js 8080)
pnpm test             # node --test: codec vectors, relay policy, end-to-end with a mock KOSync server
```

The browser smoke check (dev only; Playwright is not a dependency) loads the page in headless
Chromium. It fails on any console error, checks that the "no Bluetooth" notice appears, and runs a
simulated session with a fake `navigator.bluetooth` and intercepted server responses:

```sh
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright pnpm run check:browser   # screenshots go to /tmp
```

## Browser support

| Browser | Status |
|---|---|
| Chrome on Android | Primary target. Not yet tested against real reader hardware. |
| Bluefy on iOS/iPadOS | Should work (Web Bluetooth). Unverified. |
| Safari, Firefox, Chrome on iOS | No Web Bluetooth. The app says so. |
| Desktop Chrome/Edge | Web Bluetooth exists on Windows/macOS/ChromeOS. Not a target. |

Web Bluetooth does not report the negotiated MTU, so the app sends 20-byte chunks (MTU 23)
using write-with-response. That is slow but safe. Sync responses are small, but a response near
the 16 KB limit takes hundreds of round trips.

## Security

- **No credentials are stored or shown.** The reader sends its `x-auth-user`/`x-auth-key` headers
  in each request. The app forwards them and never logs header values or bodies. Only the
  allowed-servers list is saved (in `localStorage`).
- **Origin allowlist.** The app only relays to the reader's `baseUrl` if its origin is allowed.
  The defaults are `https://sync.crosspointreader.com` and `https://sync.koreader.rocks`, and you
  can add others (HTTPS only). A blocked origin gets `status 0, error "origin_not_allowed"` and
  nothing is sent.
- **Request policy.** Only `GET`/`PUT`/`POST` are relayed. A path must start with `/` and must
  not contain `://`, a leading `//`, `.`/`..` segments (including percent-encoded ones),
  backslashes, or control characters. The final URL is re-checked against the base origin. The
  app drops `Host`, `Content-Length`, `Connection` and `Cookie`. Fetches use
  `credentials: "omit"` and `redirect: "error"`, so auth headers never follow a redirect. They
  time out after 20 s.
- **Encrypted link required.** The reader's characteristics need an encrypted, bonded link, so the
  OS pairs with the passkey before any request passes.

## CORS limitation for custom servers

The app calls the sync server from a web page, so the browser enforces CORS. The server must
answer preflight with `Access-Control-Allow-Origin` (for example `*`) and allow the headers the
reader sends. For KOSync these are `Content-Type`, `Accept`, `x-auth-user` and `x-auth-key`.
`sync.crosspointreader.com` does this. If a custom server doesn't, or if the reader sends a header
the server doesn't allow (such as `Authorization`), the browser blocks the request. The app can't
tell this apart from a network failure: the reader gets `status 0, error "network"`, and the app
logs a hint about CORS. The app does not drop or rewrite auth headers to work around this.

## Files

- `protocol.js` — framing encoder/decoder, msgId rotation, message builders/validators
- `relay.js` — origin allowlist, request validation, fetch with timeout, `RelaySession` (transport-agnostic)
- `ble.js` — Web Bluetooth adapter (device chooser, GATT, notifications, chunked writes)
- `app.js`, `index.html`, `style.css`, `manifest.webmanifest`, `icon.svg` — UI
- `serve.js` — local static server (no dependencies)
- `test/` — `node --test` suites; `test-support/` — in-memory link and fake reader
- `scripts/browser-check.mjs` — optional Playwright smoke check
