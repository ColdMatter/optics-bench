import { radiusAt } from '../../engine/gaussian';
import { flipPrescription, fromLocal, lensThickness, type Placement } from '../../engine/lens';
import { opticExtent } from '../../engine/optic';
import { slmPhaseGradient } from '../../engine/slm';
import { sag } from '../../engine/surface';
import type { CatalogueLens, GaussianTrace, Id, Optic, Setup, SetupTrace, Slm, Source } from '../../engine/types';
import { isInfrared, wavelengthColour } from '../colours';
import type { AppState } from '../store';
import { opticHalfAperture, pxPerMmY, pxPerMmZ, toScreen, type View } from './view';

type Pt = [number, number];

export interface DrawOptions {
  showRays: boolean;
  showGaussian: boolean;
  hoverZ: number | null;
  hoverId?: Id | null;
}

interface Theme {
  text: string;
  muted: string;
  axis: string;
  accent: string;
  warn: string;
  glass: string;
  glassAlt: string;
  stroke: string;
  panel: string;
  border: string;
}

const FONT = '11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const SAG_SAMPLES = 32;
const SLM_HALF_WIDTH_PX = 4;
const JAW_PX = 26;
const ARROW_PX = 7;
const SOURCE_DOT_PX = 4;
const MIN_BAR_PX = 12;
const SLM_PITCH_SAMPLES = 160;

function readTheme(el: Element): Theme {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    text: v('--text', '#1d2127'),
    muted: v('--muted', '#6a717c'),
    axis: v('--bench-axis', '#9aa1ab'),
    accent: v('--accent', '#2463c9'),
    warn: v('--warn', '#b26a00'),
    glass: v('--bench-glass', 'rgb(120 170 220 / 0.28)'),
    glassAlt: v('--bench-glass-alt', 'rgb(90 130 190 / 0.4)'),
    stroke: v('--bench-optic', '#4a5563'),
    panel: v('--panel', '#ffffff'),
    border: v('--border', '#d6dae0'),
  };
}

const lensPlacement = (lens: CatalogueLens): Placement => ({
  z: lens.z,
  decentreMm: lens.decentreMm,
  tiltDeg: lens.tiltDeg,
  pivotZ: lensThickness(lens.prescription) / 2,
});

const planePlacement = (o: Optic): Placement => ({
  z: o.z,
  decentreMm: o.kind === 'screen' ? 0 : o.decentreMm,
  tiltDeg: 'tiltDeg' in o ? o.tiltDeg : 0,
  pivotZ: 0,
});

function toWorldFrame(pl: Placement, z: number, y: number): Pt {
  const w = fromLocal({ z, y, dz: 1, dy: 0, wavelengthNm: 0 }, pl);
  return [w.z, w.y];
}

/** Heights at which to sample a surface, stopping where its conic runs out. */
function sagHeights(semiDiameter: number, curvature: number, conic: number): number[] {
  const reach = (1 + conic) * curvature * curvature;
  const limit = reach > 0 ? Math.min(semiDiameter, 1 / Math.sqrt(reach)) : semiDiameter;
  return Array.from({ length: SAG_SAMPLES + 1 }, (_, i) => -limit + (2 * limit * i) / SAG_SAMPLES);
}

/** World outline of each glass element of a lens (two for a cemented doublet), from the real sags. */
export function lensPolygons(lens: CatalogueLens): Pt[][] {
  const p = lens.flipped ? flipPrescription(lens.prescription) : lens.prescription;
  const pl = lensPlacement(lens);
  const profiles: Pt[][] = [];
  let vertexZ = 0;
  for (const s of p.surfaces) {
    profiles.push(
      sagHeights(s.semiDiameterMm, s.curvature, s.conic)
        .map((y): Pt => [vertexZ + sag(s, y), y])
        .filter(([z]) => Number.isFinite(z)),
    );
    vertexZ += s.thicknessToNextMm;
  }
  const polygons: Pt[][] = [];
  p.surfaces.forEach((s, i) => {
    if (s.glassAfter === null || i + 1 >= profiles.length) return;
    const local = [...profiles[i]!, ...[...profiles[i + 1]!].reverse()];
    polygons.push(local.map(([z, y]) => toWorldFrame(pl, z, y)));
  });
  return polygons;
}

