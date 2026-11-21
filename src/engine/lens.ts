import { inRange, refractiveIndex } from './glass';
import { intersect, refract } from './surface';
import type {
  Abcd,
  CatalogueLens,
  GlassLookup,
  LensPrescription,
  Ray,
  TraceWarning,
} from './types';

export interface InteractionResult {
  ray: Ray | null;
  points: [number, number][];
  warnings: TraceWarning[];
}

/** Element placement: origin (z, decentre), tilted about the local axial point `pivotZ`. */
export interface Placement {
  z: number;
  decentreMm: number;
  tiltDeg: number;
  pivotZ: number;
}

function placementOf(lens: CatalogueLens, prescription: LensPrescription): Placement {
  return { z: lens.z, decentreMm: lens.decentreMm, tiltDeg: lens.tiltDeg, pivotZ: lensThickness(prescription) / 2 };
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
      asphere: s.asphere.map((a) => -a),
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

/** Where the ray's line meets the element's entry plane (local z = 0), in world coordinates. */
export function entryPlanePoint(ray: Ray, pl: Placement): [number, number] {
  const local = toLocal(ray, pl);
  const t = local.dz === 0 ? 0 : (0 - local.z) / local.dz;
  const w = fromLocal({ ...local, z: 0, y: local.y + t * local.dy }, pl);
  return [w.z, w.y];
}

export function traceLens(lens: CatalogueLens, ray: Ray, glasses: GlassLookup): InteractionResult {
  const prescription = lens.flipped ? flipPrescription(lens.prescription) : lens.prescription;
  const surfaces = prescription.surfaces;
  for (const s of surfaces) {
    if (s.glassAfter !== null && !glasses(s.glassAfter)) {
      return {
        ray: null,
        points: [entryPlanePoint(ray, placementOf(lens, prescription))],
        warnings: [{ kind: 'unknown-glass', opticId: lens.id, glass: s.glassAfter }],
      };
    }
  }

  const placement = placementOf(lens, prescription);
  const points: [number, number][] = [];
  const warnings: TraceWarning[] = [];
  let local: Ray | null = toLocal(ray, placement);
  let vertexZ = 0;
  let n1 = 1;
  for (const s of surfaces) {
    const hit = intersect(s, vertexZ, local);
    if (!hit) {
      if (points.length === 0) points.push(entryPlanePoint(ray, placement));
      return { ray: null, points, warnings };
    }
    const w = fromLocal({ ...local, z: hit.z, y: hit.y }, placement);
    points.push([w.z, w.y]);
    let n2 = 1;
    if (s.glassAfter !== null) {
      const glass = glasses(s.glassAfter)!;
      n2 = refractiveIndex(glass, ray.wavelengthNm);
      if (!inRange(glass, ray.wavelengthNm) && !warnings.some((w) => w.kind === 'glass-extrapolated' && w.glass === glass.name)) {
        warnings.push({ kind: 'glass-extrapolated', glass: glass.name, wavelengthNm: ray.wavelengthNm });
      }
    }
    local = refract(local, hit, n1, n2);
    if (!local) return { ray: null, points, warnings };
    n1 = n2;
    vertexZ += s.thicknessToNextMm;
  }
  return { ray: fromLocal(local, placement), points, warnings };
}

const multiply = (a: Abcd, b: Abcd): Abcd => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
];

/** Paraxial matrix from first vertex to last vertex, air on both sides (asphere and conic terms ignored). */
export function lensAbcd(lens: CatalogueLens, wavelengthNm: number, glasses: GlassLookup): Abcd {
  const surfaces = (lens.flipped ? flipPrescription(lens.prescription) : lens.prescription).surfaces;
  let m: Abcd = [1, 0, 0, 1];
  let n1 = 1;
  surfaces.forEach((s, i) => {
    const glass = s.glassAfter === null ? undefined : glasses(s.glassAfter);
    const n2 = glass ? refractiveIndex(glass, wavelengthNm) : 1;
    m = multiply([1, 0, ((n1 - n2) * s.curvature) / n2, n1 / n2], m);
    if (i < surfaces.length - 1) m = multiply([1, s.thicknessToNextMm, 0, 1], m);
    n1 = n2;
  });
  return m;
}
