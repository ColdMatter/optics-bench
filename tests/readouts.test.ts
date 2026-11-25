import { describe, expect, test } from 'vitest';
import type { FocusResult } from '../src/engine/focus';
import type { GaussianTrace, Setup, Source } from '../src/engine/types';
import { describeWarnings, focusRows, formatLength, gaussianRows, isOffAxis, magnificationCell, objectSideRmsCell, type ReadoutRow } from '../src/ui/readouts';

const row = (rows: ReadoutRow[], label: string) => rows.find((r) => r.label === label);
const texts = (r: ReadoutRow | undefined) => r?.cells.map((c) => c?.text ?? null);

const focus = (over: Partial<FocusResult> = {}): FocusResult => ({
  wavelengthNm: 780,
  status: 'ok',
  paraxialZ: 200,
  bestZ: 199.95,
  rmsAtBestMm: 0.002,
  imageHeightMm: 0,
  approximate: false,
  ...over,
});

const gaussian = (over: Partial<GaussianTrace> = {}): GaussianTrace => ({
  sourceId: 'g',
  wavelengthNm: 780,
  m2: 1,
  centre: { wavelengthNm: 780, points: [], blockedBy: null, final: null },
  segments: [],
  waists: [
    { afterOpticId: null, z: 0, radiusMm: 0.5, collimated: false },
    { afterOpticId: 'l1', z: 150.25, radiusMm: 0.04, collimated: false },
  ],
  warnings: [],
  ...over,
});

describe('focusRows', () => {
  test('a column per wavelength and a signed focal shift from the column to the left', () => {
    const rows = focusRows([focus({ wavelengthNm: 780, paraxialZ: 200 }), focus({ wavelengthNm: 852, paraxialZ: 200.41 })], false);
    expect(texts(row(rows, 'Paraxial focus z'))).toEqual(['200.000 mm', '200.410 mm']);
    expect(texts(row(rows, 'Focal shift'))).toEqual([null, '+410 µm']);
  });

  test('a shift to shorter focus is negative; a shift of a millimetre or more is in mm', () => {
    const rows = focusRows([focus({ wavelengthNm: 780, paraxialZ: 200 }), focus({ wavelengthNm: 1064, paraxialZ: 197.5 })], false);
    expect(texts(row(rows, 'Focal shift'))).toEqual([null, '-2.500 mm']);
  });

  test('one wavelength has no focal shift row', () => {
    expect(row(focusRows([focus()], false), 'Focal shift')).toBeUndefined();
  });

  test('absolute positions from a drawing lens are approximate; the shift is not', () => {
    const rows = focusRows([focus({ approximate: true }), focus({ wavelengthNm: 852, paraxialZ: 200.41, approximate: true })], false);
    expect(texts(row(rows, 'Focal shift'))!.join()).not.toContain('≈');
    for (const label of ['Paraxial focus z', 'Best focus z']) for (const text of texts(row(rows, label))!) expect(text).toMatch(/^≈/);
    expect(texts(row(focusRows([focus()], false), 'Paraxial focus z'))![0]).not.toContain('≈');
  });

  test('collimated and blocked wavelengths say so instead of giving numbers', () => {
    const none = { paraxialZ: null, bestZ: null, rmsAtBestMm: null, imageHeightMm: null };
    const rows = focusRows([focus({ status: 'collimated', ...none }), focus({ wavelengthNm: 852, status: 'no-rays', ...none })], false);
    expect(rows).toHaveLength(1);
    expect(texts(rows[0])).toEqual(['none (collimated)', 'No rays reach this point']);
    const mixed = focusRows([focus(), focus({ wavelengthNm: 852, status: 'no-rays', ...none })], false);
    expect(texts(row(mixed, 'Paraxial focus z'))![1]).toBe('No rays reach this point');
    expect(JSON.stringify(mixed)).not.toMatch(/NaN|Infinity/);
  });

  test('off axis adds the image height', () => {
    expect(row(focusRows([focus()], true), 'Image height y')).toBeDefined();
    expect(row(focusRows([focus()], false), 'Image height y')).toBeUndefined();
  });
});

describe('gaussianRows', () => {
  const labels = { l1: 'L1', l2: 'L2' };

  test('a row per waist with its radius and position', () => {
    const { rows } = gaussianRows([gaussian()], labels);
    expect(texts(row(rows, 'Input waist'))).toEqual(['w₀ 500 µm at z 0.000 mm']);
    expect(texts(row(rows, 'After L1'))).toEqual(['w₀ 40.0 µm at z 150.250 mm']);
  });

  test('a collimated waist reads "collimated", not a far-away position', () => {
    const { rows } = gaussianRows([gaussian({ waists: [{ afterOpticId: 'l1', z: 1e15, radiusMm: 2.5, collimated: true }] })], labels);
    expect(texts(rows[0])![0]).toContain('collimated');
    expect(JSON.stringify(rows)).not.toMatch(/e\+|1000000/);
  });

  test('a clipped beam is noted as unreliable, naming the element', () => {
    const { rows, notes } = gaussianRows([gaussian({ warnings: [{ kind: 'clipped', opticId: 'l2' }] })], labels);
    expect(notes).toEqual([{ text: 'Unreliable: beam clipped at L2', warn: true }]);
    expect(row(rows, 'After L1')).toBeDefined();
  });
});

