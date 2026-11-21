import { describe, expect, test } from 'vitest';
import { radiusAt, traceGaussian } from '../src/engine/gaussian';
import { lookupFor, traceSetup } from '../src/engine/trace';
import { solve, type Target } from '../src/engine/solver';
import type { CatalogueLens, GaussianSource, IdealLens, Setup } from '../src/engine/types';

const source: GaussianSource = {
  kind: 'gaussian', id: 'g', label: 'G', z: 0, y: 0, wavelengthsNm: [780], angleDeg: 0,
  waistRadiusMm: 0.5, waistZ: 0, m2: 1,
};
const ideal = (id: string, z: number, focalLengthMm: number): IdealLens => ({
  kind: 'ideal', id, label: id, z, decentreMm: 0, tiltDeg: 0, focalLengthMm, apertureMm: 50,
});
const thick = (id: string, z: number): CatalogueLens => ({
  kind: 'lens', id, label: id, z, decentreMm: 0, tiltDeg: 0, flipped: false,
  prescription: {
    partNumber: 't', vendor: 't', source: 'drawing', sourceRef: 't',
    surfaces: [
      { curvature: 1 / 25.8, conic: 0, asphere: [], semiDiameterMm: 12, thicknessToNextMm: 10, glassAfter: 'N-BK7' },
      { curvature: 0, conic: 0, asphere: [], semiDiameterMm: 12, thicknessToNextMm: 0, glassAfter: null },
    ],
  },
});
const setupOf = (...optics: Setup['optics']): Setup => ({ version: 1, sources: [source], optics, glasses: {} });
const radiusTarget = (z: number, radiusMm: number): Target => ({
  kind: 'radiusAt', sourceId: 'g', wavelengthNm: 780, z, radiusMm,
});
const zOf = (s: Setup, id: string) => s.optics.find((o) => o.id === id)!.z;

describe('lens-position solver', () => {
  test('expands a beam', () => {
    const start = setupOf(ideal('a', 60, 50), ideal('b', 300, 150));
    const result = solve(
      start,
      [radiusTarget(700, 1.5), radiusTarget(1000, 1.5)],
      [{ opticId: 'a', minZ: 20, maxZ: 200 }, { opticId: 'b', minZ: 150, maxZ: 500 }],
    );
    expect(result.cost).toBeLessThan(1e-6);
    expect(result.converged).toBe(true);
    expect(Math.abs(zOf(result.setup, 'b') - zOf(result.setup, 'a') - 200)).toBeLessThan(10);
    expect(zOf(start, 'a')).toBe(60);
  });

  test('respects bounds', () => {
    const result = solve(
      setupOf(ideal('a', 60, 50)),
      [{ kind: 'waistPosition', sourceId: 'g', wavelengthNm: 780, z: 5000 }],
      [{ opticId: 'a', minZ: 20, maxZ: 200 }],
    );
    const z = zOf(result.setup, 'a');
    expect(z).toBeGreaterThanOrEqual(20);
    expect(z).toBeLessThanOrEqual(200);
    expect(result.converged).toBe(false);
  });

  test('solver avoids overlap', () => {
    const embedded = setupOf(thick('a', 100), ideal('b', 105, 60));
    const trace = traceGaussian(source, embedded.optics, 780, lookupFor({}), 600);
    const targets = [200, 300, 400].map((z) => radiusTarget(z, radiusAt(trace, z)!));
    expect(traceSetup(embedded).warnings.some((w) => w.kind === 'overlap')).toBe(true);
    const result = solve(embedded, targets, [{ opticId: 'b', minZ: 90, maxZ: 130 }]);
    expect(traceSetup(result.setup).warnings.filter((w) => w.kind === 'overlap')).toEqual([]);
  });

  test('fast', () => {
    const start = setupOf(ideal('a', 60, 50), ideal('b', 200, 80), ideal('c', 350, 100), ideal('d', 500, 120));
    const t0 = performance.now();
    solve(
      start,
      [radiusTarget(900, 2), { kind: 'collimated', sourceId: 'g', wavelengthNm: 780 }],
      ['a', 'b', 'c', 'd'].map((opticId) => ({ opticId, minZ: 20, maxZ: 800 })),
    );
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  test('is deterministic and validates variables', () => {
    const start = setupOf(ideal('a', 60, 50));
    const run = () => solve(start, [radiusTarget(300, 2)], [{ opticId: 'a', minZ: 20, maxZ: 200 }]);
    expect(run().setup).toEqual(run().setup);
    expect(() => solve(start, [], [{ opticId: 'nope', minZ: 0, maxZ: 1 }])).toThrow('nope');
    expect(() => solve(start, [], [{ opticId: 'a', minZ: 5, maxZ: 1 }])).toThrow();
  });
});
