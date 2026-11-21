import { describe, expect, test } from 'vitest';
import { hitTest, hoverLines } from '../src/ui/bench/interact';
import { traceGaussians } from '../src/engine/gaussian';
import { fitAll, pan, toScreen, toWorld, zoomAbout, type View } from '../src/ui/bench/view';
import { catalogue } from '../src/ui/elements';
import { traceSetup } from '../src/engine/trace';
import type { Setup } from '../src/engine/types';

const view: View = { zMin: -50, zMax: 350, yMin: -10, yMax: 15, widthPx: 800, heightPx: 400 };

describe('bench view', () => {
  test.each(['both', 'y'] as const)('zoom keeps the cursor point fixed (%s)', (axis) => {
    const [px, py] = [230, 117];
    const before = toWorld(view, px, py);
    for (const factor of [1.7, 0.4]) {
      const after = toWorld(zoomAbout(view, px, py, factor, axis), px, py);
      expect(after[0]).toBeCloseTo(before[0], 9);
      expect(after[1]).toBeCloseTo(before[1], 9);
    }
  });

  test('zoom by a factor above 1 magnifies', () => {
    const zoomed = zoomAbout(view, 400, 200, 2, 'both');
    expect(zoomed.zMax - zoomed.zMin).toBeCloseTo((view.zMax - view.zMin) / 2, 9);
    expect(zoomed.yMax - zoomed.yMin).toBeCloseTo((view.yMax - view.yMin) / 2, 9);
  });

  test('y-only zoom leaves z range', () => {
    const zoomed = zoomAbout(view, 230, 117, 3, 'y');
    expect(zoomed.zMin).toBe(view.zMin);
    expect(zoomed.zMax).toBe(view.zMax);
    expect(zoomed.yMax - zoomed.yMin).toBeCloseTo((view.yMax - view.yMin) / 3, 9);
  });

  test('round trip', () => {
    for (const [z, y] of [
      [0, 0],
      [123.4, -7.25],
      [-50, 15],
    ] as const) {
      const [px, py] = toScreen(view, z, y);
      const [z2, y2] = toWorld(view, px, py);
      expect(z2).toBeCloseTo(z, 9);
      expect(y2).toBeCloseTo(y, 9);
    }
  });

  test('screen y grows downwards while world y grows upwards', () => {
    expect(toScreen(view, 0, 15)[1]).toBe(0);
    expect(toScreen(view, 0, -10)[1]).toBe(400);
  });

  test('pan moves the world with the pointer', () => {
    const moved = pan(view, 40, -20);
    const [z, y] = toWorld(view, 100, 100);
    const [px, py] = toScreen(moved, z, y);
    expect(px).toBeCloseTo(140, 9);
    expect(py).toBeCloseTo(80, 9);
  });
});

const achromat = catalogue.find((p) => p.partNumber === 'AC254-100-B')!;
const setup: Setup = {
  version: 1,
  sources: [{ kind: 'point', id: 's', label: 'S1', z: 0, y: 0, wavelengthsNm: [780], coneHalfAngleDeg: 'fill', rayCount: 11 }],
  optics: [
    { kind: 'lens', id: 'lens', label: 'L1', z: 97, decentreMm: 0, tiltDeg: 0, prescription: achromat, flipped: true },
    { kind: 'screen', id: 'scr', label: 'Screen', z: 300 },
  ],
  glasses: {},
};

describe('fitAll', () => {
  test('covers every element, the trace end and the apertures', () => {
    const trace = traceSetup(setup);
    const v = fitAll(setup, trace, 800, 400);
    expect(v.widthPx).toBe(800);
    expect(v.heightPx).toBe(400);
    expect(v.zMin).toBeLessThan(0);
    expect(v.zMax).toBeGreaterThan(Math.max(300, trace.endZ));
    expect(v.yMax).toBeGreaterThan(12.7);
    expect(v.yMin).toBeLessThan(-12.7);
  });

  test('an empty setup still gives a usable view', () => {
    const empty: Setup = { version: 1, sources: [], optics: [], glasses: {} };
    const v = fitAll(empty, traceSetup(empty), 800, 400);
    expect(v.zMax).toBeGreaterThan(v.zMin);
    expect(v.yMax).toBeGreaterThan(v.yMin);
  });
});

describe('hitTest', () => {
  const v: View = { zMin: 50, zMax: 150, yMin: -20, yMax: 20, widthPx: 1000, heightPx: 400 };

  test('a click within 6 px of a lens outline returns its id', () => {
    // flipped AC254-100-B: its flat face is the first vertex
    const [px, py] = toScreen(v, 97, 0);
    expect(hitTest(v, setup, px - 5, py)).toBe('lens');
    expect(hitTest(v, setup, px + 3, py + 50)).toBe('lens');
  });

  test('empty space returns null', () => {
    expect(hitTest(v, setup, 100, 30)).toBeNull();
    const [px] = toScreen(v, 97, 0);
    expect(hitTest(v, setup, px - 12, toScreen(v, 0, 0)[1])).toBeNull();
  });

  test('sources and screens are hit near their markers', () => {
    const wide: View = { zMin: -20, zMax: 320, yMin: -20, yMax: 20, widthPx: 1000, heightPx: 400 };
    const [sx, sy] = toScreen(wide, 0, 0);
    expect(hitTest(wide, setup, sx + 3, sy - 2)).toBe('s');
    const [scrX] = toScreen(wide, 300, 0);
    expect(hitTest(wide, setup, scrX + 4, 30)).toBe('scr');
  });
});

describe('hover readout', () => {
  const beam = (y: number): Setup => ({
    version: 1,
    sources: [{ kind: 'gaussian', id: 'g', label: 'S2', z: 0, y, wavelengthsNm: [780, 1064], angleDeg: 0, waistRadiusMm: 0.5, waistZ: 0, m2: 1 }],
    optics: [{ kind: 'aperture', id: 'iris', label: 'Iris', z: 100, decentreMm: 0, diameterMm: 1 }],
    glasses: {},
  });
  const linesAt = (s: Setup, z: number) => hoverLines({ setup: s, selectedId: null }, traceGaussians(s, traceSetup(s).endZ), z, 0);

  test('lists w(z) for each beam and wavelength, and the position', () => {
    const lines = linesAt(beam(0), 50);
    expect(lines[0]).toBe('z 50.00 mm   y 0.000 mm');
    expect(lines.slice(1)).toEqual([expect.stringMatching(/^S2 780 nm: w = 50\d µm$/), expect.stringMatching(/^S2 1064 nm: w = 5\d\d µm$/)]);
  });

  test('skips beams that do not reach z', () => {
    expect(linesAt(beam(0), -20)).toHaveLength(1);
  });

  test('marks w unreliable past a clipping element, and notes an off-axis beam', () => {
    const lines = linesAt(beam(0.1), 150);
    expect(lines[1]).toMatch(/\(unreliable: clipped\)$/);
    expect(lines.at(-1)).toBe('Tangential (meridional) rays only — sagittal focus not computed');
  });
});
