# Optics bench simulator

A standalone 2D optics bench simulator that runs in the browser. `npm run build` produces a single `dist/index.html` that opens from disk with no server. It was written for the CaF/Rb tweezer experiments in the ColdMatter group but has no dependency on their lab software.

## What it does

- Places sources (point, collimated, Gaussian) and optics (catalogue lenses, ideal thin lenses, SLMs, apertures, screens) on an unfolded optical axis: z along the axis, y off it, light running left to right.
- Traces real lenses surface by surface with Snell's law and the glass index at each wavelength, so chromatic and off-axis aberrations come from the physics. Ideal lenses are achromatic.
- Propagates Gaussian beams through the paraxial (ABCD) behaviour of the real surfaces and draws the ±w(z) envelope.
- Treats an SLM as a 1D phase profile that bends each ray by the local phase gradient.
- Reads out paraxial and best focus per wavelength, the focal shift between wavelengths, Gaussian waists and screen spot statistics.
- Gives the magnification from every upstream source to each screen, per wavelength. For a point source it is dy′/dy of the spot centroid: how far the spot on the screen moves per mm the source moves, signed, so negative means inverted. It works on axis, includes aberrations and distortion, and is the usual imaging magnification at an image plane. Because it follows the centroid of the traced rays, an aberrated spot's M depends on the cone the source launches. Point sources also get the object-side RMS, the spot's RMS divided by |M|: its blur referred back to the object, ignoring diffraction. For a collimated source it is the signed separation of the two edge rays on the screen over the launch width (the beam expansion; it reads "edge ray blocked" if either is clipped). For a Gaussian source it is w at the screen over w at the source.
- Shows a selected lens's effective focal length and front and back working distances at every source wavelength (the d line, 587.6 nm, if there are no sources), both paraxial and as the best focus with the clear aperture filled, in the lens's current orientation. Front is from the first vertex back to the point imaged to infinity; back is from the last vertex to the focus of collimated light.
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

## Exporting

- **Export image ▸ SVG** saves the bench as a vector image, framed as it is on screen (pan, zoom or **Fit** first), with rays and Gaussian beams as the **Show** toggles have them. It is always in the light theme on white, without the hover line or selection highlight. SVG stays sharp at any size and opens in Inkscape or Illustrator for editing; it is the one to use for papers and posters.
- **Export image ▸ PNG** saves the same picture at three times the on-screen resolution, for slides and chat.
- **Export tables** saves the elements table or the readouts as CSV, named after the setup file. Elements are at full precision; readouts are as displayed, units included, with one block per source and rows under a screen named "Screen: quantity".
- **Copy**, in the Elements and Readouts headers, copies the same tables to the clipboard as Markdown.

## Controls

| On the bench | Does |
| --- | --- |
| Wheel | Zoom both axes about the cursor |
| Shift + wheel | Zoom y only |
| Drag empty space | Pan |
| Drag an element | Move it along z (hold Shift as well to snap to whole mm) |
| Alt + drag an element | Move its y / decentre |
| Click | Select (empty space clears the selection) |
| Shift + click another element | Add a dimension arrow from the selected element to it, labelled with the distance in z between their `z` values (vertex to vertex for lenses). Arrows are saved with the setup and follow the elements as they move |
| Click an arrow or its label, then Delete | Remove that arrow (deleting an element also removes its arrows) |
| Double-click empty space, or **Fit** | Fit everything in view |
| Hover | Shows z, y and w(z) of each Gaussian beam at the cursor |
| Delete | Remove the selected element or arrow |
| Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y | Undo / redo (⌘ on a Mac) |

Every value can also be typed into the elements table or the properties panel. Editing in one place updates the others. The table's **Δz** column gives each element's distance in z from the row above it.

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

