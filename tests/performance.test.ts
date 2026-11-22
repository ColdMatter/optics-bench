import { expect, test } from 'vitest';
import { traceSetup } from '../src/engine/trace';
import type { Optic, PrescriptionSurface, Source } from '../src/engine/types';

const surf = (curvature: number, thicknessToNextMm: number, glassAfter: string | null): PrescriptionSurface => ({
  curvature, conic: 0, asphere: [], semiDiameterMm: 20, thicknessToNextMm, glassAfter,
});
const achromat = {
  partNumber: 't', vendor: 't', source: 'drawing' as const, sourceRef: 't',
  surfaces: [surf(1 / 30, 6, 'N-BK7'), surf(-1 / 25, 2, 'N-SF5'), surf(-1 / 80, 0, null)],
};

test('trace performance', () => {
  const optics: Optic[] = Array.from({ length: 6 }, (_, i) => ({
    kind: 'lens', id: `l${i}`, label: `L${i}`, z: i * 40, decentreMm: 0, tiltDeg: 0, flipped: i % 2 === 1, prescription: achromat,
  }));
  const sources: Source[] = [0, 1, 2].map((i) => ({
    kind: 'point', id: `s${i}`, label: `S${i}`, z: -50, y: i - 1, wavelengthsNm: [650, 780, 1064], coneHalfAngleDeg: 1, rayCount: 31,
  }));
  const s = { version: 1 as const, sources, optics, glasses: {} };
  traceSetup(s);
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    traceSetup(s);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  expect(times[10]!).toBeLessThan(8);
});
