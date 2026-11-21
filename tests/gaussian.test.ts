import { describe, expect, test } from 'vitest';
import { makeGlassLookup } from '../src/engine/glass';
import { radiusAt, traceGaussian, traceGaussians } from '../src/engine/gaussian';
import { launchRays, traceRay } from '../src/engine/trace';
import type { GaussianSource, IdealLens, Setup } from '../src/engine/types';

const glasses = makeGlassLookup();
const source = (over: Partial<GaussianSource> = {}): GaussianSource => ({
  kind: 'gaussian', id: 'g', label: 'G', z: 0, y: 0, wavelengthsNm: [1000], angleDeg: 0,
  waistRadiusMm: 1, waistZ: 0, m2: 1, ...over,
});
const ideal = (over: Partial<IdealLens> = {}): IdealLens => ({
  kind: 'ideal', id: 'i', label: 'I', z: 0, decentreMm: 0, tiltDeg: 0, focalLengthMm: 100, apertureMm: 50, ...over,
});
const relErr = (a: number, b: number) => Math.abs(a / b - 1);

describe('gaussian beams', () => {
  test('free-space Gaussian', () => {
    const t = traceGaussian(source(), [], 1000, glasses, 5000);
    expect(radiusAt(t, (Math.PI * 1) / 1e-3)).toBeCloseTo(Math.SQRT2, 6);
    expect(radiusAt(t, 6000)).toBeNull();
    expect(radiusAt(t, -1)).toBeNull();
  });

  test('M² scales divergence', () => {
    const t = traceGaussian(source({ m2: 2 }), [], 1000, glasses, 5000);
    expect(radiusAt(t, 1570.7963)).toBeCloseTo(Math.SQRT2, 6);
  });

  test('thin-lens waist', () => {
    const s = source({ wavelengthsNm: [780], z: -50, waistZ: 0 });
    const lens = ideal({ z: 0 });
    const t = traceGaussian(s, [lens], 780, glasses, 300);
    const zR = (Math.PI * 1) / 780e-6;
    const f = 100;
    const waist = t.waists.find((w) => w.afterOpticId === 'i')!;
    expect(relErr(waist.z, f / (1 + (f / zR) ** 2))).toBeLessThan(1e-9);
    expect(relErr(waist.radiusMm, ((f / zR) / Math.sqrt(1 + (f / zR) ** 2)))).toBeLessThan(1e-9);
  });

  test('collimated waist', () => {
    const big = traceGaussian(source({ waistRadiusMm: 5 }), [], 780, glasses, 100);
    expect(big.waists[0]!.collimated).toBe(true);
    const small = traceGaussian(source({ waistRadiusMm: 1 }), [], 780, glasses, 100);
    expect(small.waists[0]!.collimated).toBe(false);
  });

  test('4f relay', () => {
    const s = source({ z: -50, waistZ: 0 });
    const optics = [ideal({ id: 'a', z: 50, focalLengthMm: 50 }), ideal({ id: 'b', z: 250, focalLengthMm: 150 })];
    // waist at 0 is the front focal plane of lens a (z = 50 - 50)
    const t = traceGaussian(s, optics, 1000, glasses, 600);
    const last = t.waists[t.waists.length - 1]!;
    expect(relErr(last.z, 400)).toBeLessThan(1e-9);
    expect(relErr(last.radiusMm, 3)).toBeLessThan(1e-9);
  });

  test('clipped warning', () => {
    const wide = traceGaussian(source({ waistRadiusMm: 3 }), [ideal({ z: 10, apertureMm: 5 })], 1000, glasses, 100);
    expect(wide.warnings).toContainEqual({ kind: 'clipped', opticId: 'i' });
    const fine = traceGaussian(source({ waistRadiusMm: 1 }), [ideal({ z: 10, apertureMm: 50 })], 1000, glasses, 100);
    expect(fine.warnings).toEqual([]);
  });

  test('tilted warning', () => {
    const at = (tiltDeg: number) => traceGaussian(source(), [ideal({ z: 10, tiltDeg })], 1000, glasses, 100).warnings;
    expect(at(5)).toContainEqual({ kind: 'tilted', opticId: 'i' });
    expect(at(2)).toEqual([]);
  });

  test('decentre steers the envelope', () => {
    const optics = [ideal({ z: 50, decentreMm: 2 })];
    const t = traceGaussian(source(), optics, 1000, glasses, 300);
    const ray = launchRays(source(), optics, 1000)[0]!;
    expect(t.centre.points).toEqual(traceRay(ray, optics, glasses, 300).points);
    const last = t.segments[t.segments.length - 1]!;
    expect(last.centre[1]).toEqual(t.centre.points[t.centre.points.length - 1]);
    expect(last.centre[1]![1]).toBeCloseTo(5, 9);
  });

  test('blocked centre ray stops the trace', () => {
    const t = traceGaussian(source(), [ideal({ z: 10, decentreMm: 100, apertureMm: 5 }), ideal({ id: 'j', z: 60 })], 1000, glasses, 300);
    expect(t.centre.blockedBy).toBe('i');
    expect(t.waists).toHaveLength(1);
    expect(radiusAt(t, 100)).toBeNull();
  });

  test('traceGaussians covers every Gaussian source and wavelength', () => {
    const setup: Setup = {
      version: 1, optics: [], glasses: {},
      sources: [source({ wavelengthsNm: [780, 852] }), { kind: 'point', id: 'p', label: 'P', z: 0, y: 0, wavelengthsNm: [780], coneHalfAngleDeg: 5, rayCount: 3 }],
    };
    expect(traceGaussians(setup, 100).map((t) => t.wavelengthNm)).toEqual([780, 852]);
  });
});

describe('gaussian trace extent and blocking', () => {
  test('optics beyond endZ are ignored', () => {
    const t = traceGaussian(source(), [ideal({ z: 200 })], 1000, glasses, 100);
    expect(t.waists).toHaveLength(1);
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0]!.zEnd).toBe(100);
    expect(radiusAt(t, 150)).toBeNull();
    expect(radiusAt(t, 100)).not.toBeNull();
  });

  test('unknown-glass lens first: envelope reaches the lens', () => {
    const lens = {
      kind: 'lens' as const, id: 'l', label: 'L', z: 30, decentreMm: 0, tiltDeg: 0, flipped: false,
      prescription: {
        partNumber: 't', vendor: 't', source: 'drawing' as const, sourceRef: 't',
        surfaces: [
          { curvature: 0.02, conic: 0, asphere: [], semiDiameterMm: 10, thicknessToNextMm: 3, glassAfter: 'NO-SUCH' },
          { curvature: 0, conic: 0, asphere: [], semiDiameterMm: 10, thicknessToNextMm: 0, glassAfter: null },
        ],
      },
    };
    const t = traceGaussian(source(), [lens], 1000, glasses, 100);
    expect(t.segments.map((s) => [s.zStart, s.zEnd])).toEqual([[0, 30]]);
    expect(radiusAt(t, 10)).not.toBeNull();
    expect(t.centre.points[t.centre.points.length - 1]).toEqual([30, 0]);
  });
});
