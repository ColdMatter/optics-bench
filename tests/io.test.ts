import { describe, expect, test } from 'vitest';
import { newId, parseSetup, serialiseSetup, SetupFormatError } from '../src/engine/io';
import type { Setup } from '../src/engine/types';

const makeSurfaces = () => [
  { curvature: 0.01, conic: 0, asphere: [], semiDiameterMm: 12.7, thicknessToNextMm: 4, glassAfter: 'N-BK7' },
  { curvature: -0.005, conic: -1, asphere: [1e-7, 2e-10], semiDiameterMm: 12.7, thicknessToNextMm: 0, glassAfter: null },
];
const makePrescription = () => ({
  partNumber: 'LA1234',
  vendor: 'Acme',
  source: 'drawing' as const,
  sourceRef: 'p.12',
  surfaces: makeSurfaces(),
});

function fullSetup(): Setup {
  return {
    version: 1,
    sources: [
      { kind: 'point', id: 's1', label: 'P', z: 0, y: 0, wavelengthsNm: [532, 780], coneHalfAngleDeg: 'fill', rayCount: 11 },
      { kind: 'point', id: 's2', label: 'P2', z: 0, y: 1, wavelengthsNm: [532], coneHalfAngleDeg: 5, rayCount: 5 },
      { kind: 'collimated', id: 's3', label: 'C', z: 0, y: 0, wavelengthsNm: [633], widthMm: 4, angleDeg: 0.5, rayCount: 9 },
      { kind: 'gaussian', id: 's4', label: 'G', z: 0, y: 0, wavelengthsNm: [1064], angleDeg: 0, waistRadiusMm: 0.5, waistZ: 10, m2: 1.1 },
    ],
    optics: [
      { kind: 'lens', id: 'o1', label: 'L', z: 50, decentreMm: 0, tiltDeg: 0, prescription: makePrescription(), flipped: true },
      { kind: 'ideal', id: 'o2', label: 'I', z: 100, decentreMm: 0.1, tiltDeg: 1, focalLengthMm: 200, apertureMm: 25 },
      {
        kind: 'slm', id: 'o3', label: 'S', z: 150, decentreMm: 0, tiltDeg: 0, apertureMm: 10, pixelPitchUm: 8, designWavelengthNm: 780,
        phase: [
          { kind: 'fresnel', focalLengthMm: 500 },
          { kind: 'blaze', angleDeg: 0.2 },
          { kind: 'polynomial', coefficientsRad: [1, 0.5] },
          { kind: 'table', yMm: [-1, 0, 1], phaseRad: [0, 1, 0] },
        ],
      },
      { kind: 'aperture', id: 'o4', label: 'A', z: 160, decentreMm: 0, diameterMm: 3 },
      { kind: 'screen', id: 'o5', label: 'Scr', z: 300 },
    ],
    glasses: {
      'N-BK7': { name: 'N-BK7', formula: 2, coefficients: [0, 1.03, 0.006, 0.23, 0.02, 1.01, 103.5], rangeUm: [0.3, 2.5] },
      Const: { name: 'Const', formula: 'constant', coefficients: [1.5], rangeUm: [0.4, 0.8] },
    },
  };
}

function mutated(edit: (s: any) => void): string {
  const s = fullSetup();
  edit(s);
  return JSON.stringify(s);
}

function rejection(text: string): string {
  try {
    parseSetup(text);
  } catch (e) {
    expect(e).toBeInstanceOf(SetupFormatError);
    return (e as Error).message;
  }
  throw new Error('expected parseSetup to throw');
}

describe('round trip', () => {
  test('every source and optic kind, a glass and a prescription survive', () => {
    const setup = fullSetup();
    expect(parseSetup(serialiseSetup(setup))).toEqual(setup);
  });
  test('output is pretty-printed', () => {
    expect(serialiseSetup(fullSetup())).toContain('\n  "sources"');
  });
});

describe('measurements', () => {
  const measured = (): Setup => ({ ...fullSetup(), measurements: [{ id: 'm1', a: 'o1', b: 's2' }] });

  test('round trip, written as version 2', () => {
    const text = serialiseSetup(measured());
    expect(JSON.parse(text).version).toBe(2);
    expect(parseSetup(text)).toEqual(measured());
  });

  test('a setup without them is still written as version 1, with no measurements field', () => {
    const parsed = JSON.parse(serialiseSetup({ ...fullSetup(), measurements: [] }));
    expect(parsed.version).toBe(1);
    expect(parsed).not.toHaveProperty('measurements');
  });

  test('a version 2 file without them reads', () => {
    expect(parseSetup(mutated((s) => (s.version = 2)))).toEqual(fullSetup());
  });
});

