import { describe, expect, test } from 'vitest';
import { makeGlassLookup } from '../src/engine/glass';
import type { LensPrescription, Setup } from '../src/engine/types';
import { catalogueEntries, filterCatalogue, parseConstantIndex, substituteGlass, unknownGlasses } from '../src/ui/catalogue';
import { catalogue, insertElement, newOptic } from '../src/ui/elements';
import { createStore } from '../src/ui/store';

const entries = catalogueEntries();
const entry = (part: string) => entries.find((e) => e.prescription.partNumber === part)!;

describe('catalogue browser', () => {
  test('nominal focal lengths, diameters and types come from the prescriptions', () => {
    expect(entry('AC254-100-B').focalLengthMm).toBeCloseTo(100, 0);
    expect(entry('AC508-200-A').focalLengthMm).toBeCloseTo(200, 0);
    expect(entry('AC254-100-B').diameterMm).toBeCloseTo(25.4, 6);
    expect(entry('AC254-100-B').type).toBe('Achromatic doublet');
    expect(entry('LA1509').type).toBe('Plano-convex singlet');
    expect(entry('LA1509').focalLengthMm).toBeCloseTo(100, 0);
  });

  test('a search matches part-number substrings and focal lengths', () => {
    const byFocal = filterCatalogue(entries, '150').map((e) => e.prescription.partNumber);
    expect(byFocal).toEqual(expect.arrayContaining(['AC254-150-A', 'AC254-150-B', 'AC508-150-B', 'LA1433']));
    expect(byFocal).not.toContain('AC254-100-B');
    const byPart = filterCatalogue(entries, 'ac508').map((e) => e.prescription.partNumber);
    expect(byPart.length).toBeGreaterThan(0);
    expect(byPart.every((p) => p.startsWith('AC508'))).toBe(true);
    expect(filterCatalogue(entries, '  ')).toHaveLength(entries.length);
  });
});

describe('glass substitution on import', () => {
  const withUnknown = (): LensPrescription => {
    const p = structuredClone(catalogue.find((l) => l.partNumber === 'AC254-100-B')!);
    p.surfaces[1]!.glassAfter = 'FD10';
    return p;
  };

  test('lists the glasses neither bundled nor already in the setup', () => {
    expect(unknownGlasses(withUnknown(), {})).toEqual(['FD10']);
    expect(unknownGlasses(withUnknown(), { FD10: substituteGlass('FD10', { kind: 'index', index: 1.7 }) })).toEqual([]);
  });

  test('a substitute is stored under the unknown name so the lens resolves it', () => {
    const glass = substituteGlass('FD10', { kind: 'bundled', name: 'n-sf6ht' });
    const bundled = makeGlassLookup()('N-SF6HT')!;
    expect(glass).toEqual({ ...bundled, name: 'FD10' });
    expect(makeGlassLookup({ FD10: glass })('FD10')).toBe(glass);
  });

  test('a typed constant index must lie between 1 and 3', () => {
    expect(parseConstantIndex('1.72')).toEqual({ index: 1.72 });
    expect(parseConstantIndex('3.2')).toHaveProperty('error');
    expect(parseConstantIndex('1')).toHaveProperty('error');
    expect(parseConstantIndex('abc')).toHaveProperty('error');
  });

  test('inserting the lens with its glasses is one undo step', () => {
    const setup: Setup = { version: 1, sources: [], optics: [], glasses: {} };
    const store = createStore(setup, null);
    const lens = newOptic('lens', store.get(), withUnknown());
    insertElement(store, lens, { FD10: substituteGlass('FD10', { kind: 'index', index: 1.7 }) });
    expect(store.get().setup.glasses.FD10?.coefficients).toEqual([1.7]);
    expect(store.get().selectedId).toBe(lens.id);
    store.undo();
    expect(store.get().setup).toBe(setup);
  });
});