`src/data/glasses.json` is generated from the CC0 [refractiveindex.info database](https://github.com/polyanskiy/refractiveindex.info-database): the optical glasses of Schott, Ohara, CDGM, Hoya, Sumita and Hikari, plus fused silica, CaF₂, ZnSe, silicon, germanium, MgF₂ (ordinary ray), PMMA and Schott's old BK7 (as N-BK7) under the names Zemax files use (`F_SILICA`, `CAF2`, `ZNSE`, `SILICON`, `GERMANIUM`, `MGF2`, `ACRYLIC`, `BK7`). Only entries with a dispersion formula (refractiveindex.info types 1–3) are used. To regenerate it:

```
git clone --depth 1 https://github.com/polyanskiy/refractiveindex.info-database
npm run glasses -- <path-to-clone>
```

## Lens catalogue

The catalogue lists about 2,900 Thorlabs lenses, sorted by part number, from three files the app reads together.

`src/data/lenses.json` holds 63 common Thorlabs parts (AC254 and AC508 achromats, Ø1″ N-BK7 plano-convex lenses), each parsed from the Zemax file on its product page. The Thorlabs focal-shift curves in `src/data/thorlabs-focal-shift/` validate the tracer against them. To regenerate both (needs Playwright with Chromium, and `pdftotext` from Poppler):

```
npm run lenses              # download into scripts/vendor-cache/, then rebuild
npm run lenses -- --offline # rebuild from the cache
```

`src/data/thorlabs-catalogue.json` holds the rest of Thorlabs' [complete Zemax catalogue](https://www.thorlabs.com/software-pages/zemax?tabName=Zemax%20Catalog): one zip holding a Zemax `.ZMF` lens catalogue. The `.ZMF` obfuscates each lens's `.zmx` text; `scripts/lib/zmf.mjs` decodes it with the scheme open-source readers use. Each lens's part number comes from its catalogue record, and its design wavelength from its `.zmx`. Parts already in `lenses.json` are left to it, because the `.ZMF` lacks some of them and has older prescriptions for others. Lenses the tracer can't represent are left out: cylindrical (toroidal) lenses, axicons (odd asphere), GRIN lenses, and those using a material missing from `glasses.json` (mostly moulding glasses such as `D-ZK3M`, plus `B270`, infrared `BAF2` and a few others). To regenerate it:

```
npm run catalogue              # download the zip into scripts/vendor-cache/, then rebuild
npm run catalogue -- --offline # rebuild from the cached zip
npm run catalogue -- path/to/zemaxcatalog.zip   # or a .ZMF
```

It prints how many lenses were left out and why, and lists each one in `scripts/vendor-cache/catalogue-skipped.txt`. Run `npm run lenses` first if both need regenerating.

`src/data/extra-lenses.json` holds lenses promoted from a local catalogue, and the app lists them with the Thorlabs ones. Neither Thorlabs script touches it. To promote lenses, then rebuild and commit:

```
npm run promote-lenses -- path/to/my-lenses.json              # every lens in the file
npm run promote-lenses -- path/to/my-lenses.json XY-100 XY-200  # just these parts
```

The shared catalogue has no room for glass substitutes. A glass you replaced with a bundled glass is renamed to it in the promoted lens. A lens with a constant-index substitute, or with a non-bundled glass that has no substitute, is refused. So are Thorlabs parts, and parts already promoted unless you pass `--replace`.

## Save file format

A setup is a JSON file written by `serialiseSetup` and read by `parseSetup` (`src/engine/io.ts`). Lengths are in mm, wavelengths in nm and angles in degrees. Every number must be finite. `version` is `1`, or `2` when the file has `measurements`, so that older builds refuse it rather than silently drop the arrows; a file with a higher version is rejected as made by a newer version. Errors name the offending path, e.g. `optics[2].focalLengthMm: expected a non-zero number`. Ids must be unique across `sources`, `optics` and `measurements` together.

| Field | Contents |
| --- | --- |
| `version` | `1`, or `2` with `measurements` |
| `sources[]` | `kind` (`point`, `collimated`, `gaussian`), `id`, `label`, `z`, `y` (mm), `wavelengthsNm` (non-empty, each > 0). `point`: `coneHalfAngleDeg` (`"fill"` or 0 to 90 exclusive), `rayCount` (integer ≥ 1). `collimated`: `widthMm` (≥ 0), `angleDeg`, `rayCount`. `gaussian`: `angleDeg`, `waistRadiusMm` (> 0), `waistZ` (mm), `m2` (≥ 1). |
| `optics[]` | Common: `kind`, `id`, `label`, `z` (mm; first vertex of a lens). Lens, ideal lens and SLM also have `decentreMm` and `tiltDeg` (\|tilt\| < 90). |
| `optics[]` lens | `kind: "lens"`, `flipped` (boolean), `prescription`: `partNumber` (non-empty), `vendor`, `source` (`zmx` or `drawing`), `sourceRef`, `surfaces[]` (at least 2), and optionally `designWavelengthNm` (> 0), the primary wavelength of its Zemax file. |
| lens `surfaces[]` | `curvature` (1/mm, positive = centre of curvature at +z), `conic`, `asphere` (`[A4, A6, …]`, mm^-3, mm^-5, …), `semiDiameterMm` (> 0), `thicknessToNextMm` (≥ 0), `glassAfter` (glass name, or `null` for air; `null` on the last surface). |
| `optics[]` ideal lens | `kind: "ideal"`, `focalLengthMm` (non-zero, negative allowed), `apertureMm` (diameter, > 0). |
| `optics[]` SLM | `kind: "slm"`, `apertureMm`, `pixelPitchUm`, `designWavelengthNm` (all > 0), `phase[]` of terms: `fresnel` (`focalLengthMm`, non-zero), `blaze` (`angleDeg`), `polynomial` (`coefficientsRad`, Σ a_k (y/R)^k for k = 1…, R = aperture/2), `table` (`yMm` strictly increasing, `phaseRad` of the same length, at least 2 points). |
| `optics[]` aperture | `kind: "aperture"`, `decentreMm`, `diameterMm` (> 0). |
| `optics[]` screen | `kind: "screen"` (no further fields). |
| `measurements[]` | Optional. Dimension arrows on the bench: `id`, `a` and `b` (ids of two different sources or optics). The distance is \|z<sub>b</sub> − z<sub>a</sub>\|, so it isn't stored. |
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
