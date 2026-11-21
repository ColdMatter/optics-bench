import { opticExtent } from './optic';
import { launchRays, lookupFor, sortedByAxialStart, traceRayCollecting } from './trace';
import type { GlassLookup, Id, Optic, Ray, Setup, Source, SourceTrace } from './types';

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
