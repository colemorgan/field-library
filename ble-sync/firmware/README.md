# Field Sync reader firmware (CrossPoint fork patch)

Patches for [CrossPoint Reader](https://github.com/crosspoint-reader/crosspoint-reader) that let the
reader sync KOReader progress through a phone over Bluetooth LE, as described in
[`../PROTOCOL.md`](../PROTOCOL.md). The phone runs the Field Sync web app and relays the reader's
normal sync HTTP requests over mobile data.

**Target: Xteink X4 Classic only (`env:x4c`). Not tested on hardware.**

## What the patches change

Pinned upstream commit: [`UPSTREAM_COMMIT`](UPSTREAM_COMMIT) (`develop`).

| Patch | Change |
|---|---|
| 0001 | `lib/KOReaderSync`: `KOReaderSyncClient` sends requests through a small `KOSyncTransport` interface. The default transport is the existing Wi-Fi HTTPS client and keeps the same behavior. |
| 0002 | New `lib/FieldBleSync`: chunk framing, protocol messages, `RelayTransport` (one request at a time, 30 s timeout), and a NimBLE GATT peripheral (built only with `-DFIELD_BLE_SYNC=1`). Includes host tests. |
| 0003 | **Settings → CrossPoint Sync → Sync Transport**: Wi-Fi (default), Phone (Bluetooth), Auto. The sync screen runs the Bluetooth flow. `env:x4c` sets `FIELD_BLE_SYNC=1` and keeps NimBLE's peripheral and broadcaster roles. |
| 0004 | Shows "Allow this server in Field Sync on your phone" when the phone refuses the server origin. |
| 0005 | The relay transport omits `Authorization: Basic`; only `x-auth-user` and `x-auth-key` go over Bluetooth. |
| 0006 | Ends the sync if a connected phone has not paired and sent its hello within 2 minutes. |

Bluetooth details:

- Service `6f1d0001-…`, `rx` (write) and `tx` (notify), name `FieldSync-XXXX` in the scan response.
  Flags and the 128-bit service UUID are in the advertisement.
- `rx` requires an encrypted, MITM-authenticated link. The reader also checks that the link is
  bonded before it accepts data. Pairing uses LE Secure Connections with DisplayOnly IO
  capability, so the reader shows a random 6-digit passkey.
- Advertising stops after 60 s without a connection. If the phone disconnects before the hello,
  the reader advertises for another 60 s.
- The Bluetooth page turner is stopped before the relay starts (`bleturner::stopNow`), and it does
  not run while the sync screen is open. After sync, the reader sends `bye`, disconnects, and calls
  `NimBLEDevice::deinit(true)`. Teardown runs only on the main loop task. The page turner starts
  again according to its normal rules when the book is shown.
- Auto mode tries the last saved Wi-Fi network for 8 s. Then it turns Wi-Fi off and uses the phone.
  Wi-Fi and Bluetooth never run at the same time. If Wi-Fi was used, the reader restarts silently on
  exit, as upstream does.

## Build

```bash
./build.sh
```

The script:

1. Clones upstream into `crosspoint/` if that folder is missing. You can set a different folder
   with `CROSSPOINT_DIR=/path`.
2. Checks out `UPSTREAM_COMMIT`.
3. Applies `patches/*.patch` with `git am` on a branch named `field-ble-sync`.
4. Creates `.venv` with PlatformIO.
5. Runs `pio run -e x4c` and prints the path to `firmware.bin`.

You can run the script again safely. It skips the patch step if the branch already has the patches.
It refuses to change a checkout with uncommitted changes. The first build downloads the toolchains,
which takes several minutes.

To run the host tests:

```bash
cd crosspoint
cmake -S test -B build/test -G Ninja && cmake --build build/test && ctest --test-dir build/test
# or only this library:
cmake -S lib/FieldBleSync/test -B build/fs && cmake --build build/fs && ctest --test-dir build/fs
```

`lib/FieldBleSync/test/vectors.json` is a copy of `../vectors.json`. Keep the two files the same.

## Flash

Follow upstream's flashing instructions for the X4 Classic. See the CrossPoint README and
`freeink-sdk/docs/xteink-x4c-support.md`. With a USB cable, you can run
`.venv/bin/pio run -e x4c -t upload` in `crosspoint/`.

- **Use this firmware only on the X4 Classic.** Other boards need other binaries.
- **Back up the stock firmware first**, so you can restore it.
- **It has not been tested on hardware.** Pairing, advertising, memory use with the stack running,
  and page-turner coexistence were checked only by building and reviewing the code.

## Memory impact (`pio run -e x4c`, static)

| | Upstream | Patched | Delta |
|---|---|---|---|
| RAM (static) | 111,620 B | 111,636 B | +16 B |
| Flash | 5,376,323 B | 5,393,935 B | +17,612 B |

These numbers do not include heap. While Field Sync runs, the NimBLE host and controller use heap.
The host is in PSRAM through `scripts/s3_nimble_psram.h`. Upstream measured about 46 KB of internal
RAM for the page-turner stack on the S3, and the relay should need a similar amount. This has not
been measured. The relay itself buffers at most one message: 16 KB maximum, in PSRAM above 4 KB.

## Known limitations

- Untested on a device or with real phones. The Web Bluetooth pairing behavior and the
  write-after-pairing retry on Android are assumptions.
- NimBLE allows legacy pairing as a fallback. The reader requires an authenticated (passkey) and
  bonded link, but it cannot check that LE Secure Connections was used. Setting `SM_SC_ONLY` would
  also apply to the page turner's HID remotes and break their pairing.
- The phone bond shares NimBLE's bond store (3 entries on the prebuilt S3 config) with page-turner
  remotes. When the store is full, NimBLE removes the oldest bond.
- Clipping sync is skipped over Bluetooth because it uses its own HTTP client. Account sign-up and
  authentication in Settings still use Wi-Fi only.
- The relay does not send `Authorization: Basic` (patch 0005). The default server's CORS rules
  reject it, and it would expose the plain password to the phone. Servers that need Basic auth
  (Calibre-Web-Automated) do not work over Bluetooth.
- After a phone connects, it has 2 minutes to pair and send its hello (patch 0006). After that the
  reader ends the sync and turns Bluetooth off.
- Header names are JSON object keys, so a duplicate header name keeps only the last value.
- Only `env:x4c` enables the feature. The `x4c-gh_release*` environments do not.
- The firmware's agent guide requires a four-reviewer handoff (`.agents/skills/firmware-handoff`)
  before upstream submission. That handoff was not done for these patches.
