import { focusPerWavelength, focusShiftCurve, screenMagnifications, screenStats, type FocusResult, type Magnification } from '../engine/focus';
import { radiusAt } from '../engine/gaussian';
import { opticExtent } from '../engine/optic';
import type { GaussianTrace, Id, Optic, Screen, Setup, SetupTrace, Source, TraceWarning } from '../engine/types';
import { wavelengthColour } from './colours';
import { formatFull, h, numberControl, type Control } from './controls';
import { kindNames } from './elements';
import type { AppState } from './store';

export const OFF_AXIS_NOTE = 'Tangential (meridional) rays only — sagittal focus not computed';
const NO_RAYS = 'No rays reach this point';
const TILT_LIMIT_DEG = 3;
const SHIFT_STEPS = 41;
const DEFAULT_RANGE_MARGIN_NM = 100;
const MIN_RANGE_NM = 350;

/** Millimetres to 3 decimals. */
const mm = (v: number) => `${(Math.abs(v) < 5e-4 ? 0 : v).toFixed(3)} mm`;

/** A length in µm (3 significant figures) below 1 mm, otherwise in mm to 3 decimals. */
export function formatLength(lengthMm: number): string {
  if (Math.abs(lengthMm) >= 0.9995) return mm(lengthMm);
  const um = lengthMm * 1e3;
  return Math.abs(um) < 0.01 ? `${um.toFixed(2)} µm` : `${um.toPrecision(3)} µm`;
}

/** One value in a readout table. `warn` colours it, and `title` explains it on hover. */
export interface Cell {
  text: string;
  warn?: boolean;
  title?: string;
}

/** A row of a source's readout table: one cell per wavelength column, null where there is nothing. */
export interface ReadoutRow {
  label: string;
  cells: (Cell | null)[];
  /** A screen's name, heading the rows under it. */
  heading?: boolean;
  /** Indented under the row or heading above it. */
  sub?: boolean;
  title?: string;
}

export interface Note {
  text: string;
  warn: boolean;
}

/** A source's readouts: a column per wavelength, shortest first, then rows, then notes. */
export interface SourceReadout {
  wavelengthsNm: number[];
  rows: ReadoutRow[];
  notes: Note[];
}

const APPROX_TITLE = 'Approximate: a lens in the path was modelled from its drawing, which rounds radii and thicknesses';
const DASH: Cell = { text: '—' };
const NO_RAYS_CELL: Cell = { text: NO_RAYS, warn: true };
const byWavelength = <T extends { wavelengthNm: number }>(a: T, b: T) => a.wavelengthNm - b.wavelengthNm;

const signed = (lengthMm: number) => `${lengthMm < 0 ? '' : '+'}${formatLength(lengthMm)}`;

/** A magnification to 4 significant figures, signed, or why there is no number. */
export function magnificationCell(m: Magnification | undefined): Cell | null {
  if (!m) return null;
  if (m.value === null) {
    if (m.reason === 'edge-ray-blocked') return { text: 'edge ray blocked', warn: true };
    if (m.reason === 'undefined') return { text: 'undefined (no beam width)' };
    return { text: 'unavailable' };
  }
  const v = Math.abs(m.value) < 1e-12 ? 0 : m.value;
  return { text: v.toPrecision(4) };
}

/** A point source's spot RMS referred back to the object, RMS/|M|; null without a usable M. */
export function objectSideRmsCell(m: Magnification | undefined, spotRmsMm: number): Cell | null {
  if (!m || m.value === null || Math.abs(m.value) <= 1e-9) return null;
  return { text: formatLength(spotRmsMm / Math.abs(m.value)) };
}

/**
 * Focus rows for one ray source, a column per result in the order given: paraxial focus, the
 * shift from the wavelength to its left, best focus, the RMS there, and off axis the image height.
 */
