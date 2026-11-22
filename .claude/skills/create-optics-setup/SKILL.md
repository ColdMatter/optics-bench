---
name: create-optics-setup
description: Use when asked to make, write, build or model an optics-bench setup (a .json file the app opens) from a description, a lab note, a sketch, a list of distances or part numbers, e.g. "set up a 4f telescope with two AC254-100s", "model our imaging path", "make an example with an SLM". Also when adding to examples/ or fixing a setup file that won't open.
---

# Creating an optics-bench setup

A setup is a JSON file (`version: 1`, `sources`, `optics`, `glasses`). The **Save file format** table in `README.md` is the field reference. Working setups to copy from: `examples/basics/` has one small file per feature (each kind of source and optic, orientation, SLM terms, warnings), and `examples/tweezer-imaging/` has a full experiment model. `examples/README.md` describes both.

## Recipe

1. **Unfold the layout onto one axis.** Light runs +z. Mirrors and dichroics used in reflection are left out, and every distance becomes a path length along the beam. Put the source (or the object) at z = 0.
2. **Choose the sources.**
   - `point`: an emitter or object point. NA → `coneHalfAngleDeg = asin(NA)` in degrees, or `"fill"` to fill the first optic.
   - `collimated`: a parallel bundle `widthMm` wide at `angleDeg`.
   - `gaussian`: `waistRadiusMm` is the 1/e² radius. **`waistZ` is absolute z**, not relative to the source. Use `m2: 1` unless told otherwise.
   - Give a source several `wavelengthsNm` to see chromatic effects.
3. **Choose each optic.**
   - **A catalogue part** (`src/data/lenses.json`: Thorlabs AC254-xxx-A/B, AC508-xxx-A/B, LA1xxx): copy the whole `prescription` object into the lens.
   - **A part with a vendor Zemax file**: parse it with `parseZmx(decodeZmx(bytes))` from `src/engine/zmx.ts` and store the prescription inline. If it names a glass that isn't bundled, add the glass under `glasses`.
   - **An unknown part, or "a 750 mm lens"**: use `kind: "ideal"` with `focalLengthMm` and `apertureMm` (the diameter). It is achromatic, so say so when chromatic results matter.
   - Other kinds: `slm` (phase terms `fresnel`/`blaze`/`polynomial`/`table` at `designWavelengthNm`), `aperture` (an iris: `diameterMm`), `screen` (a camera or a plane to read spots on).
4. **Place the lenses.**
   - A lens's `z` is its **first vertex**.
   - Unflipped, the first surface listed in the prescription faces the source. For the Thorlabs achromats and LA1xxx that is the strongly curved (crown or convex) side, so put it towards the collimated side: `flipped: false` when collimated light comes in and the lens focuses it, `flipped: true` when the lens collimates (the second lens of a telescope or relay).
   - If unsure, trace both orientations and keep the one with the smaller RMS at best focus.
   - f₁ + f₂ and similar spacings hold between principal planes, not vertices, so compute them by tracing (step 5). When a description gives a distance between lenses, decide whether it is vertex to vertex or an air gap, and state which you used.
5. **Compute "at the focus" positions; don't guess them.** For a screen at the image or an iris at an intermediate focus, trace and read the focus (step 7). The focus readout is always **after the last optic**: for an intermediate focus, check a copy with the later optics removed. For a lens spaced to make the output afocal (collimated), bisect its `z` until a ray launched parallel to the axis, a little off it, leaves with zero slope (`traceRay(...).final.dy`). `status: collimated` needs a slope variance below 1e-12, which a numerical search never reaches exactly. Under spherical aberration, best focus (where you'd focus by eye) can be millimetres from paraxial focus. Say which one you used.
6. **Ids and labels.** Ids are short, readable and unique across sources and optics (`"atoms"`, `"L1"`). Labels are shown on the bench, so keep them short.
7. **Validate:** run `npm run check-setup -- path/to/setup.json`. It parses the file as the app does and prints warnings, the paraxial and best focus per source and wavelength, Gaussian waists, and screen spots. Fix every warning you didn't intend (`overlap`, `unknown-glass`, `glass-extrapolated`, `slm-pitch-limit`, Gaussian `clipped`).
   `check-setup` prints focus and screen spots only for point and collimated sources. For a Gaussian source it prints the waists: each `z` is an absolute position and can lie behind the optic it follows (a virtual waist), and a `collimated` waist has no meaningful `z`.
