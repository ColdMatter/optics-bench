import { describe, expect, test } from 'vitest';
import type { FocusResult } from '../src/engine/focus';
import type { GaussianTrace, Setup, Source } from '../src/engine/types';
import { describeWarnings, formatFocus, formatGaussian, formatLength, formatMagnification, isOffAxis } from '../src/ui/readouts';

const NOTE = 'Tangential (meridional) rays only — sagittal focus not computed';

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

describe('formatFocus', () => {
  test('a line per wavelength and a signed focal shift, longer minus shorter', () => {
    const lines = formatFocus([focus({ wavelengthNm: 852, paraxialZ: 200.41 }), focus({ wavelengthNm: 780, paraxialZ: 200 })], false);
    expect(lines.filter((l) => l.startsWith('780 nm'))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('852 nm'))).toHaveLength(1);
    expect(lines).toContain('Δfocus 780→852 nm: +410 µm');
  });

  test('a shift to shorter focus is negative; a shift of a millimetre or more is in mm', () => {
    const lines = formatFocus([focus({ wavelengthNm: 780, paraxialZ: 200 }), focus({ wavelengthNm: 1064, paraxialZ: 197.5 })], false);
    expect(lines).toContain('Δfocus 780→1064 nm: -2.500 mm');
  });

  test('absolute positions from a drawing lens are approximate; the shift is not', () => {
    const lines = formatFocus(
      [focus({ approximate: true }), focus({ wavelengthNm: 852, paraxialZ: 200.41, approximate: true })],
      false,
    );
    const shift = lines.find((l) => l.startsWith('Δfocus'))!;
    expect(shift).not.toContain('approx.');
    const perWavelength = lines.filter((l) => /^\d+ nm:/.test(l));
    expect(perWavelength).toHaveLength(2);
    for (const line of perWavelength) expect(line).toContain('approx.');
    expect(formatFocus([focus()], false)[0]).not.toContain('approx.');
  });

  test('collimated and blocked wavelengths say so instead of giving numbers', () => {
    const lines = formatFocus(
      [
        focus({ status: 'collimated', paraxialZ: null, bestZ: null, rmsAtBestMm: null, imageHeightMm: null }),
        focus({ wavelengthNm: 852, status: 'no-rays', paraxialZ: null, bestZ: null, rmsAtBestMm: null, imageHeightMm: null }),
      ],
      false,
    );
    expect(lines[0]).toBe('780 nm: no focus (collimated)');
    expect(lines[1]).toBe('852 nm: No rays reach this point');
    expect(lines.join('\n')).not.toMatch(/NaN|Infinity|Δfocus/);
  });

  test('an off-axis source carries the meridional note', () => {
    expect(formatFocus([focus()], true)).toContain(NOTE);
    expect(formatFocus([focus()], false)).not.toContain(NOTE);
  });
});

describe('formatGaussian', () => {
  const labels = { l1: 'L1', l2: 'L2' };

  test('lists each waist with its position and radius', () => {
    const lines = formatGaussian(gaussian(), labels);
    expect(lines).toContain('780 nm input waist: w₀ = 500 µm at z = 0.000 mm');
    expect(lines).toContain('780 nm after L1: w₀ = 40.0 µm at z = 150.250 mm');
  });

  test('a collimated waist reads "collimated", not a far-away position', () => {
    const lines = formatGaussian(
      gaussian({ waists: [{ afterOpticId: 'l1', z: 1e15, radiusMm: 2.5, collimated: true }] }),
      labels,
    );
    expect(lines[0]).toContain('collimated');
    expect(lines.join('\n')).not.toMatch(/e\+|1000000/);
  });

  test('a clipped beam is marked unreliable, naming the element', () => {
    const lines = formatGaussian(gaussian({ warnings: [{ kind: 'clipped', opticId: 'l2' }] }), labels);
    expect(lines.some((l) => l.includes('unreliable: beam clipped at L2'))).toBe(true);
    expect(lines.some((l) => l.includes('after L1'))).toBe(true);
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

describe('formatMagnification', () => {
  test('4 significant figures, signed, or why there is no number', () => {
    expect(formatMagnification({ wavelengthNm: 780, value: -1.00100256 })).toBe(', M = -1.001');
    expect(formatMagnification({ wavelengthNm: 780, value: 28.70701 })).toBe(', M = 28.71');
    expect(formatMagnification({ wavelengthNm: 780, value: 1e-15 })).toBe(', M = 0.000');
    expect(formatMagnification({ wavelengthNm: 780, value: null, reason: 'edge-ray-blocked' })).toBe(', M: edge ray blocked');
    expect(formatMagnification({ wavelengthNm: 780, value: null, reason: 'undefined' })).toBe(', M undefined (no beam width)');
    expect(formatMagnification({ wavelengthNm: 780, value: null, reason: 'no-rays' })).toBe(', M unavailable');
    expect(formatMagnification(undefined)).toBe('');
  });
});
