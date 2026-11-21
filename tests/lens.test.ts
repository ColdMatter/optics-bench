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
