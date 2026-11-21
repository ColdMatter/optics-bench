import { expect, test } from 'vitest';
import { focusPerWavelength } from '../src/engine/focus';
import { radiusAt, traceGaussians } from '../src/engine/gaussian';
import { parseSetup, serialiseSetup } from '../src/engine/io';
import { traceSetup } from '../src/engine/trace';
import { defaultSetup } from '../src/ui/defaultSetup';

const setup = defaultSetup();
const [point, beam] = setup.sources;
const screen = setup.optics.find((o) => o.kind === 'screen')!;

test('is a valid setup file', () => expect(parseSetup(serialiseSetup(setup))).toEqual(setup));

test('traces without warnings', () => expect(traceSetup(setup).warnings).toEqual([]));

test('the point source is focused on the screen at both wavelengths', () => {
  const focus = focusPerWavelength(setup, point!.id);
  expect(focus.map((f) => f.wavelengthNm)).toEqual([780, 852]);
  for (const f of focus) expect(Math.abs(f.paraxialZ! - screen.z)).toBeLessThan(0.5);
});

test('the Gaussian beam passes every element unclipped and reaches the screen', () => {
  const [g] = traceGaussians(setup, traceSetup(setup).endZ);
  const powered = setup.optics.filter((o) => o.kind === 'ideal' || o.kind === 'lens').map((o) => o.id);
  expect(g!.sourceId).toBe(beam!.id);
  expect(g!.centre.blockedBy).toBeNull();
  expect(g!.warnings).toEqual([]);
  expect(g!.waists.map((w) => w.afterOpticId)).toEqual([null, ...powered]);
  expect(radiusAt(g!, screen.z)).toBeGreaterThan(0);
});
