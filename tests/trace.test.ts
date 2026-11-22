import { describe, expect, test } from 'vitest';
import { refractiveIndex, makeGlassLookup } from '../src/engine/glass';
import { interactOptic } from '../src/engine/optic';
import { launchRays, traceRay, traceSetup } from '../src/engine/trace';
import type {
  Aperture,
  CatalogueLens,
  CollimatedSource,
  IdealLens,
  Optic,
  PointSource,
  PrescriptionSurface,
  Ray,
  Setup,
  Source,
} from '../src/engine/types';

const glasses = makeGlassLookup();
const rad = (deg: number) => (deg * Math.PI) / 180;

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
const lens = (surfaces: PrescriptionSurface[], over: Partial<CatalogueLens> = {}): CatalogueLens => ({
  kind: 'lens', id: 'l', label: 'L', z: 100, decentreMm: 0, tiltDeg: 0, flipped: false,
  prescription: { partNumber: 't', vendor: 't', source: 'drawing', sourceRef: 't', surfaces }, ...over,
});
const surf = (curvature: number, thicknessToNextMm: number, glassAfter: string | null): PrescriptionSurface => ({
  curvature, conic: 0, asphere: [], semiDiameterMm: 20, thicknessToNextMm, glassAfter,
});
const setup = (sources: Source[], optics: Optic[]): Setup => ({ version: 1, sources, optics, glasses: {} });
const axialRay = (y: number, wavelengthNm = 780, z = 0): Ray => ({ z, y, dz: 1, dy: 0, wavelengthNm });
const yAt = (r: Ray, z: number) => r.y + ((z - r.z) / r.dz) * r.dy;

describe('ideal lens', () => {
  test('ideal lens images a point perfectly', () => {
    const trace = traceSetup(setup([point({ y: 1 })], [ideal()]), 400);
    const rays = trace.sources[0]!.byWavelength[0]!.rays;
    expect(rays).toHaveLength(21);
    for (const r of rays) {
      expect(r.final).not.toBeNull();
      expect(yAt(r.final!, 400)).toBeCloseTo(-1, 9);
    }
  });

  test('ideal lens uses tangent form', () => {
    const out = interactOptic(ideal({ z: 10 }), axialRay(7), glasses).ray!;
    expect(out.dy / out.dz).toBeCloseTo(-7 / 100, 15);
  });

  test('decentred ideal lens steers', () => {
    const out = interactOptic(ideal({ z: 50, decentreMm: 1 }), axialRay(0), glasses).ray!;
    expect(yAt(out, 150)).toBeCloseTo(1, 12);
  });
});

describe('aperture and blocking', () => {
  test('aperture clips', () => {
    const rays = traceSetup(setup([collimated()], [aperture()])).sources[0]!.byWavelength[0]!.rays;
    const ys = launchRays(collimated(), [], 780).map((r) => r.y);
    rays.forEach((path, i) => {
      expect(path.blockedBy).toBe(Math.abs(ys[i]!) > 2 ? 'a' : null);
    });
    expect(rays.some((r) => r.blockedBy === 'a')).toBe(true);
  });

  test('all rays blocked', () => {
    const s = setup([collimated({ widthMm: 8 })], [aperture({ diameterMm: 0.01, decentreMm: 5 })]);
    const trace = traceSetup(s);
    for (const r of trace.sources[0]!.byWavelength[0]!.rays) {
      expect(r.blockedBy).toBe('a');
      expect(r.final).toBeNull();
    }
  });

  test('unknown glass', () => {
    const l = lens([surf(1 / 50, 3, 'XYZ-1'), surf(0, 0, null)]);
    const trace = traceSetup(setup([collimated({ widthMm: 2 })], [l]));
    for (const r of trace.sources[0]!.byWavelength[0]!.rays) expect(r.blockedBy).toBe('l');
    expect(trace.warnings).toContainEqual({ kind: 'unknown-glass', opticId: 'l', glass: 'XYZ-1' });
  });

  test('screen records a point and never blocks', () => {
    const screen: Optic = { kind: 'screen', id: 's', label: 'S', z: 30 };
    const path = traceRay(axialRay(3), [screen], glasses, 60);
    expect(path.blockedBy).toBeNull();
    expect(path.points).toEqual([[0, 3], [30, 3], [60, 3]]);
  });
});

