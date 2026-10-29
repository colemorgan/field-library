# Field Sync over Bluetooth LE — protocol v1

The phone relays the reader's existing KOReader-sync HTTP requests. The reader keeps all sync logic
(document hashing, position mapping, Smart sync). Only the transport changes: instead of opening a
Wi-Fi connection, the reader sends each HTTP request to the phone over BLE. The phone performs it
with `fetch()` over mobile data and returns the response.

```
sync server ⇄ (HTTPS, mobile data) ⇄ phone web app ⇄ (BLE GATT) ⇄ reader (CrossPoint fork)
```

## Roles

- **Reader:** GATT peripheral. It advertises only while a Bluetooth sync is waiting or running,
  for no more than 60 seconds without a connection.
- **Phone:** GATT central (Web Bluetooth: Chrome on Android; Bluefy on iOS, unverified).

## GATT

| Item | UUID | Properties |
|---|---|---|
| Service | `6f1d0001-5a1e-4c8b-9f3e-2b7c1a0e5d10` | advertised |
| `rx` (phone → reader) | `6f1d0002-5a1e-4c8b-9f3e-2b7c1a0e5d10` | Write, Write Without Response; encrypted |
| `tx` (reader → phone) | `6f1d0003-5a1e-4c8b-9f3e-2b7c1a0e5d10` | Notify; encrypted |

The advertisement carries the flags and the 128-bit service UUID. The scan response carries the
local name `FieldSync-XXXX`, where `XXXX` is the last two bytes of the BLE address in uppercase
hexadecimal. Both together exceed the 31-byte advertisement limit. The phone filters on either.

**Security:** both characteristics require an encrypted, bonded link (LE Secure Connections). The
reader uses the DisplayOnly IO capability, so it shows a 6-digit passkey on the e-ink screen and the
phone user types it in. Requests carry the user's sync credentials, so an unencrypted link must
never carry them.

## Framing

Every message is one UTF-8 JSON object. On each characteristic, it is sent as a sequence of chunks:

```
byte 0     : flags  — bit0 = FIRST, bit1 = LAST (a message that fits in one chunk sets both)
byte 1     : msgId  — 0–255, chosen by the sender, same for every chunk of one message
bytes 2..  : payload bytes (the next slice of the JSON text)
```

- The chunk size is no more than (ATT MTU − 3). Web Bluetooth does not expose the MTU, so the phone
  writes 20-byte chunks by default. Receivers accept any chunk size from 3 bytes up to MTU − 3. The payload is that size minus 2. Senders must
  work with the minimum MTU of 23, so the minimum payload per chunk is 18 bytes.
- A chunk with FIRST discards any partially received message on that characteristic.
- A complete message larger than **16384 bytes** is an error. The receiver drops it and, if it
  is the reader, ends the sync with an error.
- If more than 5 seconds pass between chunks of a message, the receiver discards the partial
  message.

## Messages

### Phone → reader: `hello` (first message after notifications are enabled)
```json
{"t":"hello","v":1,"app":"field-sync-web","appVersion":"0.1.0"}
```

### Reader → phone: `hello` (reply)
```json
{"t":"hello","v":1,"device":"CrossPoint","fw":"1.6.5-field-ble","baseUrl":"https://sync.crosspointreader.com"}
```
`baseUrl` is the reader's configured sync server, with no trailing slash. It may include a port or a
path prefix; the phone compares `new URL(baseUrl).origin`, not the raw string. The phone refuses to
proceed unless this origin is on its allowlist. The default allowlist is
`https://sync.crosspointreader.com` and `https://sync.koreader.rocks`, and the user can add origins.
"Refuse" means the phone stays connected and answers every `req` with
`status:0, error:"origin_not_allowed"`, so allowing the server mid-session takes effect at once.

If the major `v` values differ, either side sends `{"t":"error","code":"version"}` and disconnects.

### Reader → phone: `req`
```json
{"t":"req","id":1,"method":"GET","path":"/syncs/progress/0123abcd?position_kinds=locator,percentage",
 "headers":{"Accept":"application/vnd.koreader.v1+json","x-auth-user":"cole","x-auth-key":"<md5>"},
 "body":null}
```
- `id`: 1–65535, unique among the reader's in-flight requests. The reader sends one at a time.
- `method`: `GET`, `PUT` or `POST`.
- `path`: begins with `/` and is appended to `baseUrl`. The phone rejects any `path` containing
  `://`, any path beginning with `//`, and `..` path segments.
- `headers`: strings only. The phone drops `Host`, `Content-Length`, `Connection` and `Cookie`.
  Non-ASCII values are sent as their UTF-8 bytes, matching the reader's own HTTP client.
- `body`: a string (the exact request body), or `null`.

### Phone → reader: `res`
```json
{"t":"res","id":1,"status":200,"body":"{\"document\":\"0123abcd\",...}"}
```
- `status`: the HTTP status code. Network failures and refused requests use `status: 0` plus
  `"error"`: one of `network`, `timeout`, `origin_not_allowed`, `bad_request`, `too_large`.
- `body`: the response text, or `null`. An empty body may arrive as `""`; treat it like `null`. If the response is larger than the limit, return
  `status:0, error:"too_large"`.
- The phone's fetch timeout is 20 seconds. The reader waits up to 30 seconds for a `res`.

### Either direction: `bye`
```json
{"t":"bye","reason":"done"}
```
`reason` is optional.
The reader sends `bye` when its sync finishes, then disconnects and stops advertising.

### Either direction: `error`
```json
{"t":"error","code":"version","message":"optional text"}
```

## Reader user flow

1. Open the reader menu and choose **Sync Progress**, or long-press Confirm.
2. Under **Settings → Connectivity → CrossPoint Sync → Sync Transport**: **Wi-Fi** (upstream
   behavior, default), **Phone (Bluetooth)**, or **Auto** (try saved Wi-Fi briefly, then fall back to
   the phone). On the X4 Classic, Wi-Fi and BLE share one radio, so the reader never runs both at
   once.
3. Over Bluetooth, the reader stops any page-turner connection, starts advertising, and shows
   "Open Field Sync on your phone and tap Sync". It shows the passkey when pairing is requested,
   runs the usual sync over the relay, sends `bye`, and stops Bluetooth. Page-turner reconnection
   resumes according to the normal rules.

## Phone user flow

1. Open the Field Sync web app (it must be served over HTTPS or from localhost).
2. Tap **Sync with reader**, choose `FieldSync-XXXX`, and enter the passkey on first pairing.
3. The app shows each relayed request (method, path, status). It sees the reader's sync credentials
   in transit (`x-auth-key`, and `Authorization: Basic` if configured, which holds the plain
   password) but never stores or logs them.
