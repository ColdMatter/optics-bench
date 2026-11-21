# Optics bench simulator

A standalone 2D optics bench simulator that runs in the browser. `npm run build` produces a single `dist/index.html` that opens from disk with no server.

```
npm install
npm run dev     # development server
npm run build   # type-check and build dist/index.html
npm test        # unit tests
npm run e2e     # build, then smoke test
```

## Glass data

`src/data/glasses.json` is generated from the CC0 [refractiveindex.info database](https://github.com/polyanskiy/refractiveindex.info-database). To regenerate it:

```
git clone --depth 1 https://github.com/polyanskiy/refractiveindex.info-database
npm run glasses -- <path-to-clone>
```

## Lens catalogue

`src/data/lenses.json` holds the Thorlabs lenses parsed from their Zemax files. The Thorlabs focal-shift curves in `src/data/thorlabs-focal-shift/` validate the tracer against them. To regenerate both (needs Playwright with Chromium, and `pdftotext` from Poppler):

```
npm run lenses              # download into scripts/vendor-cache/, then rebuild
npm run lenses -- --offline # rebuild from the cache
```

## Save file format

A setup is a JSON file written by `serialiseSetup` and read by `parseSetup` (`src/engine/io.ts`). Lengths are in mm, wavelengths in nm and angles in degrees. Every number must be finite. `version` is `1`; a file with a higher version is rejected as made by a newer version. Errors name the offending path, e.g. `optics[2].focalLengthMm: expected a non-zero number`. Ids must be unique across `sources` and `optics` together.

| Field | Contents |
| --- | --- |
| `version` | `1` |
| `sources[]` | `kind` (`point`, `collimated`, `gaussian`), `id`, `label`, `z`, `y` (mm), `wavelengthsNm` (non-empty, each > 0). `point`: `coneHalfAngleDeg` (`"fill"` or 0 to 90 exclusive), `rayCount` (integer ≥ 1). `collimated`: `widthMm` (≥ 0), `angleDeg`, `rayCount`. `gaussian`: `angleDeg`, `waistRadiusMm` (> 0), `waistZ` (mm), `m2` (≥ 1). |
| `optics[]` | Common: `kind`, `id`, `label`, `z` (mm; first vertex of a lens). Lens, ideal lens and SLM also have `decentreMm` and `tiltDeg` (\|tilt\| < 90). |
| `optics[]` lens | `kind: "lens"`, `flipped` (boolean), `prescription`: `partNumber` (non-empty), `vendor`, `source` (`zmx` or `drawing`), `sourceRef`, `surfaces[]` (at least 2). |
| lens `surfaces[]` | `curvature` (1/mm, positive = centre of curvature at +z), `conic`, `asphere` (`[A4, A6, …]`, mm^-3, mm^-5, …), `semiDiameterMm` (> 0), `thicknessToNextMm` (≥ 0), `glassAfter` (glass name, or `null` for air; `null` on the last surface). |
| `optics[]` ideal lens | `kind: "ideal"`, `focalLengthMm` (non-zero, negative allowed), `apertureMm` (diameter, > 0). |
| `optics[]` SLM | `kind: "slm"`, `apertureMm`, `pixelPitchUm`, `designWavelengthNm` (all > 0), `phase[]` of terms: `fresnel` (`focalLengthMm`, non-zero), `blaze` (`angleDeg`), `polynomial` (`coefficientsRad`, Σ a_k (y/R)^k for k = 1…, R = aperture/2), `table` (`yMm` strictly increasing, `phaseRad` of the same length, at least 2 points). |
| `optics[]` aperture | `kind: "aperture"`, `decentreMm`, `diameterMm` (> 0). |
| `optics[]` screen | `kind: "screen"` (no further fields). |
| `glasses` | Map from glass name to `{ name, formula (1, 2, 3 or "constant" — refractiveindex.info formula number), coefficients (non-empty, wavelengths in µm), rangeUm: [min, max] }`. Lenses refer to these, or to the bundled glasses, by name. |

Example:

```json
{
  "version": 1,
  "sources": [
    { "kind": "collimated", "id": "a1b2c3d4", "label": "Beam", "z": 0, "y": 0,
      "wavelengthsNm": [780], "widthMm": 4, "angleDeg": 0, "rayCount": 11 }
  ],
  "optics": [
    { "kind": "ideal", "id": "e5f6a7b8", "label": "f = 100", "z": 50,
      "decentreMm": 0, "tiltDeg": 0, "focalLengthMm": 100, "apertureMm": 25 },
    { "kind": "screen", "id": "c9d0e1f2", "label": "Focus", "z": 150 }
  ],
  "glasses": {}
}
```
