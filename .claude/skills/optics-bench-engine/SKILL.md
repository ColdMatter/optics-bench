---
name: optics-bench-engine
description: Use when changing, extending or debugging optics-bench's engine or app plumbing (src/engine/, src/ui/store.ts, src/ui/app.ts): ray tracing, lens surfaces and glass indices, ideal lenses, SLM phase terms, apertures and screens, Gaussian beam (q/ABCD) propagation, focus and focal-shift readouts, the lens-position solver, setup save/load and validation, .zmx import, the bundled glass and lens data, the frame loop or undo store. Also when a readout looks wrong (focus in the wrong place, NaN, "No rays reach this point", "collimated" when it shouldn't be, approx. labels, unreliable Gaussian), rays are blocked unexpectedly, a lens imports wrongly, dragging lags, or a test in tests/ fails.
---

# optics-bench engine

A pure TypeScript engine (`src/engine/`, no DOM, unit-tested with Vitest) turns a `Setup` into traces and readouts. A vanilla-TypeScript UI (`src/ui/`) holds the setup in an undoable store and redraws from those traces. Vite builds everything into one self-contained `dist/index.html`.

## Commands

```
npm test                               # unit tests (jsdom), then the timing test alone
npm run build                          # tsc --noEmit, then vite → dist/index.html
npm run e2e                            # build, then e2e/smoke.mjs drives dist/index.html in Chromium
npm run check-setup -- file.json …     # parse a setup and print foci, waists, screen spots, warnings
```

The smoke test needs Playwright's Chromium (`npx playwright install chromium`). `tests/performance.test.ts` runs in its own Vitest project after the rest (`groupOrder: 1` in `vite.config.ts`), because parallel jsdom files inflate its wall-clock budget. Keep timing checks there.

## Conventions the whole engine relies on

| Quantity | Convention |
| --- | --- |
| Axes | z along the axis (mm), light travels +z; y up (mm). Meridional only: no x, no skew rays. |
| Units | mm, nm, and degrees in `Setup` and the UI; radians only inside the engine. µm only in labels. |
| `Ray` | `(z, y)` plus a unit direction `(dz, dy)`, normally `dz > 0`, and `wavelengthNm`. |
| Lens `z` | The first vertex. `opticExtent` = `[z, z + Σ thicknessToNextMm]`. Every other optic is a plane, `[z, z]`. |
| Curvature | 1/mm. Positive means the centre of curvature is at +z of the vertex (a biconvex lens is `+c, −c`). |
| Sag | Conic plus even asphere: `c y²/(1+√(1−(1+k)c²y²)) + Σ A(2k+2) y^(2k+2)`, `asphere = [A4, A6, …]`. A negative radicand means the surface doesn't reach that height (the ray is blocked). |
| `flipped` | `flipPrescription` reverses the surfaces, negates curvatures and asphere terms, and shifts thicknesses and glasses along by one. `z` stays the first vertex of the flipped lens. |
| Placement | Decentre, then tilt about the element's axial midpoint (lens: thickness/2; ideal lens and SLM: their plane). `toLocal`/`fromLocal` in `lens.ts`. |
| Glass | n relative to air = 1. refractiveindex.info formulas 1, 2 and 3, or `constant`, with λ in µm. Names are case-insensitive, and `setup.glasses` overrides the bundled glasses. |
| Ids | Unique across `sources` and `optics` together. `newId()` gives 8 hex characters. |

## Data flow

```
Setup (immutable) ─ store.apply(update, label, {coalesce}) ─▶ subscribers ─▶ requestFrame
renderFrame: app.results() = traceSetup + traceGaussians, cached by Setup identity
          ─▶ table, properties, drawBench, onFrame listeners (readouts → focusPerWavelength, solver panel)
```

- **Never mutate a `Setup`.** `app.results()` recomputes only when `store.get().setup !== resultsFor`, and undo keeps old setups by reference. Mutating one in place leaves stale traces and corrupts undo history. Return a new object from `store.apply`'s update.
- Dragging writes `store.apply(…, { coalesce: 'drag:<id>:<n>' })`, so a whole drag is one undo step. `select()` breaks a coalescing run.
- The store autosaves to `localStorage` (`optics-sim/setup/v1`). If the autosave won't parse (e.g. a newer build saved it), it is moved to `…/unreadable` and the default setup opens.
- Frames are coalesced to one per animation frame. View-only changes (pan, zoom, hover) redraw the canvas without re-tracing.

## Tracing (`trace.ts`, `optic.ts`, `lens.ts`, `surface.ts`, `slm.ts`)