/** World end points of a planar optic's clear aperture (tilted about its axial point). */
export function planeEnds(o: Exclude<Optic, CatalogueLens>, half: number): [Pt, Pt] {
  const pl = planePlacement(o);
  return [toWorldFrame(pl, 0, -half), toWorldFrame(pl, 0, half)];
}

/** World end points of a collimated source's launch bar. */
export function collimatedEnds(s: Source & { kind: 'collimated' }): [Pt, Pt] {
  const a = (s.angleDeg * Math.PI) / 180;
  const half = s.widthMm / 2;
  return [
    [s.z + half * Math.sin(a), s.y - half * Math.cos(a)],
    [s.z - half * Math.sin(a), s.y + half * Math.cos(a)],
  ];
}

/** Ids of elements named in an overlap, unknown-glass or SLM pitch-limit warning. */
export function warnedIds(trace: SetupTrace): Set<Id> {
  const ids = new Set<Id>();
  for (const w of trace.warnings) {
    if (w.kind === 'overlap') w.ids.forEach((id) => ids.add(id));
    else if (w.kind === 'unknown-glass' || w.kind === 'slm-pitch-limit') ids.add(w.opticId);
  }
  return ids;
}

/** Stretches a screen-space segment about its middle to at least `minPx` long. */
function atLeast(a: Pt, b: Pt, minPx: number): [Pt, Pt] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len >= minPx) return [a, b];
  const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const [ux, uy] = len > 0 ? [(b[0] - a[0]) / len, (b[1] - a[1]) / len] : [0, -1];
  return [
    [mx - (ux * minPx) / 2, my - (uy * minPx) / 2],
    [mx + (ux * minPx) / 2, my + (uy * minPx) / 2],
  ];
}

export function collimatedBarPx(view: View, s: Source & { kind: 'collimated' }): [Pt, Pt] {
  const [a, b] = collimatedEnds(s);
  return atLeast(toScreen(view, ...a), toScreen(view, ...b), MIN_BAR_PX);
}

/** Screen-space segments of an aperture's two jaws, from the opening edges outwards. */
export function apertureJawsPx(view: View, o: Optic & { kind: 'aperture' }): [Pt, Pt][] {
  const [x, top] = toScreen(view, o.z, o.decentreMm + o.diameterMm / 2);
  const bottom = toScreen(view, o.z, o.decentreMm - o.diameterMm / 2)[1];
  return [
    [
      [x, top - JAW_PX],
      [x, top],
    ],
    [
      [x, bottom],
      [x, bottom + JAW_PX],
    ],
  ];
}

function slmBarPx(view: View, ends: [Pt, Pt]): { a: Pt; b: Pt; nx: number; ny: number } {
  const a = toScreen(view, ...ends[0]);
  const b = toScreen(view, ...ends[1]);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return { a, b, nx: -(b[1] - a[1]) / len, ny: (b[0] - a[0]) / len };
}

function barPath(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, nx: number, ny: number, half: number) {
  ctx.moveTo(a[0] + nx * half, a[1] + ny * half);
  ctx.lineTo(b[0] + nx * half, b[1] + ny * half);
  ctx.lineTo(b[0] - nx * half, b[1] - ny * half);
  ctx.lineTo(a[0] - nx * half, a[1] - ny * half);
  ctx.closePath();
}

function polyPath(ctx: CanvasRenderingContext2D, view: View, pts: Pt[], close: boolean) {
  pts.forEach(([z, y], i) => {
    const [x, py] = toScreen(view, z, y);
    if (i === 0) ctx.moveTo(x, py);
    else ctx.lineTo(x, py);
  });
  if (close) ctx.closePath();
}

const segment = (ctx: CanvasRenderingContext2D, [a, b]: [Pt, Pt]) => {
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
};