export function focusRows(results: FocusResult[], offAxis: boolean): ReadoutRow[] {
  const status = (r: FocusResult): Cell => (r.status === 'collimated' ? { text: 'none (collimated)' } : NO_RAYS_CELL);
  if (results.length && results.every((r) => r.status !== 'ok')) return [{ label: 'Focus', cells: results.map(status) }];
  const at = (r: FocusResult, z: number | null): Cell =>
    z === null ? DASH : r.approximate ? { text: `≈${mm(z)}`, title: APPROX_TITLE } : { text: mm(z) };
  const ok = (r: FocusResult, cell: () => Cell): Cell => (r.status === 'ok' ? cell() : DASH);
  const rows: ReadoutRow[] = [{ label: 'Paraxial focus z', cells: results.map((r) => (r.status === 'ok' ? at(r, r.paraxialZ) : status(r))) }];

  const shifts = results.map((r, i): Cell | null => {
    const prev = results[i - 1];
    if (!prev) return null;
    const key = prev.paraxialZ !== null && r.paraxialZ !== null ? 'paraxialZ' : 'bestZ';
    const from = prev[key];
    const to = r[key];
    if (from === null || to === null) return null;
    const kind = key === 'paraxialZ' ? 'paraxial' : 'best';
    return { text: signed(to - from), title: `The ${kind} focus at ${r.wavelengthNm} nm minus that at ${prev.wavelengthNm} nm` };
  });
  if (shifts.some((c) => c !== null)) {
    rows.push({ label: 'Focal shift', sub: true, cells: shifts, title: 'How far the focus moves from the wavelength to the left' });
  }
  rows.push({ label: 'Best focus z', cells: results.map((r) => ok(r, () => at(r, r.bestZ))) });
  rows.push({
    label: 'RMS at best focus',
    cells: results.map((r) => ok(r, () => (r.rmsAtBestMm === null ? DASH : { text: formatLength(r.rmsAtBestMm) }))),
  });
  if (offAxis) {
    rows.push({
      label: 'Image height y',
      cells: results.map((r) => ok(r, () => (r.imageHeightMm === null ? DASH : { text: mm(r.imageHeightMm) }))),
    });
  }
  return rows;
}

/** Waist rows for one Gaussian source, a column per beam in the order given, and notes on why they may be unreliable. */
export function gaussianRows(beams: GaussianTrace[], labels: Record<Id, string>): { rows: ReadoutRow[]; notes: Note[] } {
  const name = (id: Id) => labels[id] || id;
  const keys: (Id | null)[] = [];
  for (const beam of beams) for (const w of beam.waists) if (!keys.includes(w.afterOpticId)) keys.push(w.afterOpticId);
  const rows = keys.map(
    (key): ReadoutRow => ({
      label: key === null ? 'Input waist' : `After ${name(key)}`,
      cells: beams.map((beam) => {
        const w = beam.waists.find((x) => x.afterOpticId === key);
        if (!w) return DASH;
        return { text: w.collimated ? `collimated, w₀ ${formatLength(w.radiusMm)}` : `w₀ ${formatLength(w.radiusMm)} at z ${mm(w.z)}` };
      }),
    }),
  );
  const notes: Note[] = [];
  for (const beam of beams) {
    const prefix = beams.length > 1 ? `${beam.wavelengthNm} nm: ` : '';
    if (beam.centre.blockedBy !== null) notes.push({ text: `${prefix}Beam blocked at ${name(beam.centre.blockedBy)}`, warn: true });
    for (const w of beam.warnings) {
      const why =
        w.kind === 'clipped'
          ? `beam clipped at ${name(w.opticId)}`
          : `centre ray meets ${name(w.opticId)} tilted by more than ${TILT_LIMIT_DEG}°`;
      notes.push({ text: `${prefix}Unreliable: ${why}`, warn: true });
    }
  }
  return { rows, notes };
}

const hasPower = (o: Optic) => o.kind === 'lens' || o.kind === 'ideal' || o.kind === 'slm';

/** Off axis: the source is raised or angled, or a decentred or tilted optic lies in its path. */
export function isOffAxis(setup: Setup, source: Source): boolean {
  if (source.y !== 0) return true;
  if (source.kind !== 'point' && source.angleDeg !== 0) return true;
  return setup.optics.some(
    (o) => hasPower(o) && opticExtent(o)[0] >= source.z && 'tiltDeg' in o && (o.decentreMm !== 0 || o.tiltDeg !== 0),
  );
}