- **Sequential.** Every ray from a source meets every optic whose `opticExtent[0] >= source.z`, in `sortedByAxialStart` order (stable for ties). Optics upstream of a source don't exist for it. Side-by-side comparisons in one setup therefore don't work: a lens whose aperture a ray misses **blocks** that ray.
- `interactOptic` dispatches by kind and returns `{ ray | null, points, warnings }`. `null` means blocked, and the path ends at the blocker (`RayPath.blockedBy`). After the last optic the ray continues to `endZ` (`defaultEndZ`: the last extent plus max(30 % of the span, 50 mm)). `RayPath.final` is the ray leaving the last optic, and the readouts use it.
- **Lens.** An unknown glass blocks every ray at that lens with an `unknown-glass` warning. For each surface, `intersect` (Newton iteration from the vertex plane; null if it misses or the sag is imaginary), then vector Snell `refract` (null on total internal reflection). A wavelength outside the glass's range is extrapolated, with one `glass-extrapolated` warning per glass and wavelength.
- **Ideal lens.** In the local frame `tanθ' = tanθ − h/f`. It is achromatic and blocks outside `apertureMm/2`.
- **SLM.** It adds the design-wavelength phase gradient: `sinθ' = sinθ + (λ/2π)·dφ0/dy`, with λ the ray's own wavelength. So diffraction is dispersive, but the phase isn't rescaled. Terms: `fresnel` `φ = −π y²/(λ0 f)` (positive f converges), `blaze` `2π y sin α/λ0` (positive angle deflects to +y), `polynomial` `Σ a_k (y/R)^k` with k starting at 1 and R = aperture/2, and `table` (`yMm`, `phaseRad`; the gradient is central differences at the table points, interpolated linearly between them). A ray is blocked with `slm-pitch-limit` where `|dφ/dy|·pitch > π`, and also outside the aperture.
- **Aperture** blocks at `|y − decentre| > d/2`. A **screen** records `screenHits[id] = y` and never blocks.
- **Point source** `'fill'` aims at the clear aperture of the first optic ahead; a number is the cone half-angle. A collimated source spreads `rayCount` rays across `widthMm`, perpendicular to `angleDeg`. A Gaussian source launches only its centre ray.
- `overlapWarnings` flags lens bodies that overlap each other, and planes that fall inside a lens body.

## Readouts (`focus.ts`, `gaussian.ts`)

- **Focus** uses only the rays that survive to the end, and their `final` segments. That is the focus after the **last** optic. For an intermediate focus (an iris plane, say), evaluate a copy of the setup truncated after that optic.
  - `paraxialZ`: two rays ±1e-4 rad about the fan's centre ray (point source), or ±1e-3 mm about it (collimated), traced through and intersected.
  - `bestZ`: the closed-form minimum of the height variance of the final segments, `z* = −Cov(intercept, slope)/Var(slope)`. With spherical aberration it can sit millimetres from `paraxialZ`; the marginal rays dominate.
  - `status` is `collimated` when Var(slope), or the paraxial pair's slope difference, is below 1e-12, and `no-rays` when fewer than two rays survive. `approximate` is set when a surviving ray went through a lens whose `prescription.source === 'drawing'`.
- **Gaussian** (`traceGaussian`): the centre ray is traced exactly, and `q` is propagated in air with `λ_eff = M²λ`. At each optic it applies `opticAbcd` at the centre ray's local hit height. Lens ABCD runs vertex to vertex in paraxial form and **ignores conic and asphere terms**. A waist is recorded after each powered optic: `z = exit − Re q`, `w0 = √(Im q · λ_eff/π)`, `collimated` when z_R > 1e5 mm. Warnings: `clipped` (2w > 0.8 × clear aperture) and `tilted` (more than 3°). These mark the readout unreliable; they don't hide it.

## Solver (`solver.ts`)

Bounded Nelder–Mead over optic `z` values. Each bound maps through `min + (max − min)(1 + sin u)/2`. It starts from the current positions plus 4 restarts from a seeded PRNG, so it is deterministic. It stops at cost < 1e-12, 2000 evaluations or 900 ms. Targets are all on Gaussian sources: `radiusAt`, `waistRadius`, `waistPosition` and `collimated`. Overlapping lenses add a penalty (weight 100). The result is a new `Setup`, and the input is untouched. Residuals: `radiusAt` and `waistRadius` relative, `waistPosition` in mm, and `collimated` is `collimationError` = d/|q| at the exit of the last powered optic (d: exit to output waist), which is 0 when collimated and ±1 far from it. `converged` means every residual is within its kind's `TOLERANCE` (1e-3, 1e-3, 1e-3 mm, 0.01) and every overlap residual below 1e-3. Every residual needs a minimum of zero, or its target can never converge.

