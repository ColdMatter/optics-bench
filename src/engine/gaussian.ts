import { cadd, cdiv, cmul, type Complex } from './complex';
import { localHitHeight, opticAbcd, opticExtent } from './optic';
import { launchRays, sortedByAxialStart, traceRayCollecting } from './trace';
import type {
  GaussianSegment,
  GaussianSource,
  GaussianTrace,
  GaussianWarning,
  GlassLookup,
  Optic,
  Ray,
  Setup,
  Waist,
} from './types';
import type { InteractionResult } from './lens';
import { makeGlassLookup } from './glass';

const NM_TO_MM = 1e-6;
const COLLIMATED_RAYLEIGH_MM = 1e5;
const CLIP_FRACTION = 0.8;
const TILT_LIMIT_DEG = 3;

const effectiveWavelengthMm = (wavelengthNm: number, m2: number) => m2 * wavelengthNm * NM_TO_MM;

/** w² = (M²λ/π) / Im(−1/q) */
function radiusFromQ(q: Complex, lambdaEffMm: number): number {
  const inv = cdiv({ re: -1, im: 0 }, q);
  return Math.sqrt(lambdaEffMm / Math.PI / inv.im);
}

function applyAbcd(q: Complex, [a, b, c, d]: [number, number, number, number]): Complex {
  return cdiv(cadd(cmul({ re: a, im: 0 }, q), { re: b, im: 0 }), cadd(cmul({ re: c, im: 0 }, q), { re: d, im: 0 }));
}

function clearApertureMm(o: Optic): number {
  switch (o.kind) {
    case 'lens':
      return 2 * Math.min(...o.prescription.surfaces.map((s) => s.semiDiameterMm));
    case 'ideal':
    case 'slm':
      return o.apertureMm;
    case 'aperture':
      return o.diameterMm;
    case 'screen':
      return Infinity;
  }
}

const hasPower = (o: Optic) => o.kind === 'lens' || o.kind === 'ideal' || o.kind === 'slm';

export function traceGaussian(
  source: GaussianSource,
  optics: Optic[],
  wavelengthNm: number,
  glasses: GlassLookup,
  endZ: number,
): GaussianTrace {
  const lambdaEff = effectiveWavelengthMm(wavelengthNm, source.m2);
  const rayleigh = (Math.PI * source.waistRadiusMm ** 2) / lambdaEff;
  const ahead = sortedByAxialStart(optics.filter((o) => opticExtent(o)[0] >= source.z));
  const start = launchRays(source, ahead, wavelengthNm)[0]!;

  const visits: { optic: Optic; rayIn: Ray; result: InteractionResult }[] = [];
  const centre = traceRayCollecting(start, ahead, glasses, endZ, undefined, (optic, rayIn, result) =>
    visits.push({ optic, rayIn, result }),
  );

  const segments: GaussianSegment[] = [];
  const waists: Waist[] = [
    { afterOpticId: null, z: source.waistZ, radiusMm: source.waistRadiusMm, collimated: rayleigh > COLLIMATED_RAYLEIGH_MM },
  ];
  const warnings: GaussianWarning[] = [];

  let q: Complex = { re: source.z - source.waistZ, im: rayleigh };
  let zPrev = source.z;
  let pointPrev: [number, number] = [start.z, start.y];
  let rayPrev: Ray = start;
  let stopped = false;
  for (const { optic, rayIn, result } of visits) {
    const [entryZ, exitZ] = opticExtent(optic);
    if (entryZ >= endZ) break;
    const entryPoint = result.points[0];
    if (entryPoint) {
      segments.push({ zStart: zPrev, zEnd: entryZ, qStart: q, centre: [pointPrev, entryPoint] });
    }
    q = { re: q.re + Math.max(entryZ - zPrev, 0), im: q.im };

    if (2 * radiusFromQ(q, lambdaEff) > CLIP_FRACTION * clearApertureMm(optic)) {
      warnings.push({ kind: 'clipped', opticId: optic.id });
    }
    if ('tiltDeg' in optic && Math.abs(optic.tiltDeg) > TILT_LIMIT_DEG) {
      warnings.push({ kind: 'tilted', opticId: optic.id });
    }
    if (!result.ray) {
      stopped = true;
      break;
    }
    rayPrev = result.ray;

    q = applyAbcd(q, opticAbcd(optic, wavelengthNm, localHitHeight(optic, rayIn), glasses));
    zPrev = exitZ;
    pointPrev = result.points[result.points.length - 1] ?? pointPrev;
    if (hasPower(optic)) {
      waists.push({
        afterOpticId: optic.id,
        z: exitZ - q.re,
        radiusMm: Math.sqrt((q.im * lambdaEff) / Math.PI),
        collimated: q.im > COLLIMATED_RAYLEIGH_MM,
      });
    }
  }

  if (!stopped && endZ > zPrev) {
    const endPoint: [number, number] = [endZ, rayPrev.y + ((endZ - rayPrev.z) / rayPrev.dz) * rayPrev.dy];
    segments.push({ zStart: zPrev, zEnd: endZ, qStart: q, centre: [pointPrev, endPoint] });
  }
  return { sourceId: source.id, wavelengthNm, m2: source.m2, centre, segments, waists, warnings };
}

export function radiusAt(trace: GaussianTrace, z: number): number | null {
  const segment = trace.segments.find((s) => z >= s.zStart && z <= s.zEnd);
  if (!segment) return null;
  const q = { re: segment.qStart.re + (z - segment.zStart), im: segment.qStart.im };
  return radiusFromQ(q, effectiveWavelengthMm(trace.wavelengthNm, trace.m2));
}

export function traceGaussians(setup: Setup, endZ: number): GaussianTrace[] {
  const glasses = makeGlassLookup(setup.glasses);
  return setup.sources.flatMap((source) =>
    source.kind === 'gaussian'
      ? source.wavelengthsNm.map((nm) => traceGaussian(source, setup.optics, nm, glasses, endZ))
      : [],
  );
}