describe('isOffAxis', () => {
  const base = (source: Source, decentreMm = 0): Setup => ({
    version: 1,
    sources: [source],
    optics: [{ kind: 'ideal', id: 'l', label: 'L1', z: 100, decentreMm, tiltDeg: 0, focalLengthMm: 50, apertureMm: 25 }],
    glasses: {},
  });
  const point = (y: number): Source => ({
    kind: 'point', id: 's', label: 'S1', z: 0, y, wavelengthsNm: [780], coneHalfAngleDeg: 5, rayCount: 11,
  });

  test('a source on the axis of centred optics is on axis', () => {
    expect(isOffAxis(base(point(0)), base(point(0)).sources[0]!)).toBe(false);
  });

  test('a raised source, a tilted beam or a decentred optic in the path is off axis', () => {
    expect(isOffAxis(base(point(1)), point(1))).toBe(true);
    const tilted: Source = {
      kind: 'collimated', id: 's', label: 'S1', z: 0, y: 0, wavelengthsNm: [780], widthMm: 5, angleDeg: 1, rayCount: 11,
    };
    expect(isOffAxis(base(tilted), tilted)).toBe(true);
    expect(isOffAxis(base(point(0), 0.5), point(0))).toBe(true);
  });
});

describe('formatLength', () => {
  test('µm below a millimetre, mm from there on, never in exponent form', () => {
    expect(formatLength(0.0123)).toBe('12.3 µm');
    expect(formatLength(0.99999)).toBe('1.000 mm');
    expect(formatLength(12.5)).toBe('12.500 mm');
    expect(formatLength(1e-12)).toBe('0.00 µm');
  });
});

describe('describeWarnings', () => {
  test('names the elements and the glass in plain words', () => {
    const setup: Setup = {
      version: 1,
      sources: [],
      optics: [
        { kind: 'ideal', id: 'a', label: 'L1', z: 0, decentreMm: 0, tiltDeg: 0, focalLengthMm: 50, apertureMm: 25 },
        { kind: 'slm', id: 'b', label: 'SLM 1', z: 1, decentreMm: 0, tiltDeg: 0, apertureMm: 10, pixelPitchUm: 12.5, designWavelengthNm: 780, phase: [] },
      ],
      glasses: {},
    };
    expect(
      describeWarnings(setup, [
        { kind: 'overlap', ids: ['a', 'b'] },
        { kind: 'unknown-glass', opticId: 'a', glass: 'FD10' },
        { kind: 'slm-pitch-limit', opticId: 'b' },
        { kind: 'glass-extrapolated', glass: 'N-BK7', wavelengthNm: 1550 },
      ]),
    ).toEqual([
      'L1 overlaps SLM 1',
      'L1: glass FD10 is unknown, so rays are blocked there',
      'SLM 1: the phase gradient is finer than the pixel pitch can show; rays there are blocked',
      'N-BK7 index extrapolated beyond its data at 1550 nm',
    ]);
  });
});

describe('magnificationCell', () => {
  test('4 significant figures, signed, or why there is no number', () => {
    expect(magnificationCell({ wavelengthNm: 780, value: -1.00100256 })).toEqual({ text: '-1.001' });
    expect(magnificationCell({ wavelengthNm: 780, value: 28.70701 })).toEqual({ text: '28.71' });
    expect(magnificationCell({ wavelengthNm: 780, value: 1e-15 })).toEqual({ text: '0.000' });
    expect(magnificationCell({ wavelengthNm: 780, value: null, reason: 'edge-ray-blocked' })).toEqual({ text: 'edge ray blocked', warn: true });
    expect(magnificationCell({ wavelengthNm: 780, value: null, reason: 'undefined' })).toEqual({ text: 'undefined (no beam width)' });
    expect(magnificationCell({ wavelengthNm: 780, value: null, reason: 'no-rays' })).toEqual({ text: 'unavailable' });
    expect(magnificationCell(undefined)).toBeNull();
  });

  test('the object-side RMS is the spot RMS over |M|, when there is a usable M', () => {
    expect(objectSideRmsCell({ wavelengthNm: 780, value: 28.707 }, 0.048)).toEqual({ text: '1.67 µm' });
    expect(objectSideRmsCell({ wavelengthNm: 780, value: -2 }, 0.004)).toEqual({ text: '2.00 µm' });
    expect(objectSideRmsCell({ wavelengthNm: 780, value: 0 }, 0.004)).toBeNull();
    expect(objectSideRmsCell({ wavelengthNm: 780, value: null, reason: 'no-rays' }, 0.004)).toBeNull();
  });
});