describe('tilted elements', () => {
  test('tilt is counter-clockwise: the shift is positive for positive tilt, negative for negative', () => {
    const plate = (tiltDeg: number) =>
      interactOptic(lens([surf(0, 10, 'N-BK7'), surf(0, 0, null)], { tiltDeg }), axialRay(0, 780, 50), glasses).ray!;
    expect(plate(10).y).toBeGreaterThan(0);
    expect(plate(-10).y).toBeCloseTo(-plate(10).y, 12);
  });

  test('tilted and decentred ideal lens', () => {
    const d = 2;
    const phi = rad(15);
    const f = 100;
    const out = interactOptic(ideal({ z: 50, decentreMm: d, tiltDeg: 15, focalLengthMm: f }), axialRay(0, 780, 0), glasses).ray!;
    const hitZ = 50 + d * Math.tan(phi);
    const localTan = -Math.tan(phi) + d / (f * Math.cos(phi));
    expect(out.z).toBeCloseTo(hitZ, 12);
    expect(out.y).toBeCloseTo(0, 12);
    expect(out.dy / out.dz).toBeCloseTo(Math.tan(Math.atan(localTan) + phi), 12);
  });
});

describe('thick lenses', () => {
  const index = (nm: number) => refractiveIndex(glasses('N-BK7')!, nm);

  test.each([587.56, 1064])('plano-convex focal length at %d nm', (nm) => {
    const l = lens([surf(1 / 51.5, 3.6, 'N-BK7'), surf(0, 0, null)]);
    const out = interactOptic(l, axialRay(0.01, nm, 0), glasses).ray!;
    const n = index(nm);
    const crossing = out.z + (-out.y / out.dy) * out.dz - (100 + 3.6);
    expect(crossing).toBeCloseTo(51.5 / (n - 1) - 3.6 / n, 4);
  });

  test('tilted flat plate shifts but does not deviate', () => {
    const l = lens([surf(0, 10, 'N-BK7'), surf(0, 0, null)], { tiltDeg: 10 });
    const out = interactOptic(l, axialRay(0, 780, 50), glasses).ray!;
    const n = index(780);
    const theta = rad(10);
    const shift = 10 * Math.sin(theta) * (1 - Math.cos(theta) / Math.sqrt(n * n - Math.sin(theta) ** 2));
    expect(out.dy).toBeCloseTo(0, 12);
    expect(out.dz).toBeCloseTo(1, 12);
    expect(out.y).toBeCloseTo(shift, 9);
  });

  test('a ray that misses a lens surface is blocked by that lens', () => {
    const l = lens([surf(1 / 50, 3, 'N-BK7'), surf(0, 0, null)]);
    expect(interactOptic(l, axialRay(25), glasses).ray).toBeNull();
  });

  test('extrapolated glass is reported once per wavelength', () => {
    const l = lens([surf(1 / 50, 3, 'N-BK7'), surf(0, 0, null)]);
    const trace = traceSetup(setup([collimated({ widthMm: 4, wavelengthsNm: [5000] })], [l]));
    const extrapolated = trace.warnings.filter((w) => w.kind === 'glass-extrapolated');
    expect(extrapolated).toEqual([{ kind: 'glass-extrapolated', glass: 'N-BK7', wavelengthNm: 5000 }]);
  });
});

