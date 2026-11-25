import { describe, expect, test } from 'vitest';
import { refractiveIndex, makeGlassLookup } from '../src/engine/glass';
import { focusPerWavelength, focusShiftCurve, lensFocalDistances, screenMagnifications, screenStats } from '../src/engine/focus';
import { parseSetup } from '../src/engine/io';
import rbImaging from '../examples/tweezer-imaging/rb-780nm-imaging.json?raw';
import { traceSetup } from '../src/engine/trace';
import type {
  Aperture,
  CatalogueLens,
  CollimatedSource,
  GaussianSource,
  IdealLens,
  Optic,
  PointSource,
  PrescriptionSurface,
  Screen,
  Setup,
  Source,
} from '../src/engine/types';

const bk7 = makeGlassLookup()('N-BK7')!;
const point = (over: Partial<PointSource> = {}): PointSource => ({
  kind: 'point', id: 'p', label: 'P', z: 0, y: 0, wavelengthsNm: [780], coneHalfAngleDeg: 5, rayCount: 21, ...over,
});
const collimated = (over: Partial<CollimatedSource> = {}): CollimatedSource => ({
  kind: 'collimated', id: 'c', label: 'C', z: 0, y: 0, wavelengthsNm: [780], widthMm: 10, angleDeg: 0, rayCount: 11, ...over,
});
const ideal = (over: Partial<IdealLens> = {}): IdealLens => ({
  kind: 'ideal', id: 'i', label: 'I', z: 200, decentreMm: 0, tiltDeg: 0, focalLengthMm: 100, apertureMm: 50, ...over,
});
const aperture = (over: Partial<Aperture> = {}): Aperture => ({
  kind: 'aperture', id: 'a', label: 'A', z: 50, decentreMm: 0, diameterMm: 4, ...over,
});
const surf = (curvature: number, thicknessToNextMm: number, glassAfter: string | null): PrescriptionSurface => ({
  curvature, conic: 0, asphere: [], semiDiameterMm: 20, thicknessToNextMm, glassAfter,
});
const singlet = (source: 'zmx' | 'drawing' = 'zmx'): CatalogueLens => ({
  kind: 'lens', id: 'l', label: 'L', z: 100, decentreMm: 0, tiltDeg: 0, flipped: false,
  prescription: {
    partNumber: 't', vendor: 't', source, sourceRef: 't',
    surfaces: [surf(1 / 51.5, 3.6, 'N-BK7'), surf(0, 0, null)],
  },
});
const setup = (sources: Source[], optics: Optic[]): Setup => ({ version: 1, sources, optics, glasses: {} });

describe('focus readouts', () => {
  test('ideal imaging focus', () => {
    const [r] = focusPerWavelength(setup([point({ y: 1 })], [ideal()]), 'p');
    expect(r!.status).toBe('ok');
    expect(r!.paraxialZ).toBeCloseTo(400, 6);
    expect(r!.bestZ).toBeCloseTo(400, 6);
    expect(r!.rmsAtBestMm!).toBeLessThan(1e-9);
    expect(r!.imageHeightMm).toBeCloseTo(-1, 9);
    expect(r!.approximate).toBe(false);
  });

  test('chromatic shift of a singlet', () => {
    const results = focusPerWavelength(setup([collimated({ wavelengthsNm: [780, 1064], widthMm: 2 })], [singlet()]), 'c');
    const back = (nm: number) => {
      const n = refractiveIndex(bk7, nm);
      return 51.5 / (n - 1) - 3.6 / n;
    };
    expect(results[1]!.paraxialZ! - results[0]!.paraxialZ!).toBeCloseTo(back(1064) - back(780), 4);
  });

  test('spherical aberration moves best focus', () => {
    const [r] = focusPerWavelength(setup([collimated({ widthMm: 20 })], [singlet()]), 'c');
    expect(r!.bestZ!).toBeLessThan(r!.paraxialZ!);
    expect(r!.rmsAtBestMm!).toBeGreaterThan(0);
  });

  test('collimated status', () => {
    const [r] = focusPerWavelength(setup([collimated()], []), 'c');
    expect(r).toMatchObject({ status: 'collimated', paraxialZ: null, bestZ: null });
  });

  test('no-rays status', () => {
    const s = setup([collimated({ widthMm: 8 })], [aperture({ diameterMm: 0.01, decentreMm: 5 })]);
    const [r] = focusPerWavelength(s, 'c');
    expect(r).toMatchObject({ status: 'no-rays', paraxialZ: null, bestZ: null, rmsAtBestMm: null, imageHeightMm: null });
  });

  test('approximate flag', () => {
    const run = (source: 'zmx' | 'drawing') =>
      focusPerWavelength(setup([collimated()], [singlet(source)]), 'c')[0]!.approximate;
    expect(run('drawing')).toBe(true);
    expect(run('zmx')).toBe(false);
  });

  test('gaussian sources have no ray focus', () => {
    const g: GaussianSource = {
      kind: 'gaussian', id: 'g', label: 'G', z: 0, y: 0, wavelengthsNm: [780], angleDeg: 0, waistRadiusMm: 1, waistZ: 0, m2: 1,
    };
    expect(focusPerWavelength(setup([g], []), 'g')).toEqual([]);
  });

  test('screen stats', () => {
    const screen: Screen = { kind: 'screen', id: 's', label: 'S', z: 100 };
    const src = collimated({ widthMm: 4, rayCount: 3 });
    const s = setup([src], [screen]);
    const [spot] = screenStats(traceSetup(s).sources[0]!, 's');
    expect(spot!.heightsMm).toEqual([-2, 0, 2]);
    expect(spot!.centroidMm).toBeCloseTo(0, 12);
    expect(spot!.rmsMm).toBeCloseTo(Math.sqrt(8 / 3), 12);
  });

  test('focus shift curve', () => {
    const curve = focusShiftCurve(setup([collimated({ widthMm: 2 })], [singlet()]), 'c', 600, 1000, 5);
    expect(curve).toHaveLength(5);
    expect(curve[0]!.wavelengthNm).toBe(600);
    expect(curve[4]!.wavelengthNm).toBe(1000);
    expect(curve[0]!.paraxialZ!).toBeLessThan(curve[4]!.paraxialZ!);
    expect(focusShiftCurve(setup([collimated()], [singlet()]), 'c', 600, 1000, 1)).toHaveLength(1);
  });
});