/** Outline of an element in screen space, for highlight halos. */
function outlinePath(ctx: CanvasRenderingContext2D, view: View, item: Source | Optic) {
  switch (item.kind) {
    case 'lens':
      for (const poly of lensPolygons(item)) polyPath(ctx, view, poly, true);
      return;
    case 'ideal':
    case 'slm': {
      const ends = planeEnds(item, item.apertureMm / 2);
      if (item.kind === 'ideal') segment(ctx, [toScreen(view, ...ends[0]), toScreen(view, ...ends[1])]);
      else {
        const { a, b, nx, ny } = slmBarPx(view, ends);
        barPath(ctx, a, b, nx, ny, SLM_HALF_WIDTH_PX);
      }
      return;
    }
    case 'aperture':
      for (const jaw of apertureJawsPx(view, item)) segment(ctx, jaw);
      return;
    case 'screen': {
      const x = toScreen(view, item.z, 0)[0];
      segment(ctx, [
        [x, 0],
        [x, view.heightPx],
      ]);
      return;
    }
    case 'collimated':
      segment(ctx, collimatedBarPx(view, item));
      return;
    case 'point':
    case 'gaussian': {
      const [x, y] = toScreen(view, item.z, item.y);
      ctx.moveTo(x + 7, y);
      ctx.arc(x, y, 7, 0, 2 * Math.PI);
    }
  }
}

function drawLens(ctx: CanvasRenderingContext2D, view: View, lens: CatalogueLens, theme: Theme, stroke: string) {
  lensPolygons(lens).forEach((poly, i) => {
    ctx.beginPath();
    polyPath(ctx, view, poly, true);
    ctx.fillStyle = i % 2 === 0 ? theme.glass : theme.glassAlt;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.25;
    ctx.stroke();
  });
}

function arrowHead(ctx: CanvasRenderingContext2D, tip: Pt, ux: number, uy: number) {
  ctx.moveTo(tip[0] - ux * ARROW_PX - uy * ARROW_PX * 0.6, tip[1] - uy * ARROW_PX + ux * ARROW_PX * 0.6);
  ctx.lineTo(tip[0], tip[1]);
  ctx.lineTo(tip[0] - ux * ARROW_PX + uy * ARROW_PX * 0.6, tip[1] - uy * ARROW_PX - ux * ARROW_PX * 0.6);
}

function drawIdeal(ctx: CanvasRenderingContext2D, view: View, o: Optic & { kind: 'ideal' }, stroke: string) {
  const [w0, w1] = planeEnds(o, o.apertureMm / 2);
  const a = toScreen(view, ...w0);
  const b = toScreen(view, ...w1);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const [ux, uy] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  ctx.beginPath();
  segment(ctx, [a, b]);
  // Converging lenses get outward heads (↕), diverging ones inward heads.
  if (o.focalLengthMm > 0) {
    arrowHead(ctx, b, ux, uy);
    arrowHead(ctx, a, -ux, -uy);
  } else {
    arrowHead(ctx, [b[0] - ux * ARROW_PX, b[1] - uy * ARROW_PX], -ux, -uy);
    arrowHead(ctx, [a[0] + ux * ARROW_PX, a[1] + uy * ARROW_PX], ux, uy);
  }
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.75;
  ctx.stroke();
}

/** Runs of local height over which the SLM's phase gradient exceeds what its pitch can show. */
function pitchLimitedRuns(slm: Slm): [number, number][] {
  const half = slm.apertureMm / 2;
  const runs: [number, number][] = [];
  let start: number | null = null;
  for (let i = 0; i <= SLM_PITCH_SAMPLES; i++) {
    const y = -half + (2 * half * i) / SLM_PITCH_SAMPLES;
    const limited = Math.abs(slmPhaseGradient(slm, y)) * slm.pixelPitchUm * 1e-3 > Math.PI;
    if (limited && start === null) start = y;
    if ((!limited || i === SLM_PITCH_SAMPLES) && start !== null) {
      runs.push([start, y]);
      start = null;
    }
  }
  return runs;
}

