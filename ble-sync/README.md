# Field Sync: reading progress over Bluetooth via your phone

Lets the X4 Classic sync reading progress while you're out, without turning on a hotspot. The reader
sends its normal KOReader-sync requests to your phone over Bluetooth LE. The phone sends them to the
sync server over mobile data and returns the answers.

```
sync server ⇄ (HTTPS, mobile data) ⇄ phone ⇄ (Bluetooth LE) ⇄ reader (CrossPoint fork)
```

- [`PROTOCOL.md`](PROTOCOL.md): the contract between the reader and the phone. Version 1.
- [`vectors.json`](vectors.json): byte-exact framing test vectors. Both sides test against them.
- [`firmware/`](firmware/README.md): patches to CrossPoint at a pinned commit, plus `build.sh`.
  Builds `env:x4c` (X4 Classic) only.
- [`phone/`](phone/README.md): Web Bluetooth relay web app (Chrome on Android; Bluefy on iOS,
  unverified). It has no dependencies or build step.

## Status

- Firmware: `env:x4c` builds. 910/910 host tests pass, 34 of them for this feature. It costs 17.6 KB
  of flash and 16 B of static RAM.
- Phone: 54/54 tests pass, including an end-to-end session against a mock sync server at MTU 23 and
  MTU 247. A headless browser check found no console errors.
- **Nothing has run on real hardware.** Pairing, advertising, heap use while Bluetooth is on, and
  page-turner reconnection all still need the device.
- The phone app is not published anywhere.

## Next steps

1. A native phone app (planned on the MacBook). It must implement `PROTOCOL.md` and pass
   `vectors.json`. `phone/relay.js` and `phone/protocol.js` are the reference logic to port: origin
   allowlist, path checks, header stripping, 20 s fetch timeout, and one request at a time. An iOS app
   needs CoreBluetooth. Keep the default chunk size of 20 bytes unless the app reads the real MTU
   (`maximumWriteValueLength(for:)` on iOS).
2. When the reader arrives: build with `firmware/build.sh`, back up the stock firmware, flash, and work
   through the Bluetooth items in `../DEVICE-TEST.md`.

## Known limits

- Clipping sync, Sign Up and Authenticate still need Wi-Fi.
- Servers that need Basic auth (Calibre-Web-Automated) do not work over Bluetooth.
- The phone bond shares NimBLE's 3 bond slots with page-turner remotes. When they're full, the oldest
  bond is replaced.
- Custom sync servers must allow cross-origin requests (CORS) for the web app. A native app does not
  have this limit.
