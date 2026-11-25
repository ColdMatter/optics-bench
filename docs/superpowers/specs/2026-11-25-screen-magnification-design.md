# Magnification on screens

## Intent

Every screen should report, for each source upstream of it and each of that source's
wavelengths, the magnification from the source to the screen. It is one number per
(source, wavelength, screen). Sources are never compared with each other. All three
source kinds must give a correct value, or say plainly why they can't.

## Definitions (decided)

| Source | M at a screen | Sign |
| --- | --- | --- |
| Point | Local lateral magnification dy′/dy from real rays. The ray set is fixed first: the fan indices that reach the screen from the source as placed (the same rays as the spot's centroid and RMS). Trace the fan at y − δ and y + δ (δ = 1e-5 mm), launched exactly as `launchRays` would for a source at that height (so `'fill'` re-aims at the first optic), and match rays by index. M = (centroid of that set₊ − centroid of that set₋) / 2δ. If any ray in the set is lost at ±δ (it sits within δ of a clipping edge), halve δ and retry, down to 1e-7 mm. Below that, drop that ray from the set. Rays that newly appear at ±δ are ignored. | Signed (negative = inverted) |
| Collimated | Edge-ray ratio: (y′ of the last ray − y′ of the first ray at the screen) / `widthMm`. This is the beam-expansion ratio, valid at any screen. | Signed (negative after a focus) |
| Gaussian | w(screen) / w(source z), both from the existing q propagation (`radiusAt`). | Unsigned |

Why this point-source definition: it works for an on-axis source, where y′/y is 0/0. It
includes aberrations and distortion. At any screen, it reports how far the spot centroid
moves per mm the source moves, which is what a camera at that screen sees. At an image
plane it is the usual imaging magnification. Paraxial ABCD (it ignores aberrations, and A
is "the magnification" only at an image plane) and the chief-ray ratio y′/y (undefined on
axis and under decentre) were considered and rejected.

### Step size and ray set: measured, not assumed

M(δ) was measured for δ = 1e-1…1e-8 mm on `examples/basics/07-off-axis-4f-relay.json`
(f = 100 relay) and `examples/tweezer-imaging/rb-780nm-imaging.json` (f ≈ 12 mm asphere,
M ≈ 28.7), on and off axis, with both the fixed cone and `'fill'`:

- When the ray set doesn't change, M is flat to 8–9 significant figures from 1e-3 to
  1e-6 mm in both systems. Truncation shows at 1e-2 mm (2e-5 relative on the asphere).
  Rounding and Newton-intersection noise shows at 1e-7 mm (about 1e-8 relative). A fixed δ
  of 1e-5 mm sits mid-plateau. It would still be accurate to about 1e-4 for an object-side
  field scale of 1 µm, so δ does not need scaling to the system.
- What actually broke a naive fixed δ was the **ray set changing with δ** near vignetting.
  On the asphere with y = 0.05 mm, the matched set went 1 → 7 → 10 rays and M went 24.5 →
  27.1 → 27.9. With `'fill'`, 8 → 9 rays between δ = 1e-5 and 1e-6 moved M from 27.54 to
  27.70. Hence the fixed set and the halving rule above.
- M is the motion of the centroid of the *traced* rays, so with an aberrated spot it depends
  on which light is collected: on axis, cone 33.4° gives 28.707 and `'fill'` gives 28.549
  (0.55 %). The relay gives −1.0008 against −1.0016. This is physical (different collected
  light, different centroid), not a numerical error.

## When there is no number

- Point: no matched rays reach the screen in both traces → `M —` with no-rays wording.
- Collimated: `rayCount` < 2 or `widthMm` = 0 → "M undefined". If either edge ray is
  blocked before the screen → "M: edge ray blocked". The surviving inner rays are not used
  instead, because that would give a wrong ratio.
- Gaussian: the centre ray is blocked, or the screen is outside the traced segments →
  existing no-rays wording. An existing `clipped`/`tilted` warning already marks the beam
  unreliable, and that applies to M as well.

## Where it shows

- Readouts panel: appended to the screen line each source already gets, e.g.
  `Screen 1, 780 nm: 11 rays, centroid y = 0.000 mm, RMS 3.2 µm, M = −1.500` and
  `Screen 1, 780 nm: w = 1.00 mm, M = 2.000`. M is shown to 4 significant figures.
- `npm run check-setup` prints M on its screen lines, and it starts printing Gaussian
  screen lines (w and M), which it doesn't do today.
- README: mention magnification in "What it does" and in the readout description.

## Constraints

- Engine function(s) in `src/engine/focus.ts` beside `screenStats`, with no DOM.
- The point-source perturbation retraces 2 fans per source and wavelength. Memoise it per
  `Setup` the way `memoFocus` does, and keep it out of `traceSetup`, so the drag budget in
  `tests/performance.test.ts` is unaffected.
- Setup format unchanged (no version bump).

## Tests (asked for)

In `tests/focus.test.ts` (and `tests/readouts.test.ts` for formatting):
- Ideal-lens imaging at 2f–2f gives M = −1. A 4f relay with f₁, f₂ gives M = −f₂/f₁ for a
  point source, on axis and off axis.
- A collimated source through an f₁/f₂ telescope gives −f₂/f₁ at a screen after it. Before
  the internal focus the value is a positive fraction.
- A Gaussian through a telescope gives |f₂/f₁| for a collimated input.
- Edge ray blocked, zero width and no rays give the stated messages.
- A point source whose fan has a ray just inside a clipping edge gives the same M as with
  that ray's neighbour set (the halving rule), and M agrees with δ = 1e-4 to 1e-7.
- Check `examples/basics/07-off-axis-4f-relay.json` with `check-setup`.

## Left to the builder

The exact function signatures and names, the memo layout, and the readout wording beyond
the examples above.
