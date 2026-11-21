import { expect, test } from 'vitest';
import { focusPerWavelength } from '../src/engine/focus';
import { traceGaussians } from '../src/engine/gaussian';
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

test('the Gaussian beam passes both ideal lenses before the achromats stop it', () => {
  const [g] = traceGaussians(setup, traceSetup(setup).endZ);
  const ideal = setup.optics.filter((o) => o.kind === 'ideal').map((o) => o.id);
  expect(g!.sourceId).toBe(beam!.id);
  expect(g!.waists.map((w) => w.afterOpticId)).toEqual([null, ...ideal]);
  expect(g!.centre.blockedBy).toBe(setup.optics.find((o) => o.kind === 'lens')!.id);
});
