import { radiusAt, traceGaussian } from './gaussian';
import { opticExtent } from './optic';
import { defaultEndZ, launchRays, lookupFor, sortedByAxialStart, traceRayCollecting } from './trace';
import type { GlassLookup, Id, Optic, Ray, Screen, Setup, Source, SourceTrace } from './types';

export interface FocusResult {
  wavelengthNm: number;
  status: 'ok' | 'collimated' | 'no-rays';
  paraxialZ: number | null;
  bestZ: number | null;
  rmsAtBestMm: number | null;
  imageHeightMm: number | null;
  approximate: boolean;
}
export interface ScreenSpot {
  wavelengthNm: number;
  heightsMm: number[];
  centroidMm: number | null;
  rmsMm: number | null;
}

const PARAXIAL_ANGLE_RAD = 1e-4;
const PARAXIAL_OFFSET_MM = 1e-3;
const PARALLEL_TOLERANCE = 1e-12;

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

function rmsAbout(values: number[], centre: number): number {
  return Math.sqrt(mean(values.map((v) => (v - centre) ** 2)));
}

/** The ray bisecting the launched fan, and the pair of rays straddling it. */
function paraxialPair(source: Source, optics: Optic[], wavelengthNm: number): [Ray, Ray] | null {
  if (source.kind === 'gaussian') return null;
  const fan = launchRays(source, optics, wavelengthNm);
  const first = fan[0]!;
  const last = fan[fan.length - 1]!;
  if (source.kind === 'point') {
    const centre = (Math.atan2(first.dy, first.dz) + Math.atan2(last.dy, last.dz)) / 2;
    return [-PARAXIAL_ANGLE_RAD, PARAXIAL_ANGLE_RAD].map((delta) => ({
      z: source.z,
      y: source.y,
      dz: Math.cos(centre + delta),
      dy: Math.sin(centre + delta),
      wavelengthNm,
    })) as [Ray, Ray];
  }
  const angle = (source.angleDeg * Math.PI) / 180;
  return [-PARAXIAL_OFFSET_MM, PARAXIAL_OFFSET_MM].map((offset) => ({
    z: source.z - offset * Math.sin(angle),
    y: source.y + offset * Math.cos(angle),
    dz: Math.cos(angle),
    dy: Math.sin(angle),
    wavelengthNm,
  })) as [Ray, Ray];
}

function intersectionZ(a: Ray, b: Ray): number | null {
  const slopeA = a.dy / a.dz;
  const slopeB = b.dy / b.dz;
  if (Math.abs(slopeA - slopeB) < PARALLEL_TOLERANCE) return null;
  const interceptA = a.y - slopeA * a.z;
  const interceptB = b.y - slopeB * b.z;
  return (interceptB - interceptA) / (slopeA - slopeB);
}

function focusAt(
  source: Source,
  optics: Optic[],
  glasses: GlassLookup,
  wavelengthNm: number,
): FocusResult {
  let approximate = false;
  const traceFinal = (ray: Ray): Ray | null => {
    let usesDrawing = false;
    const path = traceRayCollecting(ray, optics, glasses, ray.z, undefined, (optic, _in, result) => {
      if (optic.kind === 'lens' && result.ray && optic.prescription.source === 'drawing') usesDrawing = true;
    });
    if (path.final && usesDrawing) approximate = true;
    return path.final;
  };

  const survivors = launchRays(source, optics, wavelengthNm)
    .map(traceFinal)
    .filter((r): r is Ray => r !== null);

  const pair = paraxialPair(source, optics, wavelengthNm)?.map(traceFinal);
  const pairSurvived = pair && pair[0] && pair[1];
  const paraxialZ = pairSurvived ? intersectionZ(pair[0]!, pair[1]!) : null;

  let bestZ: number | null = null;
  let rmsAtBestMm: number | null = null;
  let imageHeightMm: number | null = null;
  let fanParallel = false;
  if (survivors.length >= 2) {
    const slopes = survivors.map((r) => r.dy / r.dz);
    const intercepts = survivors.map((r, i) => r.y - slopes[i]! * r.z);
    const meanSlope = mean(slopes);
    const meanIntercept = mean(intercepts);
    const varSlope = mean(slopes.map((m) => (m - meanSlope) ** 2));
    const cov = mean(slopes.map((m, i) => (m - meanSlope) * (intercepts[i]! - meanIntercept)));
    if (varSlope < PARALLEL_TOLERANCE) {
      fanParallel = true;
    } else {
      bestZ = -cov / varSlope;
      const heights = survivors.map((_, i) => intercepts[i]! + slopes[i]! * bestZ!);
      rmsAtBestMm = rmsAbout(heights, mean(heights));
      imageHeightMm = mean(heights);
    }
  }

  const pairParallel = Boolean(pairSurvived) && paraxialZ === null;
  const status =
    bestZ !== null || paraxialZ !== null ? 'ok' : fanParallel || pairParallel ? 'collimated' : 'no-rays';
  return { wavelengthNm, status, paraxialZ, bestZ, rmsAtBestMm, imageHeightMm, approximate };
}

