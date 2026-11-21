import { entryPlanePoint, fromLocal, lensAbcd, lensThickness, toLocal, traceLens, type InteractionResult } from './lens';
import { slmAbcd, slmHitHeight, traceSlm } from './slm';
import type { Abcd, GlassLookup, Optic, Ray } from './types';

/** Axial [start, end] of an element, ignoring tilt. */
export function opticExtent(o: Optic): [number, number] {
  return o.kind === 'lens' ? [o.z, o.z + lensThickness(o.prescription)] : [o.z, o.z];
}

function planeHit(ray: Ray, planeZ: number): Ray | null {
  if (ray.dz <= 0) return null;
  const t = (planeZ - ray.z) / ray.dz;
  return { ...ray, z: planeZ, y: ray.y + t * ray.dy };
}

function blocked(at: Ray): InteractionResult {
  return { ray: null, points: [[at.z, at.y]], warnings: [] };
}

/** Where a backward-travelling ray's line meets the plane. */
function lineHit(ray: Ray, planeZ: number): Ray {
  const t = ray.dz === 0 ? 0 : (planeZ - ray.z) / ray.dz;
  return { ...ray, z: planeZ, y: ray.y + t * ray.dy };
}

export function interactOptic(o: Optic, ray: Ray, glasses: GlassLookup): InteractionResult {
  switch (o.kind) {
    case 'lens':
      return traceLens(o, ray, glasses);
    case 'slm':
      return traceSlm(o, ray);
    case 'screen': {
      const hit = planeHit(ray, o.z);
      return hit ? { ray: hit, points: [[hit.z, hit.y]], warnings: [] } : blocked(lineHit(ray, o.z));
    }
    case 'aperture': {
      const hit = planeHit(ray, o.z);
      if (!hit) return blocked(lineHit(ray, o.z));
      if (Math.abs(hit.y - o.decentreMm) > o.diameterMm / 2) return blocked(hit);
      return { ray: hit, points: [[hit.z, hit.y]], warnings: [] };
    }
    case 'ideal': {
      const placement = { z: o.z, decentreMm: o.decentreMm, tiltDeg: o.tiltDeg, pivotZ: 0 };
      const local = toLocal(ray, placement);
      const hit = planeHit(local, 0);
      if (!hit) return { ray: null, points: [entryPlanePoint(ray, placement)], warnings: [] };
      const world = fromLocal(hit, placement);
      if (Math.abs(hit.y) > o.apertureMm / 2) return blocked(world);
      const slope = local.dy / local.dz - hit.y / o.focalLengthMm;
      const norm = Math.hypot(1, slope);
      const out = fromLocal({ ...hit, dz: 1 / norm, dy: slope / norm }, placement);
      return { ray: out, points: [[out.z, out.y]], warnings: [] };
    }
  }
}

/** Paraxial matrix of an element at local hit height yHit (only an SLM depends on it). */
export function opticAbcd(o: Optic, wavelengthNm: number, yHit: number, glasses: GlassLookup): Abcd {
  switch (o.kind) {
    case 'lens':
      return lensAbcd(o, wavelengthNm, glasses);
    case 'slm':
      return slmAbcd(o, yHit, wavelengthNm);
    case 'ideal':
      return [1, 0, -1 / o.focalLengthMm, 1];
    case 'aperture':
    case 'screen':
      return [1, 0, 0, 1];
  }
}

/** Height at which a ray meets the element's local frame, for evaluating its ABCD. */
export function localHitHeight(o: Optic, ray: Ray): number {
  if (o.kind === 'slm') return slmHitHeight(o, ray);
  return 0;
}
