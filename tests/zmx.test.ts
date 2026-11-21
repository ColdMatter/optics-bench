/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest';
import { decodeZmx, parseZmx, ZmxError } from '../src/engine/zmx';
import fixtureText from './fixtures/AC254-100-B.zmx?raw';

// The Thorlabs file is plain ASCII, so these are its bytes.
const fixtureBytes = new TextEncoder().encode(fixtureText);

function utf16leWithBom(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    bytes[2 + 2 * i] = text.charCodeAt(i) & 0xff;
    bytes[3 + 2 * i] = text.charCodeAt(i) >> 8;
  }
  return bytes;
}

const synthetic = (units: string, surfaces: string) =>
  [
    'VERS 120928 0 30222',
    'MODE SEQ',
    'NAME TEST-1 synthetic',
    `UNIT ${units} X W X CM MR CPMM`,
    'SURF 0',
    '  TYPE STANDARD',
    '  CURV 0.0 0 0 0 0 ""',
    '  DISZ INFINITY',
    surfaces,
    'SURF 9',
    '  TYPE STANDARD',
    '  CURV 0.0 0 0 0 0 ""',
    '  DISZ 0',
  ].join('\r\n');

const singletSurfaces = (first: string) =>
  [
    'SURF 1',
    first,
    '  DISZ 0.2',
    '  GLAS N-BK7 0 0 0 0 0 0 0 0 0 0',
    '  DIAM 0.5 1 0 0 1 ""',
    'SURF 2',
    '  TYPE STANDARD',
    '  CURV -0.05 0 0 0 0 ""',
    '  DISZ 4.0',
    '  DIAM 0.5 1 0 0 1 ""',
  ].join('\r\n');

const standardFirst = '  TYPE STANDARD\r\n  CURV 0.1 0 0 0 0 ""\r\n  CONI -0.5';

function expectZmxError(text: string, message: RegExp) {
  expect(() => parseZmx(text)).toThrow(ZmxError);
  expect(() => parseZmx(text)).toThrow(message);
}

