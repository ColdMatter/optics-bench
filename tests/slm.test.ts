import { describe, expect, test } from 'vitest';
import { makeGlassLookup, refractiveIndex } from '../src/engine/glass';
import { lensAbcd } from '../src/engine/lens';
import { opticAbcd } from '../src/engine/optic';
import { slmAbcd, slmPhaseGradient, traceSlm } from '../src/engine/slm';
import { traceRay } from '../src/engine/trace';
import type { CatalogueLens, Optic, PhaseTerm, Ray, Slm } from '../src/engine/types';

const glasses = makeGlassLookup();
const slm = (phase: PhaseTerm[], over: Partial<Slm> = {}): Slm => ({
  kind: 'slm', id: 's', label: 'SLM', z: 0, decentreMm: 0, tiltDeg: 0, apertureMm: 15, pixelPitchUm: 8,
  designWavelengthNm: 780, phase, ...over,
});
const ray = (y: number, wavelengthNm: number): Ray => ({ z: -10, y, dz: 1, dy: 0, wavelengthNm });

describe('slm', () => {
  test('fresnel chromatic focus', () => {
    const s = slm([{ kind: 'fresnel', focalLengthMm: 200 }]);
    const crossings = [0.5, 1, -0.7].map((y) => {
      const path = traceRay(ray(y, 852), [s], glasses, 300);
      const f = path.final!;
      return f.z - f.y / (f.dy / f.dz);
    });
    for (const z of crossings) expect(Math.abs(z - (200 * 780) / 852)).toBeLessThan(0.02);
  });

  test('blaze deflects λ/Λ', () => {
    const s = slm([{ kind: 'blaze', angleDeg: 1 }]);
    const out = traceSlm(s, ray(0, 852)).ray!;
    expect(Math.abs(out.dy - (852 / 780) * Math.sin(Math.PI / 180))).toBeLessThan(1e-9);
  });

  test('table gradient', () => {
    const yMm = [-2, -1, 0, 1, 2];
    const s = slm([{ kind: 'table', yMm, phaseRad: yMm.map((y) => 2 * y * y) }]);
    expect(slmPhaseGradient(s, 1)).toBeCloseTo(4, 6);
    expect(slmPhaseGradient(s, 0.5)).toBeCloseTo(2, 6);
  });

  test('pitch limit blocks', () => {
    const s = slm([{ kind: 'fresnel', focalLengthMm: 5 }]);
    const limit = (780e-6 * 5) / (2 * 8e-3);
    const outer = traceSlm(s, ray(limit * 2, 780));
    expect(outer.ray).toBeNull();
    expect(outer.warnings).toEqual([{ kind: 'slm-pitch-limit', opticId: 's' }]);
    const inner = traceSlm(s, ray(limit / 2, 780));
    expect(inner.ray).not.toBeNull();
    expect(inner.warnings).toEqual([]);
  });

  test('outside the aperture blocks silently', () => {
    const r = traceSlm(slm([{ kind: 'blaze', angleDeg: 1 }]), ray(8, 780));
    expect(r.ray).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  test('ABCD', () => {
    const fresnel = slm([{ kind: 'fresnel', focalLengthMm: 200 }]);
    expect(slmAbcd(fresnel, 1, 852)[2]).toBeCloseTo(-(852 / 780) / 200, 12);
    expect(slmAbcd(slm([{ kind: 'blaze', angleDeg: 1 }]), 1, 852)).toEqual([1, 0, 0, 1]);
  });
});

describe('lens ABCD', () => {
  const planoConvex: CatalogueLens = {
    kind: 'lens', id: 'l', label: 'L', z: 0, decentreMm: 0, tiltDeg: 0, flipped: false,
    prescription: {
      partNumber: 't', vendor: 't', source: 'drawing', sourceRef: 't',
      surfaces: [
        { curvature: 1 / 51.5, conic: 0, asphere: [], semiDiameterMm: 20, thicknessToNextMm: 3.6, glassAfter: 'N-BK7' },
        { curvature: 0, conic: 0, asphere: [], semiDiameterMm: 20, thicknessToNextMm: 0, glassAfter: null },
      ],
    },
  };
  test('thick-lens ABCD', () => {
    const [a, b, c, d] = lensAbcd(planoConvex, 587.56, glasses);
    expect(a * d - b * c).toBeCloseTo(1, 12);
    const n = refractiveIndex(glasses('N-BK7')!, 587.56);
    expect(Math.abs(-1 / c / (51.5 / (n - 1)) - 1)).toBeLessThan(1e-6);
    expect(opticAbcd(planoConvex as Optic, 587.56, 0, glasses)).toEqual([a, b, c, d]);
  });
});
