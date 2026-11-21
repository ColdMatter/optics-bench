/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest';
import lensesJson from '../src/data/lenses.json';
import drawingFocalLengths from './fixtures/thorlabs-drawing-focal-lengths.json';
import { focusShiftCurve } from '../src/engine/focus';
import { makeGlassLookup } from '../src/engine/glass';
import { lensAbcd } from '../src/engine/lens';
import type { CatalogueLens, CollimatedSource, LensPrescription, Setup } from '../src/engine/types';

const lenses = lensesJson as LensPrescription[];
const glasses = makeGlassLookup();
type ShiftRow = { wavelengthNm: number; shiftUm: number };
const focalShifts = Object.fromEntries(
  Object.entries(import.meta.glob<ShiftRow[]>('../src/data/thorlabs-focal-shift/*.json', { eager: true, import: 'default' })).map(
    ([path, rows]) => [/([^/]+)\.json$/.exec(path)![1]!, rows],
  ),
);

const COATING_BANDS_NM = { A: [400, 700], B: [650, 1050] } as const;
const BAND_CENTRE_NM = { A: 535, B: 855 } as const;
const N_BK7_DESIGN_WAVELENGTH_NM = 587.6;
const PLANO_CONVEX = [
  'LA1951', 'LA1805', 'LA1027', 'LA1422', 'LA1131', 'LA1134', 'LA1608', 'LA1509', 'LA1986',
  'LA1433', 'LA1229', 'LA1708', 'LA1461', 'LA1484', 'LA1172', 'LA1908', 'LA1978', 'LA1464',
];
const ACHROMAT_FOCALS_MM = {
  AC254: [30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 400, 500],
  AC508: [75, 100, 150, 200, 250, 300, 400, 500, 750, 1000],
};
// Left out of the catalogue: its flint, HOYA FD10, is not in the glass database.
const EXCLUDED = new Set(['AC254-060-A']);
const ACHROMATS = Object.entries(ACHROMAT_FOCALS_MM).flatMap(([prefix, focals]) =>
  ['A', 'B'].flatMap((coating) => focals.map((f) => `${prefix}-${String(f).padStart(3, '0')}-${coating}`)),
).filter((part) => !EXCLUDED.has(part));
// Thorlabs computed these plots with legacy SF5; their .zmx and drawing, and so the shipped lens, use N-SF5.
const PLOTTED_WITH_SF5: Record<string, string> = {
  'AC254-040-A': '17 µm at 400 nm',
  'AC254-075-A': '42 µm at 400 nm',
};
// Thorlabs' plot disagrees with its own .zmx by more than any glass substitution explains.
const PLOT_DISAGREES_WITH_ZMX: Record<string, string> = {
  'AC254-125-A': '15 µm at 400 nm',
  'AC254-200-B': '200 µm at 650 nm',
};

const placed = (prescription: LensPrescription): CatalogueLens => ({
  kind: 'lens', id: 'l', label: prescription.partNumber, z: 10, decentreMm: 0, tiltDeg: 0, flipped: false, prescription,
});

function nominal(partNumber: string): { focalMm: number; wavelengthNm: number } {
  const drawing = (drawingFocalLengths as Record<string, { focalLengthMm: number }>)[partNumber];
  if (!drawing) throw new Error(`no drawing focal length for ${partNumber}`);
  const coating = /^AC\d+-\d+-([AB])$/.exec(partNumber)?.[1] as 'A' | 'B' | undefined;
  return { focalMm: drawing.focalLengthMm, wavelengthNm: coating ? BAND_CENTRE_NM[coating] : N_BK7_DESIGN_WAVELENGTH_NM };
}

function interpolate(rows: ShiftRow[], wavelengthNm: number): number {
  const i = rows.findIndex((r) => r.wavelengthNm >= wavelengthNm);
  if (i < 0 || wavelengthNm < rows[0]!.wavelengthNm) throw new Error(`${wavelengthNm} nm outside the vendor data`);
  if (i === 0) return rows[0]!.shiftUm;
  const a = rows[i - 1]!;
  const b = rows[i]!;
  return a.shiftUm + ((b.shiftUm - a.shiftUm) * (wavelengthNm - a.wavelengthNm)) / (b.wavelengthNm - a.wavelengthNm);
}

