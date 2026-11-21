import { describe, expect, test } from 'vitest';
import { intersect, refract, sag } from '../src/engine/surface';
import type { Ray, SurfaceShape } from '../src/engine/types';

const flat: SurfaceShape = { curvature: 0, conic: 0, asphere: [], semiDiameterMm: 12.7 };
const sphere: SurfaceShape = { curvature: 1 / 50, conic: 0, asphere: [], semiDiameterMm: 12.7 };
const degrees = (rad: number) => (rad * 180) / Math.PI;
const rayAt = (angleDeg: number, y = 0, z = 0): Ray => ({
  z,
  y,
  dz: Math.cos((angleDeg * Math.PI) / 180),
  dy: Math.sin((angleDeg * Math.PI) / 180),
  wavelengthNm: 633,
});

describe('sag', () => {
  test('sphere sag', () => expect(sag(sphere, 10)).toBeCloseTo(1.010205, 6));
  test('flat sag is zero', () => expect(sag(flat, 10)).toBe(0));
  test('parabola sag', () =>
    expect(sag({ ...sphere, conic: -1 }, 10)).toBeCloseTo(1.0, 12));
  test('asphere term adds', () =>
    expect(sag({ ...flat, asphere: [1e-5] }, 10)).toBeCloseTo(0.1, 12));
  test('A6 term uses the sixth power', () =>
    expect(sag({ ...flat, asphere: [0, 1e-8] }, 10)).toBeCloseTo(0.01, 12));
});

describe('intersect', () => {
  test('axial ray hits vertex', () => {
    const hit = intersect(sphere, 5, rayAt(0, 0, 0))!;
    expect(hit.z).toBe(5);
    expect(hit.y).toBe(0);
  });
  test('hit lies on the surface', () => {
    const hit = intersect(sphere, 5, rayAt(3, 2, 0))!;
    expect(hit.z - 5).toBeCloseTo(sag(sphere, hit.y), 9);
  });
  test('hit outside semi-diameter → null', () =>
    expect(intersect(sphere, 5, rayAt(0, 13, 0))).toBeNull());
  test('ray missing a steep surface → null', () => {
    const steep = { ...sphere, curvature: 1 / 5, semiDiameterMm: 50 };
    expect(intersect(steep, 5, rayAt(0, 8, 0))).toBeNull();
  });
  test('normal of a flat surface is along the axis', () => {
    const hit = intersect(flat, 0, rayAt(10, 1, -3))!;
    expect(hit.normalY).toBeCloseTo(0, 12);
    expect(Math.abs(hit.normalZ)).toBeCloseTo(1, 12);
  });
});

describe('refract', () => {
  test('Snell at flat face', () => {
    const ray = rayAt(30, 0, -1);
    const hit = intersect(flat, 0, ray)!;
    const out = refract(ray, hit, 1, 1.5)!;
    expect(degrees(Math.atan2(out.dy, out.dz))).toBeCloseTo(Math.asin(0.5 / 1.5) * 57.29577951308232, 5);
    expect(out.dy ** 2 + out.dz ** 2).toBeCloseTo(1, 12);
    expect(out.wavelengthNm).toBe(633);
    expect(out.z).toBe(hit.z);
    expect(out.y).toBe(hit.y);
  });
  test('TIR returns null', () => {
    const ray = rayAt(45, 0, -1);
    const hit = intersect(flat, 0, ray)!;
    expect(refract(ray, hit, 1.5, 1)).toBeNull();
  });
  test('normal incidence on sphere is undeviated', () => {
    // ray aimed at the centre of curvature (0, 50) from a point on the axis side
    const from = { z: -20, y: -4 };
    const len = Math.hypot(50 - from.z, 0 - from.y);
    const ray: Ray = { z: from.z, y: from.y, dz: (50 - from.z) / len, dy: (0 - from.y) / len, wavelengthNm: 589 };
    const hit = intersect(sphere, 0, ray)!;
    const out = refract(ray, hit, 1, 1.5)!;
    expect(out.dz).toBeCloseTo(ray.dz, 9);
    expect(out.dy).toBeCloseTo(ray.dy, 9);
  });
});
