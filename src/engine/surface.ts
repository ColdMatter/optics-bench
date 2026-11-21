import type { Ray, SurfaceShape } from './types';

export interface SurfaceHit {
  z: number;
  y: number;
  normalZ: number;
  normalY: number;
}

const MAX_ITERATIONS = 20;
const TOLERANCE_MM = 1e-10;

/** Conic radicand 1 − (1 + k) c² y²; negative means the conic does not reach this height. */
function radicand(s: SurfaceShape, y: number): number {
  return 1 - (1 + s.conic) * s.curvature * s.curvature * y * y;
}

function asphereSag(s: SurfaceShape, y: number): number {
  let total = 0;
  for (let k = 0; k < s.asphere.length; k++) total += s.asphere[k]! * y ** (2 * k + 4);
  return total;
}

export function sag(s: SurfaceShape, y: number): number {
  const root = Math.sqrt(radicand(s, y));
  const base = s.curvature === 0 ? 0 : (s.curvature * y * y) / (1 + root);
  return base + asphereSag(s, y);
}

function sagSlope(s: SurfaceShape, y: number): number {
  let slope = (s.curvature * y) / Math.sqrt(radicand(s, y));
  for (let k = 0; k < s.asphere.length; k++) slope += (2 * k + 4) * s.asphere[k]! * y ** (2 * k + 3);
  return slope;
}

export function intersect(s: SurfaceShape, vertexZ: number, ray: Ray): SurfaceHit | null {
  if (ray.dz === 0) return null;
  let t = (vertexZ - ray.z) / ray.dz;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const y = ray.y + t * ray.dy;
    if (radicand(s, y) < 0) return null;
    const residual = ray.z + t * ray.dz - vertexZ - sag(s, y);
    if (Math.abs(residual) < TOLERANCE_MM) return t < -TOLERANCE_MM ? null : finishHit(s, ray, t);
    const slope = ray.dz - sagSlope(s, y) * ray.dy;
    if (slope === 0) return null;
    t -= residual / slope;
  }
  return null;
}

function finishHit(s: SurfaceShape, ray: Ray, t: number): SurfaceHit | null {
  const y = ray.y + t * ray.dy;
  if (Math.abs(y) > s.semiDiameterMm) return null;
  const slope = sagSlope(s, y);
  const norm = Math.hypot(1, slope);
  return { z: ray.z + t * ray.dz, y, normalZ: 1 / norm, normalY: -slope / norm };
}

export function refract(ray: Ray, hit: SurfaceHit, n1: number, n2: number): Ray | null {
  let { normalZ, normalY } = hit;
  let cosIncidence = -(normalZ * ray.dz + normalY * ray.dy);
  if (cosIncidence < 0) {
    normalZ = -normalZ;
    normalY = -normalY;
    cosIncidence = -cosIncidence;
  }
  const eta = n1 / n2;
  const radicandT = 1 - eta * eta * (1 - cosIncidence * cosIncidence);
  if (radicandT < 0) return null;
  const k = eta * cosIncidence - Math.sqrt(radicandT);
  return {
    z: hit.z,
    y: hit.y,
    dz: eta * ray.dz + k * normalZ,
    dy: eta * ray.dy + k * normalY,
    wavelengthNm: ray.wavelengthNm,
  };
}