/** Trace warnings in plain words, naming the elements concerned. */
export function describeWarnings(setup: Setup, warnings: TraceWarning[]): string[] {
  const labelOf = (id: Id) => [...setup.sources, ...setup.optics].find((e) => e.id === id)?.label || id;
  const extrapolated = new Map<string, Set<number>>();
  const lines: string[] = [];
  for (const w of warnings) {
    switch (w.kind) {
      case 'overlap':
        lines.push(`${labelOf(w.ids[0])} overlaps ${labelOf(w.ids[1])}`);
        break;
      case 'unknown-glass':
        lines.push(`${labelOf(w.opticId)}: glass ${w.glass} is unknown, so rays are blocked there`);
        break;
      case 'slm-pitch-limit':
        lines.push(`${labelOf(w.opticId)}: the phase gradient is finer than the pixel pitch can show; rays there are blocked`);
        break;
      case 'glass-extrapolated': {
        const set = extrapolated.get(w.glass) ?? new Set();
        set.add(w.wavelengthNm);
        extrapolated.set(w.glass, set);
        break;
      }
    }
  }
  for (const [glass, nms] of extrapolated) {
    const users = setup.optics
      .filter((o) => o.kind === 'lens' && o.prescription.surfaces.some((s) => s.glassAfter?.toLowerCase() === glass.toLowerCase()))
      .map((o) => o.label);
    const at = [...nms].sort((a, b) => a - b).join(', ');
    lines.push(`${glass} index extrapolated beyond its data at ${at} nm${users.length ? ` (${users.join(', ')})` : ''}`);
  }
  return lines;
}

// The focus searches trace again, so they run once per setup, not once per frame.
const focusMemo = new WeakMap<Setup, Map<Id, FocusResult[]>>();
function memoFocus(setup: Setup, sourceId: Id): FocusResult[] {
  let bySource = focusMemo.get(setup);
  if (!bySource) focusMemo.set(setup, (bySource = new Map()));
  let results = bySource.get(sourceId);
  if (!results) bySource.set(sourceId, (results = focusPerWavelength(setup, sourceId)));
  return results;
}

// Point-source magnification retraces the fan at ±δ, so it also runs once per setup.
const magnificationMemo = new WeakMap<Setup, Map<Id, Map<Id, Magnification[]>>>();
function memoMagnification(setup: Setup, sourceId: Id): Map<Id, Magnification[]> {
  let bySource = magnificationMemo.get(setup);
  if (!bySource) magnificationMemo.set(setup, (bySource = new Map()));
  let results = bySource.get(sourceId);
  if (!results) bySource.set(sourceId, (results = screenMagnifications(setup, sourceId)));
  return results;
}

type ShiftCurve = { wavelengthNm: number; paraxialZ: number | null }[];
const curveMemo = new WeakMap<Setup, Map<string, ShiftCurve>>();
function memoCurve(setup: Setup, sourceId: Id, minNm: number, maxNm: number): ShiftCurve {
  let byKey = curveMemo.get(setup);
  if (!byKey) curveMemo.set(setup, (byKey = new Map()));
  const key = `${sourceId}|${minNm}|${maxNm}`;
  let curve = byKey.get(key);
  if (!curve) byKey.set(key, (curve = focusShiftCurve(setup, sourceId, minNm, maxNm, SHIFT_STEPS)));
  return curve;
}

function screensAfter(setup: Setup, source: Source): Screen[] {
  return setup.optics.filter((o): o is Screen => o.kind === 'screen' && o.z >= source.z).sort((a, b) => a.z - b.z);
}