describe('parseSetup rejects', () => {
  test('invalid JSON', () => expect(rejection('{nope')).toMatch(/not valid JSON/));
  test('a newer version', () => expect(rejection(mutated((s) => (s.version = 3)))).toMatch(/version.*newer version/));
  test('a measurement to a missing element', () =>
    expect(rejection(mutated((s) => (s.measurements = [{ id: 'm1', a: 'o1', b: 'nope' }])))).toBe(
      'measurements[0].b: no source or optic has id "nope"',
    ));
  test('a measurement from an element to itself', () =>
    expect(rejection(mutated((s) => (s.measurements = [{ id: 'm1', a: 'o1', b: 'o1' }])))).toMatch(/^measurements\[0\]\.b: /));
  test('a measurement id that clashes with an element', () =>
    expect(rejection(mutated((s) => (s.measurements = [{ id: 'o2', a: 'o1', b: 'o3' }])))).toMatch(
      /^measurements\[0\]\.id: duplicate id "o2"/,
    ));
  test('missing sources', () => expect(rejection(mutated((s) => delete s.sources))).toMatch(/^sources: /));
  test('unknown optic kind', () =>
    expect(rejection(mutated((s) => (s.optics[1].kind = 'mirror')))).toMatch(/^optics\[1\]\.kind: .*mirror/));
  test('zero focal length', () =>
    expect(rejection(mutated((s) => (s.optics[1].focalLengthMm = 0)))).toBe('optics[1].focalLengthMm: expected a non-zero number'));
  test('negative aperture', () =>
    expect(rejection(mutated((s) => (s.optics[1].apertureMm = -1)))).toMatch(/^optics\[1\]\.apertureMm: /));
  test('empty wavelengths', () =>
    expect(rejection(mutated((s) => (s.sources[0].wavelengthsNm = [])))).toMatch(/^sources\[0\]\.wavelengthsNm: /));
  test('duplicate ids across sources and optics', () =>
    expect(rejection(mutated((s) => (s.optics[2].id = 's3')))).toMatch(/^optics\[2\]\.id: duplicate id "s3"/));
  test('non-finite numbers', () =>
    expect(rejection(JSON.stringify(fullSetup()).replace('"z":50', '"z":1e999'))).toMatch(/^optics\[0\]\.z: .*finite/));
  test('a non-integer ray count', () =>
    expect(rejection(mutated((s) => (s.sources[0].rayCount = 2.5)))).toMatch(/^sources\[0\]\.rayCount: /));
  test('a cone half-angle of 90', () =>
    expect(rejection(mutated((s) => (s.sources[1].coneHalfAngleDeg = 90)))).toMatch(/^sources\[1\]\.coneHalfAngleDeg: /));
  test('m2 below 1', () => expect(rejection(mutated((s) => (s.sources[3].m2 = 0.9)))).toMatch(/^sources\[3\]\.m2: /));
  test('a tilt of 90 degrees', () =>
    expect(rejection(mutated((s) => (s.optics[0].tiltDeg = 90)))).toMatch(/^optics\[0\]\.tiltDeg: /));
  test('a table with non-increasing y', () =>
    expect(rejection(mutated((s) => (s.optics[2].phase[3].yMm = [0, 0, 1])))).toMatch(
      /^optics\[2\]\.phase\[3\]\.yMm: .*increasing/,
    ));
  test('a table with mismatched lengths', () =>
    expect(rejection(mutated((s) => (s.optics[2].phase[3].phaseRad = [0, 1])))).toMatch(/^optics\[2\]\.phase\[3\]\.phaseRad: /));
  test('a fresnel term with zero focal length', () =>
    expect(rejection(mutated((s) => (s.optics[2].phase[0].focalLengthMm = 0)))).toMatch(/^optics\[2\]\.phase\[0\]\.focalLengthMm: /));
  test('a prescription with one surface', () =>
    expect(rejection(mutated((s) => s.optics[0].prescription.surfaces.pop()))).toMatch(/^optics\[0\]\.prescription\.surfaces: /));
  test('a last surface with glass after it', () =>
    expect(rejection(mutated((s) => (s.optics[0].prescription.surfaces[1].glassAfter = 'N-BK7')))).toMatch(
      /^optics\[0\]\.prescription\.surfaces\[1\]\.glassAfter: /,
    ));
  test('a negative thickness', () =>
    expect(rejection(mutated((s) => (s.optics[0].prescription.surfaces[0].thicknessToNextMm = -1)))).toMatch(
      /surfaces\[0\]\.thicknessToNextMm: /,
    ));
  test('an unknown prescription source', () =>
    expect(rejection(mutated((s) => (s.optics[0].prescription.source = 'web')))).toMatch(/prescription\.source: /));
  test('an empty part number', () =>
    expect(rejection(mutated((s) => (s.optics[0].prescription.partNumber = '')))).toMatch(/prescription\.partNumber: /));
  test('a bad glass formula', () =>
    expect(rejection(mutated((s) => (s.glasses['N-BK7'].formula = 4)))).toMatch(/^glasses\["N-BK7"\]\.formula: /));
  test('glass coefficients empty', () =>
    expect(rejection(mutated((s) => (s.glasses.Const.coefficients = [])))).toMatch(/^glasses\["Const"\]\.coefficients: /));
  test('a glass range of the wrong length', () =>
    expect(rejection(mutated((s) => (s.glasses.Const.rangeUm = [1])))).toMatch(/^glasses\["Const"\]\.rangeUm: /));
  test('a non-object document', () => expect(rejection('[]')).toMatch(/expected an object/));
});

describe('ideal lens', () => {
  test('may have a negative focal length', () => {
    const text = mutated((s) => (s.optics[1].focalLengthMm = -50));
    expect((parseSetup(text).optics[1] as { focalLengthMm: number }).focalLengthMm).toBe(-50);
  });
});

describe('newId', () => {
  test('returns distinct non-empty strings', () => {
    const ids = new Set(Array.from({ length: 50 }, newId));
    expect(ids.size).toBe(50);
    expect([...ids].every((id) => typeof id === 'string' && id.length > 0 && id.length <= 12)).toBe(true);
  });
});