describe('layout', () => {
  test('empty setups still get a finite end plane', () => {
    expect(traceSetup(setup([], [])).endZ).toBe(100);
    expect(traceSetup(setup([point({ z: 20 })], [])).endZ).toBe(120);
  });

  test('overlap warning', () => {
    const a = lens([surf(0, 10, 'N-BK7'), surf(0, 0, null)], { id: 'a', z: 100 });
    const b = lens([surf(0, 10, 'N-BK7'), surf(0, 0, null)], { id: 'b', z: 105 });
    const overlaps = traceSetup(setup([collimated()], [b, a])).warnings.filter((w) => w.kind === 'overlap');
    expect(overlaps).toEqual([{ kind: 'overlap', ids: ['a', 'b'] }]);
  });

  test('a thin element inside a lens body overlaps; one at its face does not', () => {
    const body = lens([surf(0, 10, 'N-BK7'), surf(0, 0, null)], { z: 100 });
    const inside = traceSetup(setup([], [body, aperture({ id: 'in', z: 105 })])).warnings;
    const atFace = traceSetup(setup([], [body, aperture({ id: 'face', z: 110 })])).warnings;
    expect(inside).toEqual([{ kind: 'overlap', ids: ['l', 'in'] }]);
    expect(atFace).toEqual([]);
  });

  test('optics behind the source are skipped', () => {
    const behind = aperture({ z: -10, diameterMm: 0.001 });
    const path = traceSetup(setup([collimated({ rayCount: 1 })], [behind])).sources[0]!.byWavelength[0]!.rays[0]!;
    expect(path.blockedBy).toBeNull();
  });

  test('optics are traced in z order whatever the array order', () => {
    const late = aperture({ id: 'late', z: 80, diameterMm: 100 });
    const early = aperture({ id: 'early', z: 20, diameterMm: 0.1 });
    const path = traceSetup(setup([collimated({ rayCount: 1, y: 5 })], [late, early])).sources[0]!.byWavelength[0]!.rays[0]!;
    expect(path.blockedBy).toBe('early');
  });

  test('default end plane lies beyond the last optic', () => {
    const trace = traceSetup(setup([point()], [ideal()]));
    expect(trace.endZ).toBeCloseTo(200 + 60, 9);
  });
});

describe('sources', () => {
  test('point source fill aims at the first optic aperture edges', () => {
    const rays = launchRays(point({ coneHalfAngleDeg: 'fill', y: 1 }), [ideal({ z: 80, apertureMm: 20, decentreMm: 2 })], 780);
    const angle = (r: Ray) => Math.atan2(r.dy, r.dz);
    expect(angle(rays[0]!)).toBeCloseTo(Math.atan2(-8 - 1, 80), 9);
    expect(angle(rays[rays.length - 1]!)).toBeCloseTo(Math.atan2(12 - 1, 80), 9);
  });

  test('fill falls back to ±5° without a lens-like optic', () => {
    const rays = launchRays(point({ coneHalfAngleDeg: 'fill' }), [], 780);
    expect(Math.atan2(rays[0]!.dy, rays[0]!.dz)).toBeCloseTo(-rad(5), 12);
  });

  test('collimated rays are perpendicular to the beam and centred', () => {
    const rays = launchRays(collimated({ angleDeg: 30, rayCount: 3 }), [], 780);
    const mid = rays[1]!;
    expect([mid.z, mid.y]).toEqual([0, 0]);
    const across = [rays[2]!.z - rays[0]!.z, rays[2]!.y - rays[0]!.y];
    expect(across[0]! * mid.dz + across[1]! * mid.dy).toBeCloseTo(0, 12);
    expect(Math.hypot(across[0]!, across[1]!)).toBeCloseTo(10, 12);
  });

  test('a single collimated ray is the central ray', () => {
    const [r] = launchRays(collimated({ rayCount: 1, y: 2 }), [], 780);
    expect([r!.z, r!.y]).toEqual([0, 2]);
  });

  test('gaussian source launches its centre ray', () => {
    const rays = launchRays(
      { kind: 'gaussian', id: 'g', label: 'G', z: 0, y: 1, wavelengthsNm: [780], angleDeg: 0, waistRadiusMm: 1, waistZ: 0, m2: 1 },
      [], 780);
    expect(rays).toHaveLength(1);
    expect(rays[0]).toMatchObject({ y: 1, dz: 1, dy: 0 });
  });
});

const achromat = {
  partNumber: 't', vendor: 't', source: 'drawing' as const, sourceRef: 't',
  surfaces: [surf(1 / 30, 6, 'N-BK7'), surf(-1 / 25, 2, 'N-SF5'), surf(-1 / 80, 0, null)],
};

describe('achromat extrapolation', () => {
  test('both glasses are reported when the wavelength is outside their ranges', () => {
    const l = lens(achromat.surfaces);
    const trace = traceSetup(setup([collimated({ widthMm: 1, rayCount: 3, wavelengthsNm: [5000] })], [l]));
    const names = trace.warnings.filter((w) => w.kind === 'glass-extrapolated').map((w) => (w as { glass: string }).glass);
    expect(names.sort()).toEqual(['N-BK7', 'N-SF5']);
  });
});
