import { makeGlassLookup } from './glass';
import { opticExtent, interactOptic } from './optic';
import type {
  GlassData,
  GlassLookup,
  Optic,
  Ray,
  RayPath,
  Setup,
  SetupTrace,
  Source,
  TraceWarning,
} from './types';

const DEFAULT_CONE_DEG = 5;
const MIN_TAIL_MM = 50;
const EMPTY_TAIL_MM = 100;
const TAIL_FRACTION = 0.3;
const radians = (deg: number) => (deg * Math.PI) / 180;

function sortedByAxialStart(optics: Optic[]): Optic[] {
  return optics
    .map((optic, index) => ({ optic, index, start: opticExtent(optic)[0] }))
    .sort((a, b) => a.start - b.start || a.index - b.index)
    .map((e) => e.optic);
}

function isSorted(optics: Optic[]): boolean {
  for (let i = 1; i < optics.length; i++) {
    if (opticExtent(optics[i]!)[0] < opticExtent(optics[i - 1]!)[0]) return false;
  }
  return true;
}

/** Half-height of the clear aperture and its decentre, for aiming 'fill' rays. */
function apertureEdges(o: Optic): [number, number] | null {
  switch (o.kind) {
    case 'lens': {
      const surfaces = o.prescription.surfaces;
      const first = o.flipped ? surfaces[surfaces.length - 1] : surfaces[0];
      return first ? [o.decentreMm - first.semiDiameterMm, o.decentreMm + first.semiDiameterMm] : null;
    }
    case 'ideal':
    case 'slm':
      return [o.decentreMm - o.apertureMm / 2, o.decentreMm + o.apertureMm / 2];
    case 'aperture':
      return [o.decentreMm - o.diameterMm / 2, o.decentreMm + o.diameterMm / 2];
    case 'screen':
      return null;
  }
}

function unitRay(y: number, z: number, angleRad: number, wavelengthNm: number): Ray {
  return { z, y, dz: Math.cos(angleRad), dy: Math.sin(angleRad), wavelengthNm };
}

function spread(count: number, lo: number, hi: number): number[] {
  if (count <= 1) return [(lo + hi) / 2];
  return Array.from({ length: count }, (_, i) => lo + ((hi - lo) * i) / (count - 1));
}

export function launchRays(source: Source, optics: Optic[], wavelengthNm: number): Ray[] {
  switch (source.kind) {
    case 'gaussian':
      return [unitRay(source.y, source.z, radians(source.angleDeg), wavelengthNm)];
    case 'collimated': {
      const angle = radians(source.angleDeg);
      const half = source.widthMm / 2;
      return spread(source.rayCount, -half, half).map((offset) => ({
        z: source.z - offset * Math.sin(angle),
        y: source.y + offset * Math.cos(angle),
        dz: Math.cos(angle),
        dy: Math.sin(angle),
        wavelengthNm,
      }));
    }
    case 'point': {
      let lo = -radians(DEFAULT_CONE_DEG);
      let hi = radians(DEFAULT_CONE_DEG);
      if (source.coneHalfAngleDeg !== 'fill') {
        hi = radians(source.coneHalfAngleDeg);
        lo = -hi;
      } else {
        const first = sortedByAxialStart(optics.filter((o) => opticExtent(o)[0] >= source.z))[0];
        const edges = first && apertureEdges(first);
        const distance = first ? first.z - source.z : 0;
        if (edges && distance > 0) {
          lo = Math.atan2(edges[0] - source.y, distance);
          hi = Math.atan2(edges[1] - source.y, distance);
        }
      }
      return spread(source.rayCount, lo, hi).map((a) => unitRay(source.y, source.z, a, wavelengthNm));
    }
  }
}

export function traceRay(ray: Ray, optics: Optic[], glasses: GlassLookup, endZ: number): RayPath {
  return traceRayCollecting(ray, optics, glasses, endZ, undefined);
}