function drawSlm(ctx: CanvasRenderingContext2D, view: View, slm: Slm, theme: Theme, stroke: string) {
  const { a, b, nx, ny } = slmBarPx(view, planeEnds(slm, slm.apertureMm / 2));
  ctx.save();
  ctx.beginPath();
  barPath(ctx, a, b, nx, ny, SLM_HALF_WIDTH_PX);
  ctx.fillStyle = theme.panel;
  ctx.fill();
  ctx.clip();
  ctx.beginPath();
  const [x0, x1] = [Math.min(a[0], b[0]) - 10, Math.max(a[0], b[0]) + 10];
  const [y0, y1] = [Math.max(Math.min(a[1], b[1]) - 10, -10), Math.min(Math.max(a[1], b[1]) + 10, view.heightPx + 10)];
  for (let y = y0 - (x1 - x0); y < y1; y += 5) segment(ctx, [
    [x0, y],
    [x1, y + (x1 - x0)],
  ]);
  ctx.strokeStyle = theme.muted;
  ctx.lineWidth = 0.75;
  ctx.stroke();
  const pl = planePlacement(slm);
  for (const [lo, hi] of pitchLimitedRuns(slm)) {
    const p = toScreen(view, ...toWorldFrame(pl, 0, lo));
    const q = toScreen(view, ...toWorldFrame(pl, 0, hi));
    ctx.beginPath();
    barPath(ctx, p, q, nx, ny, SLM_HALF_WIDTH_PX);
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = theme.warn;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  ctx.beginPath();
  barPath(ctx, a, b, nx, ny, SLM_HALF_WIDTH_PX);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.25;
  ctx.stroke();
}

function drawAperture(ctx: CanvasRenderingContext2D, view: View, o: Optic & { kind: 'aperture' }, stroke: string) {
  ctx.beginPath();
  for (const jaw of apertureJawsPx(view, o)) segment(ctx, jaw);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 3.5;
  ctx.lineCap = 'butt';
  ctx.stroke();
}

function drawScreen(ctx: CanvasRenderingContext2D, view: View, o: Optic & { kind: 'screen' }, stroke: string) {
  const x = Math.round(toScreen(view, o.z, 0)[0]) + 0.5;
  ctx.beginPath();
  segment(ctx, [
    [x, 0],
    [x, view.heightPx],
  ]);
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawSource(ctx: CanvasRenderingContext2D, view: View, s: Source, stroke: string) {
  ctx.strokeStyle = stroke;
  ctx.fillStyle = stroke;
  if (s.kind === 'collimated') {
    ctx.beginPath();
    segment(ctx, collimatedBarPx(view, s));
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.stroke();
    return;
  }
  const [x, y] = toScreen(view, s.z, s.y);
  ctx.beginPath();
  if (s.kind === 'point') {
    ctx.arc(x, y, SOURCE_DOT_PX, 0, 2 * Math.PI);
    ctx.fill();
    return;
  }
  // A waist: two hyperbola-like flanks pinched at the source.
  ctx.moveTo(x - 7, y - 6);
  ctx.quadraticCurveTo(x, y - 0.5, x + 7, y - 6);
  ctx.moveTo(x - 7, y + 6);
  ctx.quadraticCurveTo(x, y + 0.5, x + 7, y + 6);
  ctx.lineWidth = 1.75;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 1.75, 0, 2 * Math.PI);
  ctx.fill();
}

function drawOptic(ctx: CanvasRenderingContext2D, view: View, o: Optic, theme: Theme, stroke: string) {
  switch (o.kind) {
    case 'lens':
      return drawLens(ctx, view, o, theme, stroke);
    case 'ideal':
      return drawIdeal(ctx, view, o, stroke);
    case 'slm':
      return drawSlm(ctx, view, o, theme, stroke);
    case 'aperture':
      return drawAperture(ctx, view, o, stroke);
    case 'screen':
      return drawScreen(ctx, view, o, stroke);
  }
}

/** Screen x and the top of an element, for its label. */
function labelAnchor(view: View, item: Source | Optic): Pt {
  if (item.kind === 'point' || item.kind === 'gaussian' || item.kind === 'collimated') {
    const top = item.kind === 'collimated' ? Math.min(...collimatedBarPx(view, item).map((p) => p[1])) : toScreen(view, item.z, item.y)[1] - 6;
    return [toScreen(view, item.z, item.y)[0], top];
  }
  const [z0, z1] = opticExtent(item);
  const x = toScreen(view, (z0 + z1) / 2, 0)[0];
  if (item.kind === 'screen') return [x, 16];
  if (item.kind === 'aperture') return [x, apertureJawsPx(view, item)[0]![0][1]];
  const half = opticHalfAperture(item)!;
  const top = item.kind === 'lens' ? lensPolygons(item).flat() : planeEnds(item, half);
  return [x, Math.min(...top.map(([z, y]) => toScreen(view, z, y)[1]))];
}

function drawLabel(ctx: CanvasRenderingContext2D, view: View, item: Source | Optic, theme: Theme, emphasis: boolean) {
  if (!item.label) return;
  const [x, top] = labelAnchor(view, item);
  if (x < -40 || x > view.widthPx + 40) return;
  const y = Math.min(Math.max(top - 6, 13), view.heightPx - 4);
  ctx.font = emphasis ? `600 ${FONT}` : FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineWidth = 3;
  ctx.strokeStyle = theme.panel;
  ctx.lineJoin = 'round';
  ctx.strokeText(item.label, x, y);
  ctx.fillStyle = emphasis ? theme.accent : theme.text;
  ctx.fillText(item.label, x, y);
}

function drawRays(ctx: CanvasRenderingContext2D, view: View, trace: SetupTrace) {
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  ctx.globalAlpha = 0.6;
  for (const source of trace.sources) {
    for (const { wavelengthNm, rays } of source.byWavelength) {
      ctx.beginPath();
      for (const ray of rays) polyPath(ctx, view, ray.points, false);
      ctx.strokeStyle = wavelengthColour(wavelengthNm);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function drawGaussian(ctx: CanvasRenderingContext2D, view: View, g: GaussianTrace) {
  const colour = wavelengthColour(g.wavelengthNm);
  const upper: Pt[] = [];
  const lower: Pt[] = [];
  const flush = () => {
    if (upper.length > 1) {
      ctx.beginPath();
      ctx.moveTo(upper[0]![0], upper[0]![1]);
      for (const [x, y] of upper) ctx.lineTo(x, y);
      for (const [x, y] of [...lower].reverse()) ctx.lineTo(x, y);
      ctx.closePath();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.beginPath();
      for (const edge of [upper, lower]) edge.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    upper.length = 0;
    lower.length = 0;
  };
  for (const s of g.segments) {
    const lo = Math.max(s.zStart, view.zMin);
    const hi = Math.min(s.zEnd, view.zMax);
    if (!(hi > lo)) continue;
    const [c0, c1] = [s.centre[0]!, s.centre[s.centre.length - 1]!];
    const centreY = (z: number) => (c1[0] === c0[0] ? c0[1] : c0[1] + ((z - c0[0]) / (c1[0] - c0[0])) * (c1[1] - c0[1]));
    const n = Math.max(2, Math.ceil(((hi - lo) * pxPerMmZ(view)) / 2));
    const zs = Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);
    const waistZ = s.zStart - s.qStart.re;
    if (waistZ > lo && waistZ < hi) zs.push(waistZ);
    zs.sort((a, b) => a - b);
    for (const z of zs) {
      const w = radiusAt(g, z);
      if (w === null || !Number.isFinite(w)) continue;
      const y = centreY(z);
      upper.push(toScreen(view, z, y + w));
      lower.push(toScreen(view, z, y - w));
    }
    flush();
  }
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  polyPath(ctx, view, g.centre.points, false);
  ctx.strokeStyle = colour;
  ctx.lineWidth = 0.9;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function niceLength(maxMm: number): number {
  const p = 10 ** Math.floor(Math.log10(maxMm));
  for (const m of [5, 2, 1]) if (m * p <= maxMm) return m * p;
  return p;
}

function formatLength(mm: number): string {
  if (mm >= 1) return `${Number(mm.toPrecision(6))} mm`;
  if (mm >= 1e-3) return `${Number((mm * 1e3).toPrecision(6))} µm`;
  return `${Number((mm * 1e6).toPrecision(6))} nm`;
}

function haloText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, theme: Theme) {
  ctx.lineWidth = 3;
  ctx.strokeStyle = theme.panel;
  ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = theme.muted;
  ctx.fillText(text, x, y);
}

function drawScaleBars(ctx: CanvasRenderingContext2D, view: View, theme: Theme) {
  const zMm = niceLength(110 / pxPerMmZ(view));
  const yMm = niceLength(64 / pxPerMmY(view));
  const zPx = zMm * pxPerMmZ(view);
  const yPx = yMm * pxPerMmY(view);
  const x0 = 14.5;
  const y0 = Math.round(view.heightPx - 22) + 0.5;
  ctx.beginPath();
  ctx.moveTo(x0, y0 - yPx);
  ctx.lineTo(x0, y0);
  ctx.lineTo(x0 + zPx, y0);
  for (const [x, y] of [
    [x0 + zPx, y0],
    [x0, y0 - yPx],
  ] as const) {
    ctx.moveTo(x - (y === y0 ? 0 : 3), y - (y === y0 ? 3 : 0));
    ctx.lineTo(x + (y === y0 ? 0 : 3), y + (y === y0 ? 3 : 0));
  }
  ctx.strokeStyle = theme.muted;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.font = FONT;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  haloText(ctx, `z ${formatLength(zMm)}`, x0 + zPx / 2, y0 + 4, theme);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  haloText(ctx, `y ${formatLength(yMm)}`, x0 + 5, y0 - yPx / 2, theme);
}

function drawLegend(ctx: CanvasRenderingContext2D, view: View, setup: Setup, theme: Theme) {
  const wavelengths = [...new Set(setup.sources.flatMap((s) => s.wavelengthsNm))].sort((a, b) => a - b);
  if (!wavelengths.length) return;
  ctx.font = FONT;
  const rows = wavelengths.map((nm) => `${Number(nm.toPrecision(6))} nm${isInfrared(nm) ? ' IR' : ''}`);
  const textW = Math.max(...rows.map((r) => ctx.measureText(r).width));
  const rowH = 16;
  const w = textW + 38;
  const h = rows.length * rowH + 8;
  const x = view.widthPx - w - 10;
  const y = 10;
  ctx.globalAlpha = 0.88;
  ctx.fillStyle = theme.panel;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(x) + 0.5, y + 0.5, Math.round(w), h);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  wavelengths.forEach((nm, i) => {
    const cy = y + 4 + rowH * i + rowH / 2;
    ctx.fillStyle = wavelengthColour(nm);
    ctx.fillRect(x + 8, cy - 2, 18, 4);
    ctx.fillStyle = theme.text;
    ctx.fillText(rows[i]!, x + 32, cy);
  });
}

function drawAxis(ctx: CanvasRenderingContext2D, view: View, theme: Theme) {
  const y = Math.round(toScreen(view, 0, 0)[1]) + 0.5;
  if (y < 0 || y > view.heightPx) return;
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(view.widthPx, y);
  ctx.setLineDash([14, 4, 3, 4]);
  ctx.strokeStyle = theme.axis;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawHoverLine(ctx: CanvasRenderingContext2D, view: View, z: number, theme: Theme) {
  const x = Math.round(toScreen(view, z, 0)[0]) + 0.5;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, view.heightPx);
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = theme.muted;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
}

function halo(ctx: CanvasRenderingContext2D, view: View, item: Source | Optic, colour: string, alpha: number) {
  ctx.beginPath();
  outlinePath(ctx, view, item);
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = colour;
  ctx.lineWidth = 7;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.globalAlpha = 1;
}

export function drawBench(
  ctx: CanvasRenderingContext2D,
  view: View,
  state: AppState,
  trace: SetupTrace,
  gaussians: GaussianTrace[],
  opts: DrawOptions,
): void {
  const theme = readTheme(ctx.canvas);
  const scale = ctx.canvas.width / view.widthPx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  const { setup, selectedId } = state;
  const warned = warnedIds(trace);
  const strokeFor = (id: Id) => (warned.has(id) ? theme.warn : theme.stroke);
  const items: (Source | Optic)[] = [...setup.optics, ...setup.sources];

  drawAxis(ctx, view, theme);
  if (opts.hoverZ !== null) drawHoverLine(ctx, view, opts.hoverZ, theme);
  for (const item of items) {
    if (item.id === selectedId) halo(ctx, view, item, theme.accent, 0.3);
    else if (item.id === opts.hoverId) halo(ctx, view, item, theme.accent, 0.14);
  }
  if (opts.showGaussian) for (const g of gaussians) drawGaussian(ctx, view, g);
  for (const o of setup.optics) drawOptic(ctx, view, o, theme, strokeFor(o.id));
  if (opts.showRays) drawRays(ctx, view, trace);
  for (const s of setup.sources) drawSource(ctx, view, s, theme.text);
  for (const item of items) drawLabel(ctx, view, item, theme, item.id === selectedId);
  drawLegend(ctx, view, setup, theme);
  drawScaleBars(ctx, view, theme);
}
