import { fromLocal, lensThickness, toLocal, traceLens, type InteractionResult } from './lens';
import type { GlassLookup, Optic, Ray } from './types';

/** Axial [start, end] of an element, ignoring tilt. */
export function opticExtent(o: Optic): [number, number] {
  return o.kind === 'lens' ? [o.z, o.z + lensThickness(o.prescription)] : [o.z, o.z];
}

function planeHit(ray: Ray, planeZ: number): Ray | null {
  if (ray.dz <= 0) return null;
  const t = (planeZ - ray.z) / ray.dz;
  return { ...ray, z: planeZ, y: ray.y + t * ray.dy };
}

function blocked(at: Ray | null): InteractionResult {
  return { ray: null, points: at ? [[at.z, at.y]] : [] };
}

export function interactOptic(o: Optic, ray: Ray, glasses: GlassLookup): InteractionResult {
  switch (o.kind) {
    case 'lens':
      return traceLens(o, ray, glasses);
    case 'slm':
      throw new Error('SLM tracing arrives in Task 4');
    case 'screen': {
      const hit = planeHit(ray, o.z);
      return hit ? { ray: hit, points: [[hit.z, hit.y]] } : blocked(null);
    }
    case 'aperture': {
      const hit = planeHit(ray, o.z);
      if (!hit) return blocked(null);
      if (Math.abs(hit.y - o.decentreMm) > o.diameterMm / 2) return blocked(hit);
      return { ray: hit, points: [[hit.z, hit.y]] };
    }
    case 'ideal': {
      const placement = { z: o.z, decentreMm: o.decentreMm, tiltDeg: o.tiltDeg, pivotZ: 0 };
      const local = toLocal(ray, placement);
      const hit = planeHit(local, 0);
      if (!hit) return blocked(null);
      const world = fromLocal(hit, placement);
      if (Math.abs(hit.y) > o.apertureMm / 2) return blocked(world);
      const slope = local.dy / local.dz - hit.y / o.focalLengthMm;
      const norm = Math.hypot(1, slope);
      const out = fromLocal({ ...hit, dz: 1 / norm, dy: slope / norm }, placement);
      return { ray: out, points: [[out.z, out.y]] };
    }
  }
}