## Files, data and import

- `io.ts`: `serialiseSetup` is `JSON.stringify(setup, null, 2)`. `parseSetup` is a hand-written validator that throws `SetupFormatError` naming the path, e.g. `optics[2].focalLengthMm: expected a non-zero number`. `numberRules` is shared with the UI's field validation. A file with `version` higher than 1 is rejected. If you change the format, bump the version and keep reading v1. The README's "Save file format" table is the user-facing spec, so update it with the format.
- `zmx.ts`: `decodeZmx` reads UTF-16 when there is a BOM, otherwise UTF-8, falling back to Latin-1. `parseZmx` keeps the surfaces from the first one with a glass through to the air surface after the last. The primary wavelength (`PWAV`, `WAVM`/`WAVL`) becomes `designWavelengthNm`, which the catalogue's f column uses. `DIAM` is a semi-diameter, `UNIT` scales lengths (MM, CM, IN, METER), and an even-asphere `PARM k` multiplies r^(2k). Only `STANDARD` and `EVENASPH` surfaces are supported. It throws `ZmxError` naming the surface for any other type, a coordinate break, a mirror, or a model glass (`___BLANK`).
- `src/data/glasses.json` comes from the CC0 refractiveindex.info database (`npm run glasses -- <clone>`). `src/data/lenses.json` holds the Thorlabs AC254, AC508 and LA1xxx parts from their Zemax files (`npm run lenses`, which needs Playwright and `pdftotext`). `src/data/thorlabs-catalogue.json` holds the rest of Thorlabs' complete Zemax catalogue (`npm run catalogue`, which decodes its `.ZMF` with `scripts/lib/zmf.mjs`, takes part numbers from the records, and skips parts already in `lenses.json`). `glasses.json` also holds fused silica, CaF₂, ZnSe, Si, Ge, MgF₂, PMMA and BK7 under Zemax's names (`MATERIALS` in `build-glasses.mjs`); infrared `BAF2` (the crystal) clashes with CDGM's BAF2 glass, so the catalogue build skips lenses that mean it. `src/data/thorlabs-focal-shift/` is vendor data that tests compare the tracer against. `src/data/extra-lenses.json` holds lenses promoted from a user's local catalogue (`npm run promote-lenses`); `elements.ts` appends it to the Thorlabs list.
- `lensLibrary.ts`: the local catalogue file format (`parseLensFile`, `withLens`, `withoutLens`) and `forSharedCatalogue`, which renames bundled glass substitutes for promotion. `src/ui/localCatalogue.ts` reads and writes that file through the File System Access API, keeping the handle in IndexedDB.

## Scripting the engine from Node

The engine's imports have no extensions, so Node can't import `src/engine/*.ts` directly. Bundle a script with rolldown, the way `scripts/check-setup.ts` does:

```
npx rolldown my-script.ts --platform node --format esm --file node_modules/.cache/my-script.mjs && node node_modules/.cache/my-script.mjs
```

The script can live outside the repo if it imports `src/engine/…` by absolute path. Use this for one-off studies, such as solving for a camera position or comparing lens orientations. Don't use it as a substitute for unit tests.

## Where to look

| Symptom | Start at |
| --- | --- |
| Rays stop at a lens they should pass | Its aperture (`semiDiameterMm`), decentre or tilt; `intersect` returning null (sag radicand); an `unknown-glass` warning; TIR in `refract` |
| A source's rays ignore an optic | The optic starts before `source.z`, so it isn't "ahead" |
| Focus or Δfocus in an odd place | Paraxial versus best focus under spherical aberration; the focus is after the last optic; `flipped`; a `glass-extrapolated` warning |
| "collimated" or "no focus" | Var(slope) below 1e-12 (truly parallel output, or a single ray), or fewer than 2 survivors |
| Gaussian waist disagrees with the rays | The ABCD ignores asphere and conic terms and uses the centre ray's hit height; check `clipped` and `tilted` |
| SLM rays vanish | `slm-pitch-limit` (phase gradient × pitch > π) or outside the aperture |
| A saved file won't open | The `parseSetup` message names the path; check `numberRules` |
| Dragging lags | `traceSetup` budget: under 8 ms for 3 sources × 3 λ × 31 rays × 6 lenses (`tests/performance.test.ts`) |
| UI shows stale results | A setup mutated in place (see Data flow) |

`tests/` has one file per engine module (`glass`, `surface`, `lens`, `slm`, `trace`, `gaussian`, `focus`, `zmx`, `io`, `solver`) and per UI unit (`store`, `view`, `readouts`, …). A fix in a module gets its case in that module's file.
