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
// Thorlabs' focal-shift plots for these were computed with SF5, though their .zmx and drawing specify N-SF5.
const PLOTTED_GLASS: Record<string, Record<string, string>> = {
  'AC254-040-A': { 'N-SF5': 'SF5' },
  'AC254-075-A': { 'N-SF5': 'SF5' },
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
  test('includes every Ø1" achromat and plano-convex singlet', () => {
    const parts = new Set(lenses.map((l) => l.partNumber));
    const focals = [30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 400, 500];
    for (const coating of ['A', 'B']) {
      for (const f of focals) {
        const part = `AC254-${String(f).padStart(3, '0')}-${coating}`;
        // Left out: its flint, HOYA FD10, is not in the glass database.
        if (part !== 'AC254-060-A') expect(parts).toContain(part);
      }
    }
    for (const part of PLANO_CONVEX) expect(parts).toContain(part);
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

describe('matches Thorlabs focal shift', () => {
  test('has the reference curves', () => {
    expect(Object.keys(focalShifts)).toEqual(expect.arrayContaining(['AC254-100-B', 'AC254-200-A']));
  });

  const parts = Object.keys(focalShifts);
  for (const [part, mismatch] of Object.entries(PLOT_DISAGREES_WITH_ZMX)) {
    test.skip(`${part} (Thorlabs' plot disagrees with its .zmx by ${mismatch})`, () => {});
  }

  test.each(parts.filter((p) => !(p in PLOT_DISAGREES_WITH_ZMX)))('%s', (part) => {
    const rows = focalShifts[part]!;
    const catalogued = lenses.find((l) => l.partNumber === part);
    expect(catalogued, part).toBeDefined();
    const substitutes = PLOTTED_GLASS[part] ?? {};
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
  });
});