function opticsAhead(setup: Setup, source: Source): Optic[] {
  return sortedByAxialStart(setup.optics.filter((o) => opticExtent(o)[0] >= source.z));
}

export function focusPerWavelength(setup: Setup, sourceId: Id): FocusResult[] {
  const source = setup.sources.find((s) => s.id === sourceId);
  if (!source || source.kind === 'gaussian') return [];
  const glasses = lookupFor(setup.glasses);
  const ahead = opticsAhead(setup, source);
  return source.wavelengthsNm.map((nm) => focusAt(source, ahead, glasses, nm));
}

export function focusShiftCurve(
  setup: Setup,
  sourceId: Id,
  minNm: number,
  maxNm: number,
  steps: number,
): { wavelengthNm: number; paraxialZ: number | null }[] {
  const source = setup.sources.find((s) => s.id === sourceId);
  if (!source || source.kind === 'gaussian') return [];
  const glasses = lookupFor(setup.glasses);
  const ahead = opticsAhead(setup, source);
  return Array.from({ length: steps }, (_, i) => {
    const wavelengthNm = steps === 1 ? minNm : minNm + ((maxNm - minNm) * i) / (steps - 1);
    return { wavelengthNm, paraxialZ: focusAt(source, ahead, glasses, wavelengthNm).paraxialZ };
  });
}

export function screenStats(trace: SourceTrace, screenId: Id): ScreenSpot[] {
  return trace.byWavelength.map(({ wavelengthNm, rays }) => {
    const heightsMm = rays.flatMap((r) => (r.screenHits?.[screenId] !== undefined ? [r.screenHits[screenId]!] : []));
    if (heightsMm.length === 0) return { wavelengthNm, heightsMm, centroidMm: null, rmsMm: null };
    const centroidMm = mean(heightsMm);
    return { wavelengthNm, heightsMm, centroidMm, rmsMm: rmsAbout(heightsMm, centroidMm) };
  });
}

/**
 * Magnification from a source to a screen at one wavelength. `no-rays`: nothing usable reaches
 * the screen. `edge-ray-blocked`: a collimated beam lost an edge ray. `undefined`: a collimated
 * beam with zero width or a single ray has no width to compare.
 */
export type Magnification =
  | { wavelengthNm: number; value: number }
  | { wavelengthNm: number; value: null; reason: 'no-rays' | 'edge-ray-blocked' | 'undefined' };

// Measured flat to 8–9 significant figures between 1e-3 and 1e-6 mm on a 4f relay and an
// f ≈ 12 mm asphere; truncation shows at 1e-2 and rounding at 1e-7.
const MAGNIFICATION_STEP_MM = 1e-5;
const MIN_MAGNIFICATION_STEP_MM = 1e-7;

/** For each screen, the height at which each ray of the source's fan meets it (null where it doesn't). */
function fanScreenHeights(
  source: Source,
  ahead: Optic[],
  glasses: GlassLookup,
  wavelengthNm: number,
  screens: Screen[],
): Map<Id, (number | null)[]> {
  const paths = launchRays(source, ahead, wavelengthNm).map((ray) => traceRayCollecting(ray, ahead, glasses, ray.z, undefined));
  return new Map(screens.map((screen) => [screen.id, paths.map((p) => p.screenHits?.[screen.id] ?? null)]));
}

const centroidOf = (heights: (number | null)[], indices: number[]) => mean(indices.map((i) => heights[i]!));

/**
 * Point source: dy′/dy of the spot centroid. The rays are those that reach the screen from the
 * source as placed; the source is moved by ±δ and the same rays' centroid compared. If one of them
 * is lost at ±δ (it passes within δ of a clipping edge), δ is halved; below the minimum it is
 * dropped. Rays that only reach the screen at ±δ are ignored.
 */
