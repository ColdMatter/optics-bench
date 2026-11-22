import { radiusAt, traceGaussian } from './gaussian';
import { opticExtent } from './optic';
import { defaultEndZ, lookupFor } from './trace';
import type { GaussianSource, GaussianTrace, Id, Optic, Setup } from './types';

export type Target =
  | { kind: 'radiusAt'; sourceId: Id; wavelengthNm: number; z: number; radiusMm: number }
  | { kind: 'waistRadius'; sourceId: Id; wavelengthNm: number; radiusMm: number }
  | { kind: 'waistPosition'; sourceId: Id; wavelengthNm: number; z: number }
  | { kind: 'collimated'; sourceId: Id; wavelengthNm: number };
export interface Variable {
  opticId: Id;
  minZ: number;
  maxZ: number;
}
export interface SolveResult {
  setup: Setup;
  cost: number;
  residuals: number[];
  converged: boolean;
}

const UNEVALUABLE_RESIDUAL = 1e3;
const OVERLAP_WEIGHT = 100;
/** `converged` holds when every residual is within its target's tolerance (overlaps: 1e-3, i.e. 10 nm). */
export const TOLERANCE: Record<Target['kind'], number> = {
  radiusAt: 1e-3, // relative
  waistRadius: 1e-3, // relative
  waistPosition: 1e-3, // mm
  collimated: 0.01, // waist within 1 % of a Rayleigh range of the last powered optic
};
const OVERLAP_TOLERANCE = 1e-3;
const STOP_COST = 1e-12;
const MAX_EVALUATIONS = 2000;
const TIME_LIMIT_MS = 900;
const RESTARTS = 4;
const SEED = 0x5eed;
const MIN_TAIL_MM = 50;
const TAIL_FRACTION = 0.1;
const NM_TO_MM = 1e-6;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function overlapResiduals(optics: Optic[]): number[] {
  const extents = optics.map(opticExtent);
  const residuals: number[] = [];
  for (let i = 0; i < extents.length; i++) {
    for (let j = i + 1; j < extents.length; j++) {
      const [aStart, aEnd] = extents[i]!;
      const [bStart, bEnd] = extents[j]!;
      const aThin = aStart === aEnd;
      const bThin = bStart === bEnd;
      let overlapMm = 0;
      if (!aThin && !bThin) overlapMm = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
      else if (aThin && !bThin && aStart > bStart && aStart < bEnd) overlapMm = Math.min(aStart - bStart, bEnd - aStart);
      else if (bThin && !aThin && bStart > aStart && bStart < aEnd) overlapMm = Math.min(bStart - aStart, aEnd - bStart);
      if (overlapMm > 0) residuals.push(overlapMm * OVERLAP_WEIGHT);
    }
  }
  return residuals;
}

/**
 * How far from collimated the beam leaving its last powered optic is: d/|q| there, with d the distance
 * from that optic's exit back to the output waist. This is the 1/e² edge ray's angle from wavefront
 * curvature as a fraction of the far-field divergence: 0 when collimated, ±1 far from it.
 */
export function collimationError(trace: GaussianTrace, setup: Setup): number {
  const last = trace.waists[trace.waists.length - 1]!;
  const optic = setup.optics.find((o) => o.id === last.afterOpticId);
  const exitZ = optic ? opticExtent(optic)[1] : setup.sources.find((s) => s.id === trace.sourceId)!.z;
  const rayleighMm = (Math.PI * last.radiusMm ** 2) / (trace.m2 * trace.wavelengthNm * NM_TO_MM);
  const d = exitZ - last.z;
  return d / Math.hypot(d, rayleighMm);
}

function targetResidual(target: Target, trace: GaussianTrace | null, setup: Setup): number {
  if (!trace || trace.centre.blockedBy !== null) return UNEVALUABLE_RESIDUAL;
  const finite = (r: number) => (Number.isFinite(r) ? r : UNEVALUABLE_RESIDUAL);
  const last = trace.waists[trace.waists.length - 1]!;
  switch (target.kind) {
    case 'radiusAt': {
      const w = radiusAt(trace, target.z);
      return w === null ? UNEVALUABLE_RESIDUAL : finite((w - target.radiusMm) / target.radiusMm);
    }
    case 'waistRadius':
      return finite((last.radiusMm - target.radiusMm) / target.radiusMm);
    case 'waistPosition':
      return last.collimated ? UNEVALUABLE_RESIDUAL : finite(last.z - target.z);
    case 'collimated':
      return finite(collimationError(trace, setup));
  }
}

function withPositions(setup: Setup, ids: Id[], zs: number[]): Setup {
  const zById = new Map(ids.map((id, i) => [id, zs[i]!]));
  return { ...setup, optics: setup.optics.map((o) => (zById.has(o.id) ? { ...o, z: zById.get(o.id)! } : o)) };
}

