# Self-hosted third-party files

The UI loads nothing from a CDN at runtime (CSP `script-src 'self'`). Each file below was taken from the npm registry
tarball (`npm pack <pkg>@<version>`, registry integrity checked) and is loaded with an `integrity` attribute.
If you replace a file, update its hash here and in the HTML that loads it:
`openssl dgst -sha384 -binary <file> | openssl base64 -A`.

| File | Package | Licence | SHA-384 |
|---|---|---|---|
| `leaflet/leaflet.js` | leaflet 1.9.4 (`dist/`) | BSD-2-Clause (`leaflet/LICENSE`) | `sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH` |
| `leaflet/leaflet.css` | leaflet 1.9.4 (`dist/`) | BSD-2-Clause | `sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H` |
| `three/three.min.js` | three 0.128.0 (r128, `build/`) | MIT (`three/LICENSE`) | `sha384-CI3ELBVUz9XQO+97x6nwMDPosPR5XvsxW2ua7N1Xeygeh1IxtgqtCkGfQY9WWdHu` |
| `qrcode/qrcode.js` | qrcode-generator 1.4.4 (Kazuhiko Arase) | MIT (header of the file) | `sha384-8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k` |
| `fonts/*.woff2` | @fontsource dm-mono, instrument-serif, unbounded 5.3.0 (latin subset) | SIL OFL 1.1 (`fonts/OFL.txt`) | loaded by `fonts/fonts.css` |

Cross-checks: `leaflet.js` / `leaflet.css` match the sha256 SRI published on leafletjs.com for 1.9.4
(`sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=`, `sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=`);
`three.min.js` matches the cdnjs r128 SRI (`sha512-dLxUelApnYxpLt6K2iomGngnHO83iUvZytA3YjDUCjT0HDOHKXnVYdf3hU4JjM8uEhxf9nD1/ey98U3t2vZ0qQ==`).

Map tiles come from `https://tile.openstreetmap.org` (the only external origin in the CSP, `img-src`), with the
"© OpenStreetMap contributors" attribution shown on every map, as the OSM tile usage policy requires. The policy is
for light use: before real traffic, switch the tile URL in `js/livemap.js` to a tile provider or self-hosted tiles.
