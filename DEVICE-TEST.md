# Physical-device acceptance checklist

Not yet performed. Record the exact reader model, firmware version and EPUB SHA-256.

- [ ] Stock hardware: screen, buttons, charging, card detection.
- [ ] The generated EPUB opens without a crash.
- [ ] All four chapters appear in the reader's table of contents.
- [ ] Water-storage links open the included water-treatment chapter without Wi-Fi.
- [ ] Back-to-contents links work from every chapter.
- [ ] Lists preserve their ordering; tables remain readable.
- [ ] Compare numeric instructions to the original CDC pages: percentages, fractions, temperatures, ranges, wait times and unit symbols.
- [ ] Resize text without clipping or losing instructions.
- [ ] Read each chapter in airplane/offline mode.
- [ ] Sleep, resume and restart preserve usable reading position.
- [ ] Measure battery consumption under a recorded reading schedule; do not infer whole-device standby life from e-ink image retention.
- [ ] Verify it is readable under the lighting where it will be used; there is no built-in light.

Maps, first aid, shelter and repairs have not been supplied in the starter edition. Do not mark those capabilities tested.

## Bluetooth phone sync (Field Sync fork only; see `ble-sync/`)

- [ ] Forked firmware flashes and boots; stock firmware backup saved first.
- [ ] Settings → Connectivity → CrossPoint Sync shows Sync Transport; set Phone (Bluetooth).
- [ ] Sync Progress shows the waiting screen; phone finds `FieldSync-XXXX`.
- [ ] First pairing shows a passkey on the reader; the phone accepts it.
- [ ] Progress uploads from the reader and downloads to it, matching the phone reading app.
- [ ] Reader stops advertising after the sync and after 60 s with no phone.
- [ ] A paired Bluetooth page turner reconnects afterward.
- [ ] Auto transport uses saved Wi-Fi when available and falls back to the phone otherwise.