describe('screenMagnifications', () => {
  const screen = (z: number, id = 's'): Screen => ({ kind: 'screen', id, label: id, z });
  // Ideal lenses at z = 50 (f 50) and z = 250 (f 150): a 4f relay from z = 0 to z = 400 with M = −3.
  const relay = [ideal({ id: 'l1', z: 50, focalLengthMm: 50 }), ideal({ id: 'l2', z: 250, focalLengthMm: 150 })];
  const only = (s: Setup, sourceId: string, screenId = 's') => screenMagnifications(s, sourceId).get(screenId)!;

  test('point source imaged 2f–2f gives −1, on and off axis', () => {
    for (const y of [0, 1.5]) {
      const [m] = only(setup([point({ y })], [ideal(), screen(400)]), 'p');
      expect(m!.value).toBeCloseTo(-1, 7);
    }
  });

  test('point source through a 4f relay gives −f₂/f₁, on and off axis', () => {
    for (const y of [0, 0.5]) {
      const [m] = only(setup([point({ y })], [...relay, screen(400)]), 'p');
      expect(m!.value).toBeCloseTo(-3, 7);
    }
  });

  test('point source: a ray grazing a clipping edge keeps its place in the ray set', () => {
    // Through a real singlet the rays move by different amounts (spherical aberration), so which
    // rays make up the spot matters. The +4.5° ray passes the stop's upper edge with 2 nm to spare;
    // a ±δ of 1e-5 mm would lose it on one side. M must match a stop that clears it comfortably.
    const upper = 50 * Math.tan((4.5 * Math.PI) / 180);
    const lower = -4.1; // between the −4.5° and −5° rays
    const stopWithMargin = (margin: number) =>
      aperture({ z: 50, decentreMm: (upper + margin + lower) / 2, diameterMm: upper + margin - lower });
    const mAt = (margin: number) => only(setup([point()], [stopWithMargin(margin), singlet(), screen(300)]), 'p')[0]!.value!;
    const reference = mAt(0.01);
    expect(Math.abs(mAt(2e-6) - reference)).toBeLessThan(1e-6 * Math.abs(reference));
    expect(Math.abs(mAt(-0.01) - reference)).toBeGreaterThan(1e-4 * Math.abs(reference)); // dropping the ray does matter
  });

  test('collimated beam through a telescope gives −f₂/f₁ after it and a positive fraction before the focus', () => {
    const s = setup([collimated({ widthMm: 4, rayCount: 5 })], [...relay, screen(60, 'before'), screen(500, 'after')]);
    expect(only(s, 'c', 'before')[0]!.value).toBeCloseTo(0.8, 9);
    expect(only(s, 'c', 'after')[0]!.value).toBeCloseTo(-3, 9);
  });

  test('collimated beam: blocked edge ray, no width and no rays give no number', () => {
    expect(only(setup([collimated({ widthMm: 4, rayCount: 5 })], [aperture({ z: 10, diameterMm: 3 }), screen(100)]), 'c')[0])
      .toEqual({ wavelengthNm: 780, value: null, reason: 'edge-ray-blocked' });
    expect(only(setup([collimated({ widthMm: 0 })], [screen(100)]), 'c')[0]).toMatchObject({ value: null, reason: 'undefined' });
    expect(only(setup([collimated({ rayCount: 1 })], [screen(100)]), 'c')[0]).toMatchObject({ value: null, reason: 'undefined' });
    const away = aperture({ z: 10, decentreMm: 100, diameterMm: 1 });
    expect(only(setup([collimated()], [away, screen(100)]), 'c')[0]).toMatchObject({ value: null, reason: 'no-rays' });
  });

  test('Gaussian beam from the front focal plane of a telescope to the back one is magnified by |f₂/f₁|', () => {
    const g: GaussianSource = {
      kind: 'gaussian', id: 'g', label: 'G', z: 0, y: 0, wavelengthsNm: [780], angleDeg: 0, waistRadiusMm: 0.5, waistZ: 0, m2: 1,
    };
    expect(only(setup([g], [...relay, screen(400)]), 'g')[0]!.value).toBeCloseTo(3, 9);
    const blocked = aperture({ z: 10, decentreMm: 100, diameterMm: 1 });
    expect(only(setup([g], [blocked, screen(400)]), 'g')[0]).toMatchObject({ value: null, reason: 'no-rays' });
  });

  test('one entry per wavelength, only for screens downstream of the source', () => {
    const s = setup([point({ z: 100, wavelengthsNm: [780, 852] })], [screen(50, 'up'), ideal({ z: 300 }), screen(500, 'down')]);
    const result = screenMagnifications(s, 'p');
    expect([...result.keys()]).toEqual(['down']);
    expect(result.get('down')!.map((m) => m.wavelengthNm)).toEqual([780, 852]);
    expect(result.get('down')![0]!.value).toBeCloseTo(-1, 7);
  });
});