/** Everything the readouts panel shows for one source. */
export function sourceReadout(
  setup: Setup,
  source: Source,
  trace: SetupTrace,
  gaussians: GaussianTrace[],
  labels: Record<Id, string>,
): SourceReadout {
  const offAxis = isOffAxis(setup, source);
  const screens = screensAfter(setup, source);
  const magnifications = screens.length ? memoMagnification(setup, source.id) : new Map<Id, Magnification[]>();
  const mAt = (screenId: Id, wavelengthNm: number) => magnifications.get(screenId)?.find((m) => m.wavelengthNm === wavelengthNm);
  const offAxisNote: Note[] = offAxis ? [{ text: OFF_AXIS_NOTE, warn: false }] : [];

  if (source.kind === 'gaussian') {
    const beams = gaussians.filter((g) => g.sourceId === source.id).sort(byWavelength);
    const { rows, notes } = gaussianRows(beams, labels);
    for (const screen of screens) {
      const radii = beams.map((g) => {
        const w = radiusAt(g, screen.z);
        return w === null || !Number.isFinite(w) ? null : w;
      });
      rows.push({ label: screen.label, heading: true, cells: beams.map(() => null) });
      rows.push({ label: 'w', sub: true, cells: radii.map((w) => (w === null ? NO_RAYS_CELL : { text: formatLength(w) })) });
      rows.push({
        label: 'M',
        sub: true,
        cells: beams.map((g, i) => (radii[i] === null ? DASH : (magnificationCell(mAt(screen.id, g.wavelengthNm)) ?? DASH))),
      });
    }
    return { wavelengthsNm: beams.map((g) => g.wavelengthNm), rows, notes: [...notes, ...offAxisNote] };
  }

  const results = [...memoFocus(setup, source.id)].sort(byWavelength);
  const wavelengthsNm = results.map((r) => r.wavelengthNm);
  const rows = focusRows(results, offAxis);
  const sourceTrace = trace.sources.find((t) => t.sourceId === source.id);
  for (const screen of screens) {
    const stats = sourceTrace ? screenStats(sourceTrace, screen.id) : [];
    const spots = wavelengthsNm.map((nm) => {
      const spot = stats.find((s) => s.wavelengthNm === nm);
      return spot && spot.centroidMm !== null ? { centroidMm: spot.centroidMm, rmsMm: spot.rmsMm ?? 0 } : null;
    });
    if (spots.every((s) => s === null)) {
      rows.push({ label: screen.label, heading: true, cells: spots.map(() => NO_RAYS_CELL) });
      continue;
    }
    const each = (cell: (spot: { centroidMm: number; rmsMm: number }, nm: number) => Cell | null, missing: Cell) =>
      spots.map((spot, i) => (spot ? (cell(spot, wavelengthsNm[i]!) ?? DASH) : missing));
    rows.push({ label: screen.label, heading: true, cells: spots.map(() => null) });
    rows.push({ label: 'Centroid y', sub: true, cells: each((s) => ({ text: mm(s.centroidMm) }), NO_RAYS_CELL) });
    rows.push({ label: 'RMS', sub: true, cells: each((s) => ({ text: formatLength(s.rmsMm) }), DASH) });
    rows.push({ label: 'M', sub: true, cells: each((_, nm) => magnificationCell(mAt(screen.id, nm)), DASH) });
    if (source.kind === 'point') {
      rows.push({
        label: 'Object-side RMS',
        sub: true,
        title: 'The spot RMS divided by |M|: its blur referred back to the object, ignoring diffraction',
        cells: each((s, nm) => objectSideRmsCell(mAt(screen.id, nm), s.rmsMm), DASH),
      });
    }
  }
  return { wavelengthsNm, rows, notes: offAxisNote };
}

function readoutTable(title: (Node | string)[], readout: SourceReadout): HTMLTableElement {
  const head = h(
    'tr',
    {},
    h('th', { class: 'ro-title', scope: 'col' }, ...title),
    ...readout.wavelengthsNm.map((nm) =>
      h('th', { class: 'ro-wavelength', scope: 'col' }, h('span', { class: 'ro-dot', style: `background: ${wavelengthColour(nm)}` }), `${nm} nm`),
    ),
  );
  const body = readout.rows.map((row) =>
    h(
      'tr',
      { class: row.heading ? 'ro-heading' : row.sub ? 'ro-sub' : undefined },
      h('th', { scope: 'row', title: row.title }, row.label),
      ...row.cells.map((cell) => (cell ? h('td', { class: cell.warn ? 'warn' : undefined, title: cell.title }, cell.text) : h('td'))),
    ),
  );
  return h('table', { class: 'readout-table' }, h('thead', {}, head), h('tbody', {}, ...body));
}

interface PlotRange {
  minNm: number;
  maxNm: number;
}

interface ReadoutsView {
  text: HTMLElement;
  plotTitle: HTMLElement;
  canvas: HTMLCanvasElement;
  plotMessage: HTMLElement;
  minControl: Control;
  maxControl: Control;
  plot: { range: PlotRange | null; sourceId: Id | null };
  last: { setup: Setup; selectedId: Id | null; trace: SetupTrace; gaussians: GaussianTrace[] } | null;
  rerender(): void;
}

const views = new WeakMap<HTMLElement, ReadoutsView>();

function defaultRange(source: Source): PlotRange {
  const lo = Math.min(...source.wavelengthsNm);
  const hi = Math.max(...source.wavelengthsNm);
  return {
    minNm: Math.max(MIN_RANGE_NM, Math.floor((lo - DEFAULT_RANGE_MARGIN_NM) / 10) * 10),
    maxNm: Math.ceil((hi + DEFAULT_RANGE_MARGIN_NM) / 10) * 10,
  };
}