describe('lens catalogue', () => {
  test('includes every listed achromat and plano-convex singlet', () => {
    const parts = lenses.map((l) => l.partNumber);
    expect(parts).toEqual(expect.arrayContaining([...ACHROMATS, ...PLANO_CONVEX]));
  });

  test.each(lenses.map((l) => [l.partNumber, l] as const))('%s is well formed', (_, lens) => {
    expect(lens.surfaces.length).toBeGreaterThanOrEqual(2);
    expect(lens.sourceRef).not.toBe('');
    expect(['zmx', 'drawing']).toContain(lens.source);
    expect(lens.surfaces.at(-1)).toMatchObject({ glassAfter: null, thicknessToNextMm: 0 });
    for (const s of lens.surfaces) if (s.glassAfter !== null) expect(glasses(s.glassAfter), s.glassAfter).toBeDefined();
  });

  test.each(lenses.map((l) => [l.partNumber, l] as const))('%s focal length is nominal', (_, lens) => {
    const { focalMm, wavelengthNm } = nominal(lens.partNumber);
    const [, , c] = lensAbcd(placed(lens), wavelengthNm, glasses);
    expect(Math.abs(-1 / c / focalMm - 1)).toBeLessThan(0.01);
  });
});

function expectMatchesFocalShift(part: string, substitutes: Record<string, string> = {}) {
  const rows = focalShifts[part]!;
  const catalogued = lenses.find((l) => l.partNumber === part);
  expect(catalogued, part).toBeDefined();
  const prescription: LensPrescription = {
    ...catalogued!,
    surfaces: catalogued!.surfaces.map((s) => ({ ...s, glassAfter: s.glassAfter && (substitutes[s.glassAfter] ?? s.glassAfter) })),
  };
  const reference = rows.reduce((best, r) => (Math.abs(r.shiftUm) < Math.abs(best.shiftUm) ? r : best));
  const source: CollimatedSource = {
    kind: 'collimated', id: 'c', label: 'C', z: 0, y: 0, wavelengthsNm: [reference.wavelengthNm], widthMm: 1, angleDeg: 0, rayCount: 3,
  };
  const setup: Setup = { version: 1, sources: [source], optics: [placed(prescription)], glasses: {} };
  const [referenceFocus] = focusShiftCurve(setup, 'c', reference.wavelengthNm, reference.wavelengthNm, 1);
  const [minNm, maxNm] = COATING_BANDS_NM[part.slice(-1) as 'A' | 'B'];
  for (const { wavelengthNm, paraxialZ } of focusShiftCurve(setup, 'c', minNm, maxNm, 61)) {
    const shiftUm = (paraxialZ! - referenceFocus!.paraxialZ!) * 1000;
    expect(Math.abs(shiftUm - interpolate(rows, wavelengthNm)), `${wavelengthNm} nm`).toBeLessThan(5);
  }
}

describe('matches Thorlabs focal shift', () => {
  test('has the reference curves', () => {
    expect(Object.keys(focalShifts)).toEqual(expect.arrayContaining(['AC254-100-B', 'AC254-200-A']));
  });

  test('every catalogued achromat has a focal-shift curve', () => {
    const achromats = lenses.map((l) => l.partNumber).filter((p) => p.startsWith('AC'));
    expect(Object.keys(focalShifts).sort()).toEqual(achromats.sort());
  });

  const special = (p: string) => p in PLOT_DISAGREES_WITH_ZMX || p in PLOTTED_WITH_SF5;
  test.each(Object.keys(focalShifts).filter((p) => !special(p)))('%s', (part) => expectMatchesFocalShift(part));

  for (const [part, mismatch] of Object.entries(PLOT_DISAGREES_WITH_ZMX)) {
    test.skip(`${part}: Thorlabs' plot disagrees with its own .zmx by ${mismatch}`, () => {});
  }
});

describe('Thorlabs focal-shift plots computed with legacy SF5', () => {
  for (const [part, mismatch] of Object.entries(PLOTTED_WITH_SF5)) {
    test(`${part}: matches the plot with SF5 in place of N-SF5`, () => expectMatchesFocalShift(part, { 'N-SF5': 'SF5' }));
    test.skip(`${part}: shipped N-SF5 lens differs from the plot by ${mismatch}`, () => {});
  }
});