function pointMagnification(
  source: Source,
  ahead: Optic[],
  glasses: GlassLookup,
  wavelengthNm: number,
  screens: Screen[],
): Map<Id, Magnification> {
  const heightsAt = (y: number) => fanScreenHeights({ ...source, y }, ahead, glasses, wavelengthNm, screens);
  const base = heightsAt(source.y);
  const results = new Map<Id, Magnification>();
  const pending = new Map<Id, number[]>();
  for (const screen of screens) {
    const indices = base.get(screen.id)!.flatMap((h, i) => (h === null ? [] : [i]));
    if (indices.length === 0) results.set(screen.id, { wavelengthNm, value: null, reason: 'no-rays' });
    else pending.set(screen.id, indices);
  }
  let last: { step: number; lo: Map<Id, (number | null)[]>; hi: Map<Id, (number | null)[]> } | null = null;
  for (let step = MAGNIFICATION_STEP_MM; pending.size > 0 && step >= MIN_MAGNIFICATION_STEP_MM; step /= 2) {
    const lo = heightsAt(source.y - step);
    const hi = heightsAt(source.y + step);
    for (const [id, indices] of pending) {
      const l = lo.get(id)!;
      const u = hi.get(id)!;
      if (indices.every((i) => l[i] !== null && u[i] !== null)) {
        results.set(id, { wavelengthNm, value: (centroidOf(u, indices) - centroidOf(l, indices)) / (2 * step) });
        pending.delete(id);
      }
    }
    last = { step, lo, hi };
  }
  for (const [id, indices] of pending) {
    const l = last!.lo.get(id)!;
    const u = last!.hi.get(id)!;
    const kept = indices.filter((i) => l[i] !== null && u[i] !== null);
    results.set(
      id,
      kept.length === 0
        ? { wavelengthNm, value: null, reason: 'no-rays' }
        : { wavelengthNm, value: (centroidOf(u, kept) - centroidOf(l, kept)) / (2 * last!.step) },
    );
  }
  return results;
}

/** Collimated source: the signed separation of the two edge rays at the screen over the launch width. */
function collimatedMagnification(
  source: Source & { kind: 'collimated' },
  ahead: Optic[],
  glasses: GlassLookup,
  wavelengthNm: number,
  screens: Screen[],
): Map<Id, Magnification> {
  if (source.rayCount < 2 || source.widthMm === 0) {
    return new Map(screens.map((s) => [s.id, { wavelengthNm, value: null, reason: 'undefined' }]));
  }
  const heights = fanScreenHeights(source, ahead, glasses, wavelengthNm, screens);
  return new Map(
    screens.map((screen): [Id, Magnification] => {
      const hs = heights.get(screen.id)!;
      const first = hs[0];
      const last = hs[hs.length - 1];
      if (first == null || last == null) {
        const reason = hs.some((h) => h !== null) ? 'edge-ray-blocked' : 'no-rays';
        return [screen.id, { wavelengthNm, value: null, reason }];
      }
      return [screen.id, { wavelengthNm, value: (last - first) / source.widthMm }];
    }),
  );
}

/**
 * Magnification at every screen downstream of the source, per wavelength in the source's order.
 * Point: dy′/dy of the spot centroid (signed). Collimated: edge-ray separation over the launch width
 * (signed). Gaussian: w at the screen over w at the source plane (unsigned).
 */
export function screenMagnifications(setup: Setup, sourceId: Id): Map<Id, Magnification[]> {
  const source = setup.sources.find((s) => s.id === sourceId);
  const out = new Map<Id, Magnification[]>();
  if (!source) return out;
  const screens = setup.optics
    .filter((o): o is Screen => o.kind === 'screen' && o.z >= source.z)
    .sort((a, b) => a.z - b.z);
  if (screens.length === 0) return out;
  for (const screen of screens) out.set(screen.id, []);
  const glasses = lookupFor(setup.glasses);
  const ahead = opticsAhead(setup, source);
  for (const wavelengthNm of source.wavelengthsNm) {
    let byScreen: Map<Id, Magnification>;
    if (source.kind === 'point') {
      byScreen = pointMagnification(source, ahead, glasses, wavelengthNm, screens);
    } else if (source.kind === 'collimated') {
      byScreen = collimatedMagnification(source, ahead, glasses, wavelengthNm, screens);
    } else {
      const endZ = Math.max(defaultEndZ(setup), ...screens.map((s) => s.z));
      const beam = traceGaussian(source, setup.optics, wavelengthNm, glasses, endZ);
      const atSource = radiusAt(beam, source.z);
      byScreen = new Map(
        screens.map((screen): [Id, Magnification] => {
          const w = radiusAt(beam, screen.z);
          const ok = w !== null && atSource !== null && Number.isFinite(w) && atSource > 0;
          return [screen.id, ok ? { wavelengthNm, value: w / atSource } : { wavelengthNm, value: null, reason: 'no-rays' }];
        }),
      );
    }
    for (const screen of screens) out.get(screen.id)!.push(byScreen.get(screen.id)!);
  }
  return out;
}