function createView(el: HTMLElement): ReadoutsView {
  const text = h('div', { class: 'readouts-text' });
  const plotTitle = h('div', { class: 'plot-title' });
  const canvas = h('canvas', { class: 'shift-canvas', 'aria-label': 'Focal shift against wavelength' });
  const plotMessage = h('div', { class: 'plot-message muted' });
  const rangeSpec = (label: string) => ({
    key: label,
    label,
    unit: 'nm',
    validate: (v: number) => (Number.isFinite(v) && v > 0 ? null : 'Must be a positive wavelength'),
  });
  const plotState: ReadoutsView['plot'] = { range: null, sourceId: null };
  const minControl = numberControl({
    spec: rangeSpec('From'),
    read: () => plotState.range?.minNm ?? NaN,
    commit: (v) => setRange({ minNm: v, maxNm: plotState.range?.maxNm ?? v + 100 }),
    className: 'num range',
  });
  const maxControl = numberControl({
    spec: rangeSpec('To'),
    read: () => plotState.range?.maxNm ?? NaN,
    commit: (v) => setRange({ minNm: plotState.range?.minNm ?? v - 100, maxNm: v }),
    className: 'num range',
  });
  const view: ReadoutsView = {
    text,
    plotTitle,
    canvas,
    plotMessage,
    minControl,
    maxControl,
    plot: plotState,
    last: null,
    rerender: () => {},
  };
  function setRange(range: PlotRange) {
    if (range.minNm >= range.maxNm) {
      view.plotMessage.textContent = 'The range must run from a shorter to a longer wavelength';
      view.minControl.refresh();
      view.maxControl.refresh();
      return;
    }
    plotState.range = range;
    view.rerender();
  }
  const plot = h(
    'div',
    { class: 'shift-plot' },
    plotTitle,
    canvas,
    plotMessage,
    h(
      'div',
      { class: 'plot-range' },
      h('span', { class: 'muted' }, 'λ from'),
      view.minControl.input,
      h('span', { class: 'muted' }, 'to'),
      view.maxControl.input,
      h('span', { class: 'unit' }, 'nm'),
    ),
  );
  el.replaceChildren(h('div', { class: 'readouts-wrap' }, text, plot));
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => view.rerender()).observe(canvas);
  return view;
}

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

function niceStep(span: number, ticks: number): number {
  const raw = span / ticks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power;
}