describe('zmx parser', () => {
  test('parses a Thorlabs achromat', () => {
    const lens = parseZmx(decodeZmx(fixtureBytes), 'Thorlabs');
    expect(lens.partNumber).toBe('AC254-100-B');
    expect(lens.vendor).toBe('Thorlabs');
    expect(lens.source).toBe('zmx');
    expect(lens.surfaces).toHaveLength(3);
    const [s1, s2, s3] = lens.surfaces;
    expect(s1!.curvature).toBeCloseTo(1.499700059988e-2, 15);
    expect(s2!.curvature).toBeCloseTo(-1.86219739292365e-2, 15);
    expect(s3!.curvature).toBeCloseTo(-3.8549015072665001e-3, 15);
    expect(lens.surfaces.map((s) => s.thicknessToNextMm)).toEqual([4.0, 1.5, 0]);
    expect(lens.surfaces.map((s) => s.glassAfter)).toEqual(['N-LAK22', 'N-SF6HT', null]);
    expect(lens.surfaces.map((s) => s.semiDiameterMm)).toEqual([12.7, 12.7, 12.7]);
    expect(lens.surfaces.every((s) => s.conic === 0 && s.asphere.length === 0)).toBe(true);
  });

  test('records the file name as sourceRef', () => {
    expect(parseZmx(decodeZmx(fixtureBytes), 'Thorlabs', 'AC254-100-B.zmx').sourceRef).toBe('AC254-100-B.zmx');
  });

  test('UTF-16 decode', () => {
    const text = decodeZmx(fixtureBytes);
    const decoded = decodeZmx(utf16leWithBom(text));
    expect(decoded).toBe(text);
    expect(parseZmx(decoded, 'Thorlabs')).toEqual(parseZmx(text, 'Thorlabs'));
  });

  test('inch units converted', () => {
    const mm = parseZmx(synthetic('MM', singletSurfaces(standardFirst)));
    const inch = parseZmx(synthetic('IN', singletSurfaces(standardFirst)));
    inch.surfaces.forEach((s, i) => {
      const m = mm.surfaces[i]!;
      expect(s.curvature).toBeCloseTo(m.curvature / 25.4, 15);
      expect(s.thicknessToNextMm).toBeCloseTo(m.thicknessToNextMm * 25.4, 12);
      expect(s.semiDiameterMm).toBeCloseTo(m.semiDiameterMm * 25.4, 12);
      expect(s.conic).toBe(m.conic);
    });
    expect(inch.surfaces[0]!.thicknessToNextMm).toBeCloseTo(5.08, 12);
  });

  test('a singlet keeps its conic and ends in air', () => {
    const lens = parseZmx(synthetic('MM', singletSurfaces(standardFirst)));
    expect(lens.partNumber).toBe('TEST-1');
    expect(lens.surfaces).toHaveLength(2);
    expect(lens.surfaces[0]!.conic).toBe(-0.5);
    expect(lens.surfaces[1]).toMatchObject({ curvature: -0.05, thicknessToNextMm: 0, glassAfter: null });
  });

  test('even asphere', () => {
    const asphere = '  TYPE EVENASPH\r\n  CURV 0.1 0 0 0 0 ""\r\n  PARM 1 0\r\n  PARM 2 -1.5E-4\r\n  PARM 3 2.0E-6';
    const lens = parseZmx(synthetic('MM', singletSurfaces(asphere)));
    expect(lens.surfaces[0]!.asphere).toEqual([-1.5e-4, 2.0e-6]);
    expect(lens.surfaces[1]!.asphere).toEqual([]);
  });

  test('even asphere in inches scales each order', () => {
    const asphere = '  TYPE EVENASPH\r\n  CURV 0.1 0 0 0 0 ""\r\n  PARM 2 -1.5E-4\r\n  PARM 3 2.0E-6';
    const [a4, a6] = parseZmx(synthetic('IN', singletSurfaces(asphere))).surfaces[0]!.asphere;
    expect(a4).toBeCloseTo(-1.5e-4 / 25.4 ** 3, 18);
    expect(a6).toBeCloseTo(2.0e-6 / 25.4 ** 5, 22);
  });

  test('even asphere with an r² term is rejected', () => {
    const asphere = '  TYPE EVENASPH\r\n  CURV 0.1 0 0 0 0 ""\r\n  PARM 1 1.0E-3\r\n  PARM 2 -1.5E-4';
    expectZmxError(synthetic('MM', singletSurfaces(asphere)), /r² term/);
  });

  test('zmx rejects', () => {
    const coordinateBreak = singletSurfaces(standardFirst).replace('SURF 2\r\n  TYPE STANDARD', 'SURF 2\r\n  TYPE COORDBRK');
    expectZmxError(synthetic('MM', coordinateBreak), /coordinate break/i);
    const toroidal = singletSurfaces('  TYPE TOROIDAL\r\n  CURV 0.1 0 0 0 0 ""');
    expectZmxError(synthetic('MM', toroidal), /TOROIDAL/);
    // Every Thorlabs surface carries a "MIRR 2 0" line (mirror substrate for drawings);
    // a reflecting surface is the glass MIRROR.
    const mirror = singletSurfaces(standardFirst).replace('GLAS N-BK7', 'GLAS MIRROR');
    expectZmxError(synthetic('MM', mirror), /mirror/i);
    const noGlass = singletSurfaces(standardFirst).replace('  GLAS N-BK7 0 0 0 0 0 0 0 0 0 0\r\n', '');
    expectZmxError(synthetic('MM', noGlass), /no glass/i);
  });

  test('rejects an unknown unit and a non-sequential file', () => {
    expectZmxError(synthetic('FURLONG', singletSurfaces(standardFirst)), /FURLONG/);
    expectZmxError(synthetic('MM', singletSurfaces(standardFirst)).replace('MODE SEQ', 'MODE NSC'), /sequential/i);
  });
});
