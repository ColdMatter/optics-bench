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
const UNRELIABLE = 'unreliable:';
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

/**
 * The magnification suffix for a screen line: `, M = −1.500`, or why there is none. Given a point
 * source's spot RMS, it adds the blur referred back to the object, RMS/|M|.
 */
export function formatMagnification(m: Magnification | undefined, spotRmsMm?: number): string {
  if (!m) return '';
  if (m.value === null) {
    if (m.reason === 'edge-ray-blocked') return ', M: edge ray blocked';
    if (m.reason === 'undefined') return ', M undefined (no beam width)';
    return ', M unavailable';
  }
  const v = Math.abs(m.value) < 1e-12 ? 0 : m.value;
  const objectSide =
    spotRmsMm !== undefined && Math.abs(v) > 1e-9 ? `, object-side RMS ${formatLength(spotRmsMm / Math.abs(v))}` : '';
  return `, M = ${v.toPrecision(4)}${objectSide}`;
}

const signed = (lengthMm: number) => `${lengthMm < 0 ? '' : '+'}${formatLength(lengthMm)}`;

function focusLine(r: FocusResult, offAxis: boolean): string {
  const head = `${r.wavelengthNm} nm:`;
  if (r.status === 'collimated') return `${head} no focus (collimated)`;
  if (r.status === 'no-rays') return `${head} ${NO_RAYS}`;
  const at = (z: number) => `${r.approximate ? 'approx. ' : ''}z = ${mm(z)}`;
  const parts: string[] = [];
  if (r.paraxialZ !== null) parts.push(`paraxial focus at ${at(r.paraxialZ)}`);
  if (r.bestZ !== null) {
    const details = [`RMS ${formatLength(r.rmsAtBestMm ?? 0)}`];
    if (offAxis && r.imageHeightMm !== null) details.push(`height y = ${mm(r.imageHeightMm)}`);
    parts.push(`best focus at ${at(r.bestZ)} (${details.join(', ')})`);
  }
  return `${head} ${parts.join('; ')}`;
}

/** Focus lines for one ray source: a line per wavelength, then the shift between neighbouring wavelengths. */
export function formatFocus(results: FocusResult[], offAxis: boolean): string[] {
  const lines = results.map((r) => focusLine(r, offAxis));
  const sorted = [...results].sort((a, b) => a.wavelengthNm - b.wavelengthNm);
  for (let i = 1; i < sorted.length; i++) {
    const short = sorted[i - 1]!;
    const long = sorted[i]!;
    const key = short.paraxialZ !== null && long.paraxialZ !== null ? 'paraxialZ' : 'bestZ';
    const zShort = short[key];
    const zLong = long[key];
    if (zShort === null || zLong === null) continue;
    lines.push(`Δfocus ${short.wavelengthNm}→${long.wavelengthNm} nm: ${signed(zLong - zShort)}`);
  }
  if (offAxis) lines.push(OFF_AXIS_NOTE);
  return lines;
}

/** Waists of one Gaussian beam at one wavelength, then why they may be unreliable. */
export function formatGaussian(trace: GaussianTrace, labels: Record<Id, string>): string[] {
  const name = (id: Id) => labels[id] || id;
  const head = `${trace.wavelengthNm} nm`;
  const lines = trace.waists.map((w) => {
    const where = w.afterOpticId === null ? `${head} input waist` : `${head} after ${name(w.afterOpticId)}`;
    return w.collimated
      ? `${where}: collimated (w₀ = ${formatLength(w.radiusMm)})`
      : `${where}: w₀ = ${formatLength(w.radiusMm)} at z = ${mm(w.z)}`;
  });
  if (trace.centre.blockedBy !== null) lines.push(`${head}: beam blocked at ${name(trace.centre.blockedBy)}`);
  for (const w of trace.warnings) {
    lines.push(
      w.kind === 'clipped'
        ? `${head} ${UNRELIABLE} beam clipped at ${name(w.opticId)}`
        : `${head} ${UNRELIABLE} centre ray meets ${name(w.opticId)} tilted by more than ${TILT_LIMIT_DEG}°`,
    );
  }
  return lines;
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

function lineClass(line: string): string {
  if (line === OFF_AXIS_NOTE) return 'note';
  if (line.includes(UNRELIABLE) || line.includes(NO_RAYS) || line.includes('blocked at') || line.includes('edge ray blocked')) {
    return 'warn';
  }
  if (line.startsWith('Δfocus')) return 'shift';
  return '';
}

function screensAfter(setup: Setup, source: Source): Screen[] {
  return setup.optics.filter((o): o is Screen => o.kind === 'screen' && o.z >= source.z).sort((a, b) => a.z - b.z);
}

function sourceLines(setup: Setup, source: Source, trace: SetupTrace, gaussians: GaussianTrace[], labels: Record<Id, string>): string[] {
  const offAxis = isOffAxis(setup, source);
  const screens = screensAfter(setup, source);
  const magnifications = screens.length ? memoMagnification(setup, source.id) : new Map<Id, Magnification[]>();
  const magnificationAt = (screenId: Id, wavelengthNm: number, spotRmsMm?: number) =>
    formatMagnification(magnifications.get(screenId)?.find((m) => m.wavelengthNm === wavelengthNm), spotRmsMm);
  if (source.kind === 'gaussian') {
    const beams = gaussians.filter((g) => g.sourceId === source.id);
    const lines = beams.flatMap((g) => formatGaussian(g, labels));
    for (const screen of screens) {
      for (const g of beams) {
        const w = radiusAt(g, screen.z);
        lines.push(
          `${screen.label}, ${g.wavelengthNm} nm: ${
            w === null || !Number.isFinite(w) ? NO_RAYS : `w = ${formatLength(w)}${magnificationAt(screen.id, g.wavelengthNm)}`
          }`,
        );
      }
    }
    if (offAxis) lines.push(OFF_AXIS_NOTE);
    return lines;
  }
  const focusLines = formatFocus(memoFocus(setup, source.id), offAxis).filter((l) => l !== OFF_AXIS_NOTE);
  const sourceTrace = trace.sources.find((t) => t.sourceId === source.id);
  const screenLines = screens.flatMap((screen) =>
    (sourceTrace ? screenStats(sourceTrace, screen.id) : []).map((spot) => {
      const head = `${screen.label}, ${spot.wavelengthNm} nm:`;
      return spot.centroidMm === null
        ? `${head} ${NO_RAYS}`
        : `${head} ${spot.heightsMm.length} rays, centroid y = ${mm(spot.centroidMm)}, RMS ${formatLength(spot.rmsMm ?? 0)}` +
            magnificationAt(screen.id, spot.wavelengthNm, source.kind === 'point' ? (spot.rmsMm ?? 0) : undefined);
    }),
  );
  return [...focusLines, ...screenLines, ...(offAxis ? [OFF_AXIS_NOTE] : [])];
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
    const lines = sourceLines(setup, source, trace, gaussians, labels);
    return h(
      'div',
      { class: `readout-source${source.id === selectedId ? ' selected' : ''}` },
      h(
        'h3',
        {},
        source.label || kindNames[source.kind],
        h('span', { class: 'muted' }, ` · ${kindNames[source.kind]}`),
      ),
      ...lines.map((line) => h('div', { class: `line ${lineClass(line)}` }, line)),
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
