import { newId } from '../engine/io';
import type { LensPrescription, Setup } from '../engine/types';
import { catalogue } from './elements';

function part(partNumber: string): LensPrescription {
  const found = catalogue.find((p) => p.partNumber === partNumber);
  if (!found) throw new Error(`${partNumber} is missing from the bundled catalogue`);
  return found;
}

/**
 * A point source relayed by two achromats onto a screen (flat side of the first towards the
 * source, so it collimates), preceded 20 mm above the axis by a Gaussian beam through a 1:2
 * ideal-lens telescope. Every element blocks light outside its aperture, so the beam ends at
 * the first achromat's plane; placing the telescope after the screen instead would block the
 * point source's rays and leave it with no focus.
 */
export function defaultSetup(): Setup {
  const placed = { decentreMm: 0, tiltDeg: 0 };
  const beamHeightMm = 20;
  return {
    version: 1,
    sources: [
      { kind: 'point', id: newId(), label: 'S1', z: 0, y: 0, wavelengthsNm: [780, 852], coneHalfAngleDeg: 'fill', rayCount: 11 },
      {
        kind: 'gaussian',
        id: newId(),
        label: 'S2',
        z: -300,
        y: beamHeightMm,
        wavelengthsNm: [780],
        angleDeg: 0,
        waistRadiusMm: 0.5,
        waistZ: -300,
        m2: 1,
      },
    ],
    optics: [
      { kind: 'ideal', id: newId(), label: 'L1', z: -250, decentreMm: beamHeightMm, tiltDeg: 0, focalLengthMm: 50, apertureMm: 10 },
      { kind: 'ideal', id: newId(), label: 'L2', z: -100, decentreMm: beamHeightMm, tiltDeg: 0, focalLengthMm: 100, apertureMm: 10 },
      { kind: 'lens', id: newId(), label: 'L3', z: 97, ...placed, prescription: part('AC254-100-B'), flipped: true },
      { kind: 'lens', id: newId(), label: 'L4', z: 145, ...placed, prescription: part('AC254-150-B'), flipped: false },
      { kind: 'screen', id: newId(), label: 'Screen 1', z: 297.2 },
    ],
    glasses: {},
  };
}
