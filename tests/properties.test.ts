import { describe, expect, test } from 'vitest';
import { createPropertiesPanel, fieldsFor, focalWavelengths, parsePhaseCsv, phaseTermFields } from '../src/ui/properties';
import { createStore } from '../src/ui/store';
import type { Aperture, GaussianSource, IdealLens, PointSource, Setup } from '../src/engine/types';

const ideal: IdealLens = { kind: 'ideal', id: 'l', label: 'L1', z: 0, decentreMm: 0, tiltDeg: 0, focalLengthMm: 100, apertureMm: 25 };
const aperture: Aperture = { kind: 'aperture', id: 'a', label: 'A1', z: 0, decentreMm: 0, diameterMm: 5 };
const point: PointSource = { kind: 'point', id: 's', label: 'S1', z: 0, y: 0, wavelengthsNm: [780], coneHalfAngleDeg: 5, rayCount: 11 };
const gaussian: GaussianSource = {
  kind: 'gaussian',
  id: 'g',
  label: 'G1',
  z: 0,
  y: 0,
  wavelengthsNm: [780],
  angleDeg: 0,
  waistRadiusMm: 0.5,
  waistZ: 0,
  m2: 1,
};

const spec = (fields: ReturnType<typeof fieldsFor>, key: string) => {
  const found = fields.find((f) => f.key === key);
  if (!found) throw new Error(`no field ${key}`);
  return found;
};

describe('field validation', () => {
  test('ideal lens focal length', () => {
    expect(spec(fieldsFor(ideal), 'focalLengthMm').validate(0)).toMatch(/non-zero/);
    expect(spec(fieldsFor(ideal), 'focalLengthMm').validate(-50)).toBeNull();
  });
  test('aperture diameter', () => expect(spec(fieldsFor(aperture), 'diameterMm').validate(-1)).toMatch(/greater than zero/));
  test('wavelength', () => expect(spec(fieldsFor(point), 'wavelengthsNm').validate(0)).toMatch(/greater than zero/));
  test('tilt, ray count and M² follow the file rules', () => {
    expect(spec(fieldsFor(ideal), 'tiltDeg').validate(90)).not.toBeNull();
    expect(spec(fieldsFor(point), 'rayCount').validate(2.5)).not.toBeNull();
    expect(spec(fieldsFor(gaussian), 'm2').validate(0.9)).not.toBeNull();
  });
  test('non-finite input is rejected everywhere', () => {
    for (const f of [...fieldsFor(ideal), ...fieldsFor(point)]) expect(f.validate(Number.NaN)).not.toBeNull();
  });
  test('every numeric field carries a unit or is dimensionless by name', () => {
    for (const f of fieldsFor(gaussian)) expect(f.unit !== '' || f.key === 'm2').toBe(true);
  });
  test('Fresnel focal length must be non-zero', () =>
    expect(spec(phaseTermFields({ kind: 'fresnel', focalLengthMm: 200 }), 'focalLengthMm').validate(0)).not.toBeNull());
});

describe('phase table CSV', () => {
  test('header, blank lines and CRLF', () => {
    expect(parsePhaseCsv('y_mm, phase_rad\r\n-1, 0.5\r\n\r\n0, 0\r\n1, 0.5\r\n')).toEqual({
      yMm: [-1, 0, 1],
      phaseRad: [0.5, 0, 0.5],
    });
  });
  test('no header', () => expect(parsePhaseCsv('0,1\n2,3')).toEqual({ yMm: [0, 2], phaseRad: [1, 3] }));
  test('a row with the wrong number of columns', () => expect(() => parsePhaseCsv('0,1\n2\n')).toThrow(/line 2/));
  test('a non-numeric value', () => expect(() => parsePhaseCsv('0,1\n2,abc')).toThrow(/line 2/));
  test('y must increase', () => expect(() => parsePhaseCsv('0,1\n0,2')).toThrow(/increas/));
  test('needs two rows', () => expect(() => parsePhaseCsv('y_mm,phase_rad\n0,1')).toThrow(/at least 2/));
});

describe('properties panel', () => {
  const setup: Setup = { version: 1, sources: [], optics: [ideal], glasses: {} };
  const focalInput = (panel: HTMLElement) => panel.querySelector<HTMLInputElement>('input[aria-label="Focal length (mm)"]')!;
  const enter = (input: HTMLInputElement, text: string) => {
    input.value = text;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
  };
  const mount = () => {
    const store = createStore(setup, null);
    const container = document.createElement('div');
    const panel = createPropertiesPanel(container, store);
    store.select('l');
    panel.render(store.get(), new Map());
    return { store, container };
  };

  test('invalid input shows a message and is not applied', () => {
    const { store, container } = mount();
    enter(focalInput(container), '0');
    expect(store.get().setup).toBe(setup);
    expect(container.querySelector('.field-error:not([hidden])')?.textContent).toMatch(/non-zero/);
  });

  test('valid input is applied as one undo step', () => {
    const { store, container } = mount();
    enter(focalInput(container), '-50');
    const lens = store.get().setup.optics[0] as IdealLens;
    expect(lens.focalLengthMm).toBe(-50);
    store.undo();
    expect(store.get().setup).toBe(setup);
  });
});

describe('focalWavelengths', () => {
  test('every source wavelength once, in order; the d line when there are no sources', () => {
    const setup = (sources: Setup['sources']): Setup => ({ version: 1, sources, optics: [], glasses: {} });
    expect(focalWavelengths(setup([{ ...point, wavelengthsNm: [852, 780] }, { ...gaussian, wavelengthsNm: [780, 606] }]))).toEqual([606, 780, 852]);
    expect(focalWavelengths(setup([]))).toEqual([587.6]);
  });
});
