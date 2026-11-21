import { radiusAt } from '../../engine/gaussian';
import { opticExtent } from '../../engine/optic';
import type { GaussianTrace, Optic, Setup, SetupTrace } from '../../engine/types';

/** The visible world rectangle (mm) and the canvas size it maps onto (CSS pixels); y and z scale independently. */
export interface View {
  zMin: number;
  zMax: number;
  yMin: number;
  yMax: number;
  widthPx: number;
  heightPx: number;
}

const MIN_RANGE_MM = 1e-3;
const MAX_RANGE_MM = 1e6;
/** Room left by fitAll for labels above and for the scale bars and legend below. */
const FIT_PAD_PX = { left: 40, right: 40, top: 36, bottom: 48 };
const MIN_HALF_HEIGHT_MM = 1;
const EMPTY_LENGTH_MM = 100;

export const pxPerMmZ = (v: View) => v.widthPx / (v.zMax - v.zMin);
export const pxPerMmY = (v: View) => v.heightPx / (v.yMax - v.yMin);

export function toScreen(v: View, z: number, y: number): [number, number] {
  return [(z - v.zMin) * pxPerMmZ(v), (v.yMax - y) * pxPerMmY(v)];
}

export function toWorld(v: View, px: number, py: number): [number, number] {
  return [v.zMin + px / pxPerMmZ(v), v.yMax - py / pxPerMmY(v)];
}

function scaleRange(lo: number, hi: number, about: number, factor: number): [number, number] {
  const range = hi - lo;
  const clamped = Math.min(Math.max(range / factor, MIN_RANGE_MM), MAX_RANGE_MM);
  const f = range / clamped;
  return [about - (about - lo) / f, about + (hi - about) / f];
}

/** Magnifies by `factor` (> 1 zooms in) keeping the world point under (px, py) fixed. */
export function zoomAbout(v: View, px: number, py: number, factor: number, axis: 'both' | 'y'): View {
  const [z, y] = toWorld(v, px, py);
  const [yMin, yMax] = scaleRange(v.yMin, v.yMax, y, factor);
  if (axis === 'y') return { ...v, yMin, yMax };
  const [zMin, zMax] = scaleRange(v.zMin, v.zMax, z, factor);
  return { ...v, zMin, zMax, yMin, yMax };
}

/** Moves the world by (dxPx, dyPx) on screen, as if dragged. */
export function pan(v: View, dxPx: number, dyPx: number): View {
  const dz = dxPx / pxPerMmZ(v);
  const dy = dyPx / pxPerMmY(v);
  return { ...v, zMin: v.zMin - dz, zMax: v.zMax - dz, yMin: v.yMin + dy, yMax: v.yMax + dy };
}

/** Keeps the scale and the top-left corner when the canvas changes size. */
export function resize(v: View, widthPx: number, heightPx: number): View {
  return {
    ...v,
    zMax: v.zMin + widthPx / pxPerMmZ(v),
    yMin: v.yMax - heightPx / pxPerMmY(v),
    widthPx,
    heightPx,
  };
}

/** Half the clear aperture of an optic about its decentre; null for a screen. */
export function opticHalfAperture(o: Optic): number | null {
  switch (o.kind) {
    case 'lens':
      return Math.max(...o.prescription.surfaces.map((s) => s.semiDiameterMm));
    case 'ideal':
    case 'slm':
      return o.apertureMm / 2;
    case 'aperture':
      return o.diameterMm / 2;
    case 'screen':
      return null;
  }
}

const GAUSSIAN_SAMPLES = 24;

function gaussianHeights(g: GaussianTrace, push: (y: number) => void): void {
  for (const s of g.segments) {
    const y0 = s.centre[0]![1];
    const y1 = s.centre[s.centre.length - 1]![1];
    for (let i = 0; i <= GAUSSIAN_SAMPLES; i++) {
      const t = i / GAUSSIAN_SAMPLES;
      const w = radiusAt(g, s.zStart + t * (s.zEnd - s.zStart));
      if (w === null || !Number.isFinite(w)) continue;
      const y = y0 + t * (y1 - y0);
      push(y + w);
      push(y - w);
    }
  }
}

/** A view showing every element, the traced rays to the trace's end, Gaussian envelopes and optic apertures. */
export function fitAll(setup: Setup, trace: SetupTrace, widthPx: number, heightPx: number, gaussians: GaussianTrace[] = []): View {
  const width = Math.max(widthPx, 1);
  const height = Math.max(heightPx, 1);
  const zs: number[] = [];
  const ys: number[] = [0];
  const pushY = (y: number) => {
    if (Number.isFinite(y)) ys.push(y);
  };
  for (const s of setup.sources) {
    zs.push(s.z);
    pushY(s.y);
  }
  for (const o of setup.optics) {
    zs.push(...opticExtent(o));
    const half = opticHalfAperture(o);
    if (half !== null && o.kind !== 'screen') {
      pushY(o.decentreMm + half);
      pushY(o.decentreMm - half);
    }
  }
  if (zs.length && Number.isFinite(trace.endZ)) zs.push(trace.endZ);
  for (const s of trace.sources) for (const w of s.byWavelength) for (const r of w.rays) for (const p of r.points) pushY(p[1]);
  for (const g of gaussians) gaussianHeights(g, pushY);

  let zLo = zs.length ? Math.min(...zs) : 0;
  let zHi = zs.length ? Math.max(...zs) : EMPTY_LENGTH_MM;
  if (zHi - zLo < MIN_RANGE_MM * 100) [zLo, zHi] = [zLo - EMPTY_LENGTH_MM / 2, zHi + EMPTY_LENGTH_MM / 2];
  let yLo = Math.min(...ys);
  let yHi = Math.max(...ys);
  if (yHi - yLo < 2 * MIN_HALF_HEIGHT_MM) {
    const mid = (yLo + yHi) / 2;
    [yLo, yHi] = [mid - MIN_HALF_HEIGHT_MM, mid + MIN_HALF_HEIGHT_MM];
  }

  const innerW = Math.max(width - FIT_PAD_PX.left - FIT_PAD_PX.right, width / 2);
  const innerH = Math.max(height - FIT_PAD_PX.top - FIT_PAD_PX.bottom, height / 2);
  const mmPerPxZ = (zHi - zLo) / innerW;
  const mmPerPxY = (yHi - yLo) / innerH;
  const padLeft = (width - innerW) * (FIT_PAD_PX.left / (FIT_PAD_PX.left + FIT_PAD_PX.right));
  const padTop = (height - innerH) * (FIT_PAD_PX.top / (FIT_PAD_PX.top + FIT_PAD_PX.bottom));
  const zMin = zLo - padLeft * mmPerPxZ;
  const yMax = yHi + padTop * mmPerPxY;
  return { zMin, zMax: zMin + width * mmPerPxZ, yMin: yMax - height * mmPerPxY, yMax, widthPx: width, heightPx: height };
}
