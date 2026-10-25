# Field Library

A personal offline reference library for a low-cost e-ink reader. Initial hardware target: Xteink X4 Classic with CrossPoint. Original project code and documentation are MIT licensed.

**Status:** working starter EPUB; four CDC text chapters; no physical-reader validation yet. This is a content kit, not new firmware or open hardware. It is independent of Survival Codex, CDC and Xteink.

## Read it now

Open `dist/field-library.epub` in an EPUB reader, or open `dist/preview/start.html` in a browser. The book includes emergency water storage, water treatment, food after emergencies and hygiene. Chapter links work offline. Links explicitly marked `[online]` are not downloaded.

Photographs and other media are omitted, including third-party stock photography; captions and article wording are preserved. No safety instructions are generated or paraphrased by the build. Review converted instructions against the originals before relying on them. This starter is not a complete emergency manual.

## Build

Requires Python 3.10+; no packages or API keys.

```sh
python build.py fetch
python build.py build
python -m unittest discover -s tests -v
```

`fetch` downloads only the four URLs in `sources.json`, from CDC. `sources.lock.json` pins the exact downloaded bytes and dates. Existing pins are enforced; a changed page fails instead of silently updating the book. When deliberately updating sources, use `python build.py fetch --refresh`, review the new source text and audit, then build again.

`build` is offline and checks every source hash. A fixed lock and cache produce identical EPUB bytes, including fixed ZIP timestamps. Cached originals are retained locally but excluded from the source repository. Since upstream pages can change, keep a private copy of `cache/` for exact future rebuilds. The public source repository alone cannot guarantee that an old upstream snapshot remains downloadable.

Outputs:

- `dist/field-library.epub`: EPUB 2 with NCX navigation and four chapters.
- `dist/preview/`: the same XHTML chapters for browser inspection.
- `dist/audit.json`: external links and omitted media for each chapter.

## Under-$100 hardware plan

The official X4 Classic product data was checked October 24, 2026 at $79, including a 16GB microSD and magnetic charging adapter. Reserve the remaining $21 for delivery, tax and any necessary cable/card reader. This is a budget ceiling, not a verified delivered quote. Reuse an existing USB power supply and reading light. Do not add accessories until the checkout total is known.

Buy only after confirming the exact model is **X4 Classic / X4 V2** and the delivered total is below $100. Other X4 models use different firmware. Official specifications list a 4.3-inch 219-PPI screen, physical buttons, 920mAh battery, no touchscreen and no front light. It charges using the included magnetic adapter, not a USB-C socket directly on the reader. No waterproof rating is assumed.

- Device: https://www.xteink.com/products/xteink-x4-classic-pocket-ereader
- CrossPoint: https://github.com/crosspoint-reader/crosspoint-reader
- Verified support milestone: https://github.com/crosspoint-reader/crosspoint-reader/releases/tag/1.6.5

## Install when the reader arrives

1. Test charging, screen, buttons and reading a stock book before modification.
2. Follow the current CrossPoint instructions for the **X4 Classic**, saving a stock firmware backup if the supported installation method permits it. Never flash the original X4/X3 image onto the Classic.
3. Copy `dist/field-library.epub` to the microSD using a card reader or the transfer method supported by the installed firmware.
4. Open the book, navigate through its contents, and follow the acceptance checklist in `DEVICE-TEST.md`.

No firmware has been downloaded or flashed by this project. Firmware upgrades are not required to run the builder. The EPUB's compatibility with CrossPoint is a target, not a tested claim.

## What gets published

Code, tests, source manifest and lock, documentation, and generated text-only EPUB. Original upstream pages remain local in ignored cache; the source manifest links to their publishers. Third-party content is not relicensed by this project's MIT license. CDC government-authored text is attributed; stock photos and agency logos are excluded. Review additions individually for reuse terms.

No private medical notes, home coordinates or personal evacuation plans belong in the public repository. Add personal documents locally, separately from release artifacts.

## Next steps

- Verify EPUB structure with EPUBCheck when Java/EPUBCheck is available; present checks cover XML, packaging, local links, content preservation fixtures and repeatability.
- Test the actual X4 Classic: font size, tables, percentages, temperatures, symbols, return navigation and sleep/resume.
- Add first-aid, shelter and repair sources after reviewing formats and content rights.
- Add a regional map pack after the owner selects a region. Maps are not included yet.
- Expand to selected encyclopedia articles with per-source attribution and license handling.

Keep version one as a book that runs on existing firmware. Only fork CrossPoint if device testing exposes a concrete navigation need.
