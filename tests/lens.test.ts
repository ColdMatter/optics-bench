import { describe, expect, test } from 'vitest';
import { sag } from '../src/engine/surface';
import { flipPrescription, lensThickness } from '../src/engine/lens';
import type { LensPrescription, PrescriptionSurface } from '../src/engine/types';

const surface = (curvature: number, thicknessToNextMm: number, glassAfter: string | null): PrescriptionSurface => ({
  curvature,
  conic: 0,
  asphere: [],
  semiDiameterMm: 12.7,
  thicknessToNextMm,
  glassAfter,
});

export const achromat: LensPrescription = {
  partNumber: 'TEST-ACH',
  vendor: 'test',
  source: 'drawing',
  sourceRef: 'test',
  surfaces: [
    { ...surface(1 / 30, 6, 'N-BK7'), asphere: [1e-7] },
    surface(-1 / 25, 2, 'N-SF5'),
    surface(-1 / 80, 0, null),
  ],
};

describe('lens prescriptions', () => {
  test('thickness sums the gaps', () => expect(lensThickness(achromat)).toBe(8));

  test('flip reverses order and signs', () => {
    const flipped = flipPrescription(achromat);
    expect(flipped.surfaces.map((s) => s.curvature)).toEqual([1 / 80, 1 / 25, -1 / 30]);
    expect(flipped.surfaces.map((s) => s.thicknessToNextMm)).toEqual([2, 6, 0]);
    expect(flipped.surfaces.map((s) => s.glassAfter)).toEqual(['N-SF5', 'N-BK7', null]);
    expect(flipped.surfaces[2]!.asphere).toEqual([-1e-7]);
    expect(lensThickness(flipped)).toBe(lensThickness(achromat));
  });

  test('flipping twice returns the original', () => {
    expect(flipPrescription(flipPrescription(achromat))).toEqual(achromat);
  });

  test('flipping mirrors the whole sag, aspheric terms included', () => {
    const original = { ...surface(1 / 30, 0, null), conic: -0.5, asphere: [1e-5, 2e-8] };
    const flipped = flipPrescription({ ...achromat, surfaces: [original] }).surfaces[0]!;
    expect(sag(original, 10)).toBeGreaterThan(1.8);
    for (const y of [3, 10]) expect(sag(flipped, y)).toBeCloseTo(-sag(original, y), 12);
  });
});

describe('blocked rays end at the element', () => {
  const mk = (glass: string, curvature: number, semi: number) => ({
    kind: 'lens' as const, id: 'l', label: 'L', z: 30, decentreMm: 0, tiltDeg: 0, flipped: false,
    prescription: {
      partNumber: 't', vendor: 't', source: 'drawing' as const, sourceRef: 't',
      surfaces: [
        { curvature, conic: 0, asphere: [], semiDiameterMm: semi, thicknessToNextMm: 3, glassAfter: glass },
        { curvature: 0, conic: 0, asphere: [], semiDiameterMm: semi, thicknessToNextMm: 0, glassAfter: null },
      ],
    },
  });
  const ray = { z: 0, y: 5, dz: 1, dy: 0, wavelengthNm: 780 };
  test('unknown glass', async () => {
    const { traceLens } = await import('../src/engine/lens');
    const r = traceLens(mk('NO-SUCH', 0.02, 10), ray, () => undefined);
    expect(r.ray).toBeNull();
    expect(r.points).toEqual([[30, 5]]);
  });
  test('first-surface miss', async () => {
    const { traceLens } = await import('../src/engine/lens');
    const { makeGlassLookup } = await import('../src/engine/glass');
    const r = traceLens(mk('N-BK7', 0.2, 2), ray, makeGlassLookup());
    expect(r.ray).toBeNull();
    expect(r.points).toEqual([[30, 5]]);
  });
});
