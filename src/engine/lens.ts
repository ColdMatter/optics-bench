import { inRange, refractiveIndex } from './glass';
import { intersect, refract } from './surface';
import type {
  CatalogueLens,
  GlassLookup,
  LensPrescription,
  Ray,
  TraceWarning,
} from './types';

export interface InteractionResult {
  ray: Ray | null;
  points: [number, number][];
  warning?: TraceWarning;
}

/** Element placement: origin (z, decentre), tilted about the local axial point `pivotZ`. */
export interface Placement {
  z: number;
  decentreMm: number;
  tiltDeg: number;
  pivotZ: number;
}

export function lensThickness(p: LensPrescription): number {
  return p.surfaces.reduce((sum, s) => sum + s.thicknessToNextMm, 0);
}

export function flipPrescription(p: LensPrescription): LensPrescription {
  const n = p.surfaces.length;
  const surfaces = p.surfaces.map((_, i) => {
    const s = p.surfaces[n - 1 - i]!;
    const last = i === n - 1;
    return {
      ...s,
      curvature: -s.curvature,
      asphere: [...s.asphere],
      thicknessToNextMm: last ? 0 : p.surfaces[n - 2 - i]!.thicknessToNextMm,
      glassAfter: last ? null : p.surfaces[n - 2 - i]!.glassAfter,
    };
  });
  return { ...p, surfaces };
}

export function toLocal(ray: Ray, pl: Placement): Ray {
  const rad = (pl.tiltDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const dz = ray.z - pl.z - pl.pivotZ;
  const dy = ray.y - pl.decentreMm;
  return {
    z: c * dz + s * dy + pl.pivotZ,
    y: -s * dz + c * dy,
    dz: c * ray.dz + s * ray.dy,
    dy: -s * ray.dz + c * ray.dy,
    wavelengthNm: ray.wavelengthNm,
  };
}

export function fromLocal(ray: Ray, pl: Placement): Ray {
  const rad = (pl.tiltDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const lz = ray.z - pl.pivotZ;
  return {
    z: pl.z + pl.pivotZ + c * lz - s * ray.y,
    y: pl.decentreMm + s * lz + c * ray.y,
    dz: c * ray.dz - s * ray.dy,
    dy: s * ray.dz + c * ray.dy,
    wavelengthNm: ray.wavelengthNm,
  };
}

export function traceLens(lens: CatalogueLens, ray: Ray, glasses: GlassLookup): InteractionResult {
  const prescription = lens.flipped ? flipPrescription(lens.prescription) : lens.prescription;
  const surfaces = prescription.surfaces;
  for (const s of surfaces) {
    if (s.glassAfter !== null && !glasses(s.glassAfter)) {
      return {
        ray: null,
        points: [],
        warning: { kind: 'unknown-glass', opticId: lens.id, glass: s.glassAfter },
      };
    }
  }

  const placement: Placement = {
    z: lens.z,
    decentreMm: lens.decentreMm,
    tiltDeg: lens.tiltDeg,
    pivotZ: lensThickness(prescription) / 2,
  };
  const points: [number, number][] = [];
  let warning: TraceWarning | undefined;
  let local: Ray | null = toLocal(ray, placement);
  let vertexZ = 0;
  let n1 = 1;
  for (const s of surfaces) {
    const hit = intersect(s, vertexZ, local);
    if (!hit) return { ray: null, points, ...(warning && { warning }) };
    const w = fromLocal({ ...local, z: hit.z, y: hit.y }, placement);
    points.push([w.z, w.y]);
    let n2 = 1;
    if (s.glassAfter !== null) {
      const glass = glasses(s.glassAfter)!;
      n2 = refractiveIndex(glass, ray.wavelengthNm);
      if (!warning && !inRange(glass, ray.wavelengthNm)) {
        warning = { kind: 'glass-extrapolated', glass: glass.name, wavelengthNm: ray.wavelengthNm };
      }
    }
    local = refract(local, hit, n1, n2);
    if (!local) return { ray: null, points, ...(warning && { warning }) };
    n1 = n2;
    vertexZ += s.thicknessToNextMm;
  }
  return { ray: fromLocal(local, placement), points, ...(warning && { warning }) };
}