function drawShiftPlot(view: ReadoutsView, curve: ShiftCurve, marks: number[]): void {
  const { canvas } = view;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!ctx || width < 10 || height < 10) return;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const points = curve.filter((p): p is { wavelengthNm: number; paraxialZ: number } => p.paraxialZ !== null && Number.isFinite(p.paraxialZ));
  if (points.length < 2) {
    view.plotMessage.textContent = 'No focus in this range';
    return;
  }
  const minZ = Math.min(...points.map((p) => p.paraxialZ));
  const maxShiftMm = Math.max(...points.map((p) => p.paraxialZ)) - minZ;
  const inMm = maxShiftMm >= 1;
  const scale = inMm ? 1 : 1e3;
  const shifts = points.map((p) => ({ x: p.wavelengthNm, y: (p.paraxialZ - minZ) * scale }));
  const yMax = Math.max(shifts.reduce((m, p) => Math.max(m, p.y), 0), inMm ? 1e-3 : 1e-3 * scale);
  const xMin = curve[0]!.wavelengthNm;
  const xMax = curve[curve.length - 1]!.wavelengthNm;

  const textColour = cssVar(canvas, '--muted', '#6a717c');
  const gridColour = cssVar(canvas, '--border', '#d6dae0');
  const lineColour = cssVar(canvas, '--text', '#1d2127');
  ctx.font = '10px system-ui, sans-serif';
  const left = 42;
  const right = 8;
  const top = 6;
  const bottom = 18;
  const px = (x: number) => left + ((x - xMin) / (xMax - xMin)) * (width - left - right);
  const py = (y: number) => height - bottom - (y / yMax) * (height - top - bottom);

  ctx.strokeStyle = gridColour;
  ctx.fillStyle = textColour;
  ctx.lineWidth = 1;
  const yStep = niceStep(yMax, 3);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let y = 0; y <= yMax * 1.0001; y += yStep) {
    ctx.beginPath();
    ctx.moveTo(left, Math.round(py(y)) + 0.5);
    ctx.lineTo(width - right, Math.round(py(y)) + 0.5);
    ctx.stroke();
    ctx.fillText(formatFull(Number(y.toPrecision(6))), left - 4, py(y));
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xStep = niceStep(xMax - xMin, 4);
  for (let x = Math.ceil(xMin / xStep) * xStep; x <= xMax; x += xStep) ctx.fillText(String(Math.round(x)), px(x), height - bottom + 4);
  ctx.save();
  ctx.translate(9, (height - bottom + top) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = 'middle';
  ctx.fillText(`Δz (${inMm ? 'mm' : 'µm'})`, 0, 0);
  ctx.restore();

  for (const nm of marks) {
    if (nm < xMin || nm > xMax) continue;
    ctx.strokeStyle = wavelengthColour(nm);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(px(nm)) + 0.5, top);
    ctx.lineTo(Math.round(px(nm)) + 0.5, height - bottom);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = lineColour;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let drawing = false;
  for (const p of curve) {
    if (p.paraxialZ === null || !Number.isFinite(p.paraxialZ)) {
      drawing = false;
      continue;
    }
    const x = px(p.wavelengthNm);
    const y = py((p.paraxialZ - minZ) * scale);
    if (drawing) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    drawing = true;
  }
  ctx.stroke();
}

function renderPlot(view: ReadoutsView, setup: Setup, selectedId: Id | null): void {
  const raySources = setup.sources.filter((s) => s.kind !== 'gaussian');
  const source = raySources.find((s) => s.id === selectedId) ?? raySources[0];
  view.plotMessage.textContent = '';
  if (!source) {
    view.plot.sourceId = null;
    view.plotTitle.textContent = 'Focal shift';
    view.plotMessage.textContent = 'Add a point or collimated source to plot its focal shift';
    view.canvas.hidden = true;
    return;
  }
  if (view.plot.sourceId !== source.id || !view.plot.range) {
    view.plot.sourceId = source.id;
    view.plot.range = defaultRange(source);
  }
  view.minControl.refresh();
  view.maxControl.refresh();
  view.canvas.hidden = false;
  view.plotTitle.textContent = `Focal shift of ${source.label} after the last optic`;
  const { minNm, maxNm } = view.plot.range;
  drawShiftPlot(view, memoCurve(setup, source.id, minNm, maxNm), source.wavelengthsNm);
}

/** Fills the readouts panel: per source, focus or waists per wavelength, screen spots, then warnings; and the focal-shift plot. */
export function renderReadouts(el: HTMLElement, state: AppState, trace: SetupTrace, gaussians: GaussianTrace[]): void {
  let view = views.get(el);
  if (!view) {
    view = createView(el);
    views.set(el, view);
  }
  const { setup, selectedId } = state;
  const last = view.last;
  if (last && last.setup === setup && last.selectedId === selectedId && last.trace === trace && last.gaussians === gaussians) return;
  view.last = { setup, selectedId, trace, gaussians };
  const current = view;
  view.rerender = () => renderPlot(current, setup, selectedId);

  const labels: Record<Id, string> = Object.fromEntries([...setup.sources, ...setup.optics].map((e) => [e.id, e.label]));
  const blocks: HTMLElement[] = setup.sources.map((source) => {
    const readout = sourceReadout(setup, source, trace, gaussians, labels);
    const title = [source.label || kindNames[source.kind], h('span', { class: 'muted' }, ` · ${kindNames[source.kind]}`)];
    return h(
      'div',
      { class: `readout-source${source.id === selectedId ? ' selected' : ''}` },
      readoutTable(title, readout),
      ...readout.notes.map((note) => h('div', { class: note.warn ? 'ro-note warn' : 'ro-note' }, note.text)),
    );
  });
  const warnings = describeWarnings(setup, trace.warnings);
  if (warnings.length) {
    blocks.push(
      h('div', { class: 'readout-source' }, h('h3', {}, 'Warnings'), ...warnings.map((w) => h('div', { class: 'line warn' }, w))),
    );
  }
  if (blocks.length === 0) blocks.push(h('p', { class: 'placeholder muted' }, 'Add a source to see focus and waist readouts.'));
  view.text.replaceChildren(...blocks);
  renderPlot(view, setup, selectedId);
}
