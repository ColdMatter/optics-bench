import { expect, test } from 'vitest';
import { inRange, makeGlassLookup, refractiveIndex } from '../src/engine/glass';

const g = makeGlassLookup();

test('N-BK7 nd', () => expect(refractiveIndex(g('N-BK7')!, 587.56)).toBeCloseTo(1.5168, 4));
test('N-SF6 nd', () => expect(refractiveIndex(g('N-SF6')!, 587.56)).toBeCloseTo(1.80518, 4));
test('N-BAF10 nd', () => expect(refractiveIndex(g('N-BAF10')!, 587.56)).toBeCloseTo(1.67003, 4));
test('N-BK7 at 1064 nm', () => expect(refractiveIndex(g('N-BK7')!, 1064)).toBeCloseTo(1.50663, 4));
test('formula 3 glass (CDGM BAF2)', () => {
  expect(refractiveIndex(g('BAF2')!, 587.56)).toBeCloseTo(1.57, 2);
});
test('case-insensitive lookup', () => expect(g('n-bk7')?.name).toBe('N-BK7'));
test('unknown glass', () => expect(g('NOT-A-GLASS')).toBeUndefined());
test('extra overrides bundled', () =>
  expect(
    refractiveIndex(
      makeGlassLookup({ 'N-BK7': { name: 'N-BK7', formula: 'constant', coefficients: [1.6], rangeUm: [0, 99] } })('N-BK7')!,
      800,
    ),
  ).toBe(1.6));
test('inRange', () => {
  expect(inRange(g('N-BK7')!, 780)).toBe(true);
  expect(inRange(g('N-BK7')!, 3000)).toBe(false);
});
