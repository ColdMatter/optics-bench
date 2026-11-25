# Optics bench simulator

A standalone 2D optics bench simulator that runs in the browser. `npm run build` produces a single `dist/index.html` that opens from disk with no server. It was written for the CaF/Rb tweezer experiments in the ColdMatter group but has no dependency on their lab software.

## What it does

- Places sources (point, collimated, Gaussian) and optics (catalogue lenses, ideal thin lenses, SLMs, apertures, screens) on an unfolded optical axis: z along the axis, y off it, light running left to right.
- Traces real lenses surface by surface with Snell's law and the glass index at each wavelength, so chromatic and off-axis aberrations come from the physics. Ideal lenses are achromatic.
- Propagates Gaussian beams through the paraxial (ABCD) behaviour of the real surfaces and draws the ±w(z) envelope.
- Treats an SLM as a 1D phase profile that bends each ray by the local phase gradient.
- Reads out paraxial and best focus per wavelength, the focal shift between wavelengths, Gaussian waists and screen spot statistics.
- Solves for lens positions that meet Gaussian beam-size targets.

It does not do:

- **Skew rays.** Tracing is meridional only. For off-axis sources it shows the tangential behaviour, and the readouts say so. Sagittal focus and astigmatism are not computed.
- **Wave optics.** No interference, diffraction patterns or multi-spot SLM holograms.
- **Folded geometry.** No mirrors, beamsplitters or a top-down breadboard view.
- **Non-sequential effects** (ghosts, back-reflections), polarisation, coatings, transmission losses or tolerancing.

Gaussian readouts are marked unreliable when the beam fills more than 80 % of an element's clear aperture, or when it meets an element tilted by more than 3°.

Each lens carries the source of its prescription: a Zemax file (`zmx`) or values read off the vendor's drawing (`drawing`). Every bundled lens comes from a Zemax file. Absolute focus positions involving a `drawing` lens are labelled "approx.", because drawings round radii and thicknesses. Focal shifts are not affected and are not labelled.

## Opening it

Build it once (below), then open `dist/index.html` in any modern browser, by double-clicking it or from `file://`. The file is self-contained, so it can be copied anywhere. The setup is autosaved in the browser's storage, so it is still there when you reopen the page. **Save…** asks where to save the setup file and what to call it: Chrome and Edge open the system save dialog, other browsers ask for a name and download the file. **Open…** reads one back (format below).

## Controls

| On the bench | Does |
| --- | --- |
| Wheel | Zoom both axes about the cursor |
| Shift + wheel | Zoom y only |
| Drag empty space | Pan |
| Drag an element | Move it along z (hold Shift as well to snap to whole mm) |
| Alt + drag an element | Move its y / decentre |
| Click | Select (empty space clears the selection) |
| Double-click empty space, or **Fit** | Fit everything in view |
| Hover | Shows z, y and w(z) of each Gaussian beam at the cursor |
| Delete | Remove the selected element |
| Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y | Undo / redo (⌘ on a Mac) |

Every value can also be typed into the elements table or the properties panel. Editing in one place updates the others.

## Importing a lens

**Add optic ▸ Catalogue lens…** opens the bundled catalogue, which you can search by part number or focal length. **Add** inserts the lens after the selected element. For a part that isn't bundled, use **Import .zmx…** and pick the vendor's Zemax file. A file the tracer can't represent (coordinate breaks, mirrors, surface types such as toroidal) is rejected with a message naming the surface. Inch units and UTF-16 files are read normally. If the file names a glass that isn't bundled, pick a substitute from the bundled glasses or type a constant index. The choice is saved with the setup.

### Local catalogue

In Chrome or Edge, an imported lens is also kept in a **local catalogue**: a JSON file of your own, such as `my-lenses.json`, that the app reads and writes in place. The first import offers **Open file…** or **New file…** to choose it. Put it in a synced folder to share it between computers. From then on its lenses appear at the top of the catalogue list, tagged **Local**, with any glass substitutes you chose, and **✕** removes one from the file. Re-importing a part replaces its entry. The app remembers the file; after a browser restart, **Reconnect** grants access again. Firefox and Safari can't write local files, so there an import goes only into the setup.

A local catalogue file is `{ "version": 1, "lenses": [ { "prescription": …, "substitutions": { "<glass>": { "kind": "bundled", "name": "N-SF6" } | { "kind": "index", "index": 1.72 } } } ] }`, with `prescription` as in the save file format below.

## Examples

`examples/basics/` is a numbered series of small setups, each demonstrating one feature (sources, lens orientation, chromatic focus, apertures, screens, SLM terms, warnings, the solver), with something to try in each. `examples/tweezer-imaging/` models chromatic aberration in the CaF/Rb tweezer imaging path. `examples/README.md` describes them all.

## Development

```
npm install
npm run dev     # development server
npm run build   # type-check and build dist/index.html
npm test        # unit tests
npm run e2e     # build, then smoke test
npm run check-setup -- examples/basics/01-point-source-ideal-lens.json   # print a setup's foci, waists and screen spots
```

The smoke test drives the built page in Playwright's Chromium. Download that browser once with `npx playwright install chromium`.

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

`src/data/extra-lenses.json` holds lenses promoted from a local catalogue, and the app lists them with the Thorlabs ones. `npm run lenses` leaves it alone. To promote lenses, then rebuild and commit:

```
npm run promote-lenses -- path/to/my-lenses.json              # every lens in the file
npm run promote-lenses -- path/to/my-lenses.json XY-100 XY-200  # just these parts
```

The shared catalogue has no room for glass substitutes. A glass you replaced with a bundled glass is renamed to it in the promoted lens. A lens with a constant-index substitute, or with a non-bundled glass that has no substitute, is refused. So are Thorlabs parts, and parts already promoted unless you pass `--replace`.

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
