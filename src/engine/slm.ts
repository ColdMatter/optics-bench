import { entryPlanePoint, fromLocal, toLocal, type InteractionResult, type Placement } from './lens';
import type { Abcd, PhaseTerm, Ray, Slm } from './types';

const NM_TO_MM = 1e-6;

function tableDerivatives(yMm: number[], phaseRad: number[]): number[] {
  const n = yMm.length;
  return yMm.map((_, i) => {
    const lo = Math.max(i - 1, 0);
    const hi = Math.min(i + 1, n - 1);
    return hi === lo ? 0 : (phaseRad[hi]! - phaseRad[lo]!) / (yMm[hi]! - yMm[lo]!);
  });
}

/** Index of the table interval containing y, clamped to the ends. */
function interval(yMm: number[], y: number): number {
  let i = 0;
  while (i < yMm.length - 2 && y > yMm[i + 1]!) i++;
  return i;
}

function termGradient(term: PhaseTerm, slm: Slm, y: number): number {
  const lambda0 = slm.designWavelengthNm * NM_TO_MM;
  switch (term.kind) {
    case 'fresnel':
      return (-2 * Math.PI * y) / (lambda0 * term.focalLengthMm);
    case 'blaze':
      return (2 * Math.PI * Math.sin((term.angleDeg * Math.PI) / 180)) / lambda0;
    case 'polynomial': {
      const r = slm.apertureMm / 2;
      return term.coefficientsRad.reduce((sum, a, i) => sum + (a * (i + 1) * (y / r) ** i) / r, 0);
    }
    case 'table': {
      if (term.yMm.length < 2) return 0;
      const d = tableDerivatives(term.yMm, term.phaseRad);
      const i = interval(term.yMm, y);
      const t = (y - term.yMm[i]!) / (term.yMm[i + 1]! - term.yMm[i]!);
      return d[i]! + Math.min(Math.max(t, 0), 1) * (d[i + 1]! - d[i]!);
    }
  }
}

function termCurvature(term: PhaseTerm, slm: Slm, y: number): number {
  const lambda0 = slm.designWavelengthNm * NM_TO_MM;
  switch (term.kind) {
    case 'fresnel':
      return (-2 * Math.PI) / (lambda0 * term.focalLengthMm);
    case 'blaze':
      return 0;
    case 'polynomial': {
      const r = slm.apertureMm / 2;
      return term.coefficientsRad.reduce((sum, a, i) => (i === 0 ? sum : sum + (a * (i + 1) * i * (y / r) ** (i - 1)) / (r * r)), 0);
    }
    case 'table': {
      if (term.yMm.length < 2) return 0;
      const d = tableDerivatives(term.yMm, term.phaseRad);
      const i = interval(term.yMm, y);
      return (d[i + 1]! - d[i]!) / (term.yMm[i + 1]! - term.yMm[i]!);
    }
  }
}

/** dφ0/dy (rad/mm) of the design phase at local height y. */
export function slmPhaseGradient(slm: Slm, y: number): number {
  return slm.phase.reduce((sum, t) => sum + termGradient(t, slm, y), 0);
}

/** d²φ0/dy² (rad/mm²) of the design phase at local height y. */
export function slmPhaseCurvature(slm: Slm, y: number): number {
  return slm.phase.reduce((sum, t) => sum + termCurvature(t, slm, y), 0);
}

const placementOf = (slm: Slm): Placement => ({ z: slm.z, decentreMm: slm.decentreMm, tiltDeg: slm.tiltDeg, pivotZ: 0 });

export function traceSlm(slm: Slm, ray: Ray): InteractionResult {
  const placement = placementOf(slm);
  const local = toLocal(ray, placement);
  if (local.dz <= 0) return { ray: null, points: [entryPlanePoint(ray, placement)], warnings: [] };
  const t = -local.z / local.dz;
  const hit: Ray = { ...local, z: 0, y: local.y + t * local.dy };
  const world = fromLocal(hit, placement);
  const blockedAtHit: InteractionResult = { ray: null, points: [[world.z, world.y]], warnings: [] };
  if (Math.abs(hit.y) > slm.apertureMm / 2) return blockedAtHit;

  const gradient = slmPhaseGradient(slm, hit.y);
  if (Math.abs(gradient) * slm.pixelPitchUm * 1e-3 > Math.PI) {
    return { ...blockedAtHit, warnings: [{ kind: 'slm-pitch-limit', opticId: slm.id }] };
  }
  const sinOut = hit.dy + ((ray.wavelengthNm * NM_TO_MM) / (2 * Math.PI)) * gradient;
  if (Math.abs(sinOut) >= 1) return blockedAtHit;
  const out = fromLocal({ ...hit, dy: sinOut, dz: Math.sqrt(1 - sinOut * sinOut) }, placement);
  return { ray: out, points: [[out.z, out.y]], warnings: [] };
}

/** Local hit height of a ray on the SLM plane (for ABCD evaluation). */
export function slmHitHeight(slm: Slm, ray: Ray): number {
  const local = toLocal(ray, placementOf(slm));
  return local.y + (-local.z / local.dz) * local.dy;
}

export function slmAbcd(slm: Slm, yHit: number, wavelengthNm: number): Abcd {
  return [1, 0, ((wavelengthNm * NM_TO_MM) / (2 * Math.PI)) * slmPhaseCurvature(slm, yHit), 1];
}