describe('lensFocalDistances', () => {
  test('a plano-convex singlet: front and back distances swap when it is flipped', () => {
    const n = refractiveIndex(bk7, 780);
    const f = 51.5 / (n - 1);
    const [curvedFirst] = lensFocalDistances(singlet(), [780], {});
    expect(curvedFirst!.eflMm).toBeCloseTo(f, 9);
    expect(curvedFirst!.frontMm).toBeCloseTo(f, 9);
    expect(curvedFirst!.backMm).toBeCloseTo(f - 3.6 / n, 9);
    const [flatFirst] = lensFocalDistances({ ...singlet(), flipped: true }, [780], {});
    expect(flatFirst!.frontMm).toBeCloseTo(f - 3.6 / n, 9);
    expect(flatFirst!.backMm).toBeCloseTo(f, 9);
    // Spherical aberration pulls the full-aperture focus in towards the lens.
    expect(curvedFirst!.backBestMm!).toBeLessThan(curvedFirst!.backMm);
    expect(curvedFirst!.frontBestMm).toBeCloseTo(flatFirst!.backBestMm!, 9);
  });

  test('the modelled AHL15-12 asphere has the working distances of the lab note', () => {
    const s = parseSetup(rbImaging);
    const asphere = s.optics.find((o): o is CatalogueLens => o.kind === 'lens' && o.label === 'Asphere')!;
    const [r606, r780, r852] = lensFocalDistances(asphere, [606, 780, 852], s.glasses);
    expect(r606!.frontMm).toBeCloseTo(8.87, 3);
    expect(r780!.frontMm).toBeCloseTo(9.0, 3);
    expect(r852!.frontMm).toBeCloseTo(9.036, 3);
    expect(r780!.eflMm).toBeCloseTo(12, 3);
    // Corrected for 780 nm over the whole aperture; at 852 nm the edge focuses further out.
    expect(r780!.frontBestMm!).toBeCloseTo(r780!.frontMm, 3);
    expect(r852!.frontBestMm!).toBeGreaterThan(r852!.frontMm + 1e-3);
  });

  test('an unknown glass gives no distances', () => {
    const lens = singlet();
    const unknown = { ...lens, prescription: { ...lens.prescription, surfaces: [surf(1 / 51.5, 3.6, 'NO-SUCH-GLASS'), surf(0, 0, null)] } };
    expect(lensFocalDistances(unknown, [780, 852], {})).toEqual([null, null]);
  });
});