function traceRayCollecting(
  start: Ray,
  optics: Optic[],
  glasses: GlassLookup,
  endZ: number,
  onWarning: ((w: TraceWarning) => void) | undefined,
): RayPath {
  const ordered = isSorted(optics) ? optics : sortedByAxialStart(optics);
  const points: [number, number][] = [[start.z, start.y]];
  let ray = start;
  for (const optic of ordered) {
    const result = interactOptic(optic, ray, glasses);
    for (const w of result.warnings) onWarning?.(w);
    for (const p of result.points) points.push(p);
    if (!result.ray) {
      return { wavelengthNm: start.wavelengthNm, points, blockedBy: optic.id, final: null };
    }
    ray = result.ray;
  }
  if (ray.dz > 0 && endZ > ray.z) {
    points.push([endZ, ray.y + ((endZ - ray.z) / ray.dz) * ray.dy]);
  }
  return { wavelengthNm: start.wavelengthNm, points, blockedBy: null, final: ray };
}

function overlapWarnings(optics: Optic[]): TraceWarning[] {
  const ordered = sortedByAxialStart(optics);
  const warnings: TraceWarning[] = [];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const [aStart, aEnd] = opticExtent(ordered[i]!);
      const [bStart, bEnd] = opticExtent(ordered[j]!);
      const aThin = aStart === aEnd;
      const bThin = bStart === bEnd;
      let overlaps = false;
      if (!aThin && !bThin) overlaps = Math.min(aEnd, bEnd) - Math.max(aStart, bStart) > 0;
      else if (aThin && !bThin) overlaps = aStart > bStart && aStart < bEnd;
      else if (bThin && !aThin) overlaps = bStart > aStart && bStart < aEnd;
      if (overlaps) warnings.push({ kind: 'overlap', ids: [ordered[i]!.id, ordered[j]!.id] });
    }
  }
  return warnings;
}

const lookupCache = new WeakMap<Record<string, GlassData>, GlassLookup>();
function lookupFor(glasses: Record<string, GlassData>): GlassLookup {
  let lookup = lookupCache.get(glasses);
  if (!lookup) {
    lookup = makeGlassLookup(glasses);
    lookupCache.set(glasses, lookup);
  }
  return lookup;
}

function defaultEndZ(setup: Setup): number {
  if (setup.optics.length === 0) {
    return setup.sources.length ? Math.max(...setup.sources.map((s) => s.z)) + EMPTY_TAIL_MM : EMPTY_TAIL_MM;
  }
  const extents = setup.optics.map(opticExtent);
  const starts = [...setup.sources.map((s) => s.z), ...extents.map((e) => e[0])];
  const ends = [...setup.sources.map((s) => s.z), ...extents.map((e) => e[1])];
  const first = Math.min(...starts);
  const last = Math.max(...ends);
  return last + Math.max(TAIL_FRACTION * (last - first), MIN_TAIL_MM);
}

export function traceSetup(setup: Setup, endZ?: number): SetupTrace {
  const glasses = lookupFor(setup.glasses);
  const end = endZ ?? defaultEndZ(setup);
  const warnings = overlapWarnings(setup.optics);
  const seen = new Set<string>();
  const collect = (w: TraceWarning) => {
    const key = JSON.stringify(w);
    if (seen.has(key)) return;
    seen.add(key);
    warnings.push(w);
  };

  const sources = setup.sources.map((source) => {
    const ahead = sortedByAxialStart(setup.optics.filter((o) => opticExtent(o)[0] >= source.z));
    return {
      sourceId: source.id,
      byWavelength: source.wavelengthsNm.map((wavelengthNm) => ({
        wavelengthNm,
        rays: launchRays(source, ahead, wavelengthNm).map((ray) =>
          traceRayCollecting(ray, ahead, glasses, end, collect),
        ),
      })),
    };
  });
  return { sources, warnings, endZ: end };
}
