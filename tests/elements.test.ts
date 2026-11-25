import { describe, expect, test } from 'vitest';
import { addMeasurement, insertElement, newOptic, newSource, removeElement, removeMeasurement } from '../src/ui/elements';
import { createStore } from '../src/ui/store';
import type { Setup } from '../src/engine/types';

const base = (): Setup => ({
  version: 1,
  sources: [{ kind: 'point', id: 's', label: 'S1', z: 0, y: 0, wavelengthsNm: [780], coneHalfAngleDeg: 5, rayCount: 11 }],
  optics: [
    { kind: 'ideal', id: 'a', label: 'L1', z: 100, decentreMm: 0, tiltDeg: 0, focalLengthMm: 100, apertureMm: 25 },
    { kind: 'screen', id: 'b', label: 'Screen 1', z: 300 },
  ],
  glasses: {},
});

describe('adding elements', () => {
  test('a new optic goes after the selected element and is selected', () => {
    const store = createStore(base(), null);
    store.select('a');
    const optic = newOptic('aperture', store.get());
    insertElement(store, optic);
    const { setup, selectedId } = store.get();
    expect(selectedId).toBe(optic.id);
    expect(setup.optics.map((o) => o.id)).toEqual(['a', optic.id, 'b']);
    expect(optic.z).toBeGreaterThan(100);
    expect(optic.z).toBeLessThan(300);
  });

  test('with nothing selected a new optic goes after the last one', () => {
    const optic = newOptic('ideal', { setup: base(), selectedId: null });
    expect(optic.z).toBeGreaterThan(300);
  });

  test('new labels do not repeat existing ones', () => {
    const optic = newOptic('ideal', { setup: base(), selectedId: null });
    expect(optic.label).toBe('L2');
    expect(newSource('gaussian', { setup: base(), selectedId: null }).label).toBe('S2');
  });

  test('a catalogue lens defaults to an achromat', () => {
    const optic = newOptic('lens', { setup: base(), selectedId: null });
    expect(optic.kind === 'lens' && optic.prescription.partNumber).toBe('AC254-100-B');
  });

  test('adding and removing are each one undo step', () => {
    const store = createStore(base(), null);
    insertElement(store, newSource('collimated', store.get()));
    expect(store.get().setup.sources).toHaveLength(2);
    store.apply((s) => removeElement(s, 'a'), 'remove');
    expect(store.get().setup.optics.map((o) => o.id)).toEqual(['b']);
    store.undo();
    store.undo();
    expect(store.get().setup).toEqual(base());
  });
});

describe('measurements', () => {
  test('a pair is measured once, whichever way round', () => {
    const once = addMeasurement(base(), 'a', 'b');
    expect(once.measurements).toEqual([{ id: expect.any(String), a: 'a', b: 'b' }]);
    expect(addMeasurement(once, 'b', 'a')).toBe(once);
    expect(addMeasurement(once, 'a', 'a')).toBe(once);
    expect(addMeasurement(once, 'a', 'missing')).toBe(once);
  });

  test('removing an element removes its arrows, and undo brings both back', () => {
    const store = createStore(addMeasurement(addMeasurement(base(), 's', 'a'), 'a', 'b'), null);
    const before = store.get().setup;
    store.apply((s) => removeElement(s, 'b'), 'remove');
    expect(store.get().setup.measurements?.map((m) => [m.a, m.b])).toEqual([['s', 'a']]);
    store.undo();
    expect(store.get().setup).toBe(before);
  });

  test('removing the last arrow drops the field', () => {
    const measured = addMeasurement(base(), 'a', 'b');
    expect(removeMeasurement(measured, measured.measurements![0]!.id)).not.toHaveProperty('measurements');
  });
});