8. **Record what you assumed.** Name every value you guessed or derived (a part suffix, a pixel pitch, how a distance was measured, best or paraxial focus) and where the rest came from: in a row of `examples/README.md` for a setup under `examples/`, otherwise in your reply.

## Generating a setup with Node

Build the file from a script, not by hand, so that prescriptions are copied exactly and computed positions stay consistent:

```js
// node make-setup.mjs   (run from the repo root)
import { readFileSync, writeFileSync } from 'node:fs';
const lenses = JSON.parse(readFileSync('src/data/lenses.json', 'utf8'));
const part = (p) => {
  const found = lenses.find((l) => l.partNumber === p);
  if (!found) throw new Error(`${p} is not in the bundled catalogue`);
  return found;
};
const placed = { decentreMm: 0, tiltDeg: 0 };
const lens = (id, label, z, partNumber, flipped = false) => ({ kind: 'lens', id, label, z, ...placed, flipped, prescription: part(partNumber) });

const setup = {
  version: 1,
  sources: [{ kind: 'point', id: 'obj', label: 'Object', z: 0, y: 2, wavelengthsNm: [780], coneHalfAngleDeg: 4, rayCount: 11 }],
  optics: [
    lens('L1', 'L1', 96, 'AC254-100-B', true), // crown side towards the collimated space between L1 and L2
    lens('L2', 'L2', 290, 'AC254-100-B'),
    { kind: 'screen', id: 'img', label: 'Image', z: 393.5 }, // from check-setup: best focus 393.46
  ],
  glasses: {},
};
writeFileSync('examples/basics/07-off-axis-4f-relay.json', JSON.stringify(setup, null, 2) + '\n');
```

When a position has to come from the trace (a camera at best focus, an afocal spacing, an objective moved until a second wavelength focuses), write the script in TypeScript, import the engine and compute it. Node can't import the engine's `.ts` files directly, so bundle the script first (it can live anywhere, with absolute imports of `src/engine/…`):

```
npx rolldown my-setup.ts --platform node --format esm --file /tmp/my-setup.mjs && node /tmp/my-setup.mjs
```

The functions you need: `traceSetup`, `traceRay`, `lookupFor` (`trace.ts`); `focusPerWavelength`, `screenStats` (`focus.ts`); `traceGaussians` (`gaussian.ts`); `opticExtent` (`optic.ts`); `lensThickness` (`lens.ts`); `parseSetup`, `serialiseSetup` (`io.ts`). `scripts/check-setup.ts` is a working example.

## Things that catch people out

| Problem | Why |
| --- | --- |
| Two lenses side by side at different y, each meant for its own beam | Tracing is sequential. Every ray meets every optic ahead of its source, and a lens it misses blocks it. Compare cases in separate files, or start the second source after the first set of optics. |
| An optic before a source's z does nothing to it | Each source only sees the optics ahead of it. |
| Angles in radians or lengths in µm | Everything in the file is mm, nm and degrees. |
| The file won't open | The error names the path (`optics[2].focalLengthMm: …`). Every number must be finite; ids must be unique across sources and optics together; the last lens surface has `thicknessToNextMm: 0` and `glassAfter: null`. |
| Readouts say "approx." | A lens has `prescription.source: "drawing"`. That is right for a modelled or drawing-derived lens, and it tells the reader that absolute positions are approximate. |
| A Fresnel lens defocuses instead of focusing | `fresnel.focalLengthMm` > 0 converges. A blaze `angleDeg` > 0 deflects towards +y. |
