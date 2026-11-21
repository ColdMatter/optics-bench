import { describe, expect, test } from 'vitest';
import { refractiveIndex, makeGlassLookup } from '../src/engine/glass';
import { focusPerWavelength, focusShiftCurve, screenStats } from '../src/engine/focus';
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