function evaluate(setup: Setup, targets: Target[]): number[] {
  const glasses = lookupFor(setup.glasses);
  const farthestZ = targets.reduce((m, t) => ('z' in t ? Math.max(m, t.z) : m), -Infinity);
  const endZ = Math.max(
    defaultEndZ(setup),
    farthestZ + Math.max(TAIL_FRACTION * Math.abs(farthestZ), MIN_TAIL_MM),
  );
  const traces = new Map<string, GaussianTrace | null>();
  const traceFor = (t: Target): GaussianTrace | null => {
    const key = `${t.sourceId}@${t.wavelengthNm}`;
    if (!traces.has(key)) {
      const source = setup.sources.find((s): s is GaussianSource => s.id === t.sourceId && s.kind === 'gaussian');
      traces.set(
        key,
        source && source.wavelengthsNm.includes(t.wavelengthNm)
          ? traceGaussian(source, setup.optics, t.wavelengthNm, glasses, endZ)
          : null,
      );
    }
    return traces.get(key)!;
  };
  return [...targets.map((t) => targetResidual(t, traceFor(t), setup)), ...overlapResiduals(setup.optics)];
}

const sumSquares = (xs: number[]) => xs.reduce((s, r) => s + r * r, 0);

interface Vertex {
  u: number[];
  cost: number;
}

/** Nelder–Mead with the standard coefficients; returns when `budget` evaluations are spent or the simplex collapses. */
function nelderMead(f: (u: number[]) => number, start: number[], step: number, budget: number, done: () => boolean): Vertex {
  const n = start.length;
  let spent = 0;
  const probe = (u: number[]): Vertex => {
    spent++;
    return { u, cost: f(u) };
  };
  let simplex: Vertex[] = [probe(start)];
  for (let i = 0; i < n; i++) {
    const u = [...start];
    u[i]! += step;
    simplex.push(probe(u));
  }
  const combine = (a: number[], b: number[], t: number) => a.map((x, i) => x + t * (b[i]! - x));
  while (spent < budget && !done()) {
    simplex.sort((a, b) => a.cost - b.cost);
    const best = simplex[0]!;
    const worst = simplex[n]!;
    if (best.cost < STOP_COST) break;
    if (worst.cost - best.cost < 1e-16 * (1 + best.cost) && spent > 4 * n) break;
    const centroid = Array.from({ length: n }, (_, d) => simplex.slice(0, n).reduce((s, v) => s + v.u[d]!, 0) / n);
    const reflected = probe(combine(centroid, worst.u, -1));
    if (reflected.cost < best.cost) {
      const expanded = probe(combine(centroid, worst.u, -2));
      simplex[n] = expanded.cost < reflected.cost ? expanded : reflected;
    } else if (reflected.cost < simplex[n - 1]!.cost) {
      simplex[n] = reflected;
    } else {
      const contracted = probe(combine(centroid, worst.u, reflected.cost < worst.cost ? -0.5 : 0.5));
      if (contracted.cost < Math.min(reflected.cost, worst.cost)) {
        simplex[n] = contracted;
      } else {
        simplex = [best, ...simplex.slice(1).map((v) => probe(combine(best.u, v.u, 0.5)))];
      }
    }
  }
  return simplex.reduce((a, b) => (b.cost < a.cost ? b : a));
}

export function solve(setup: Setup, targets: Target[], variables: Variable[]): SolveResult {
  const opticIds = new Set(setup.optics.map((o) => o.id));
  for (const v of variables) {
    if (!opticIds.has(v.opticId)) throw new Error(`Solver variable names unknown optic "${v.opticId}"`);
    if (v.minZ > v.maxZ) throw new Error(`Solver variable "${v.opticId}" has minZ > maxZ`);
  }
  const ids = variables.map((v) => v.opticId);
  const toZ = (u: number[]) => variables.map((v, i) => v.minZ + ((v.maxZ - v.minZ) * (1 + Math.sin(u[i]!))) / 2);
  const toU = (z: number, v: Variable) =>
    v.maxZ === v.minZ ? 0 : Math.asin(Math.min(1, Math.max(-1, (2 * (z - v.minZ)) / (v.maxZ - v.minZ) - 1)));
  const build = (u: number[]) => withPositions(setup, ids, toZ(u));
  const cost = (u: number[]) => sumSquares(evaluate(build(u), targets));

  const initial = variables.map((v) => toU(setup.optics.find((o) => o.id === v.opticId)!.z, v));
  let best: Vertex = { u: initial, cost: cost(initial) };
  if (variables.length > 0) {
    const random = mulberry32(SEED);
    const deadline = performance.now() + TIME_LIMIT_MS;
    let evaluations = 1;
    const counted = (u: number[]) => {
      evaluations++;
      return cost(u);
    };
    const done = () => best.cost < STOP_COST || evaluations >= MAX_EVALUATIONS || performance.now() > deadline;
    const budgetPerRun = Math.floor(MAX_EVALUATIONS / (RESTARTS + 1));
    for (let run = 0; run <= RESTARTS && !done(); run++) {
      const start = run === 0 ? initial : variables.map(() => (random() * 2 - 1) * Math.PI);
      const found = nelderMead(counted, start, 0.3, budgetPerRun, done);
      if (found.cost < best.cost) best = found;
    }
  }

  const final = build(best.u);
  const residuals = evaluate(final, targets);
  const finalCost = sumSquares(residuals);
  const converged = residuals.every(
    (r, i) => Math.abs(r) < (i < targets.length ? TOLERANCE[targets[i]!.kind] : OVERLAP_TOLERANCE),
  );
  return { setup: final, cost: finalCost, residuals, converged };
}
