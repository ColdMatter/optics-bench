import { radiusAt } from '../../engine/gaussian';
import { opticExtent } from '../../engine/optic';
import type { GaussianTrace, Id, Optic, Setup, Source } from '../../engine/types';
import { isTyping } from '../controls';
import { findElement, isSource, kindNames, removeElement, updateElement } from '../elements';
import type { AppState, Store } from '../store';
import { apertureJawsPx, collimatedBarPx, lensPolygons, planeEnds } from './draw';
import { pan, pxPerMmY, pxPerMmZ, toScreen, toWorld, zoomAbout, type View } from './view';

type Pt = [number, number];

const HIT_PX = 6;
const SOURCE_HIT_PX = 9;
const CLICK_SLOP_PX = 3;
const WHEEL_ZOOM_PER_PX = 0.0015;
const WHEEL_LINE_PX = 16;

function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(Math.max(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2, 0), 1);
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function inside(p: Pt, poly: Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function polygonDistance(p: Pt, poly: Pt[]): number {
  if (inside(p, poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, segmentDistance(p, poly[i]!, poly[(i + 1) % poly.length]!));
  return best;
}

/** Screen distance from p to an element, and how close counts as a hit. */
function distanceTo(view: View, item: Source | Optic, p: Pt): [number, number] {
  const px = (pts: Pt[]) => pts.map(([z, y]) => toScreen(view, z, y));
  switch (item.kind) {
    case 'lens':
      return [Math.min(...lensPolygons(item).map((poly) => polygonDistance(p, px(poly)))), HIT_PX];
    case 'ideal':
    case 'slm': {
      const [a, b] = px(planeEnds(item, item.apertureMm / 2));
      return [segmentDistance(p, a!, b!), HIT_PX];
    }
    case 'aperture':
      return [Math.min(...apertureJawsPx(view, item).map(([a, b]) => segmentDistance(p, a, b))), HIT_PX];
    case 'screen':
      return [Math.abs(p[0] - toScreen(view, item.z, 0)[0]), HIT_PX];
    case 'collimated': {
      const [a, b] = collimatedBarPx(view, item);
      return [segmentDistance(p, a, b), HIT_PX];
    }
    case 'point':
    case 'gaussian': {
      const [x, y] = toScreen(view, item.z, item.y);
      return [Math.hypot(p[0] - x, p[1] - y), SOURCE_HIT_PX];
    }
  }
}

/** The element nearest to (px, py) within its hit distance, or null. */
export function hitTest(view: View, setup: Setup, px: number, py: number): Id | null {
  let best: Id | null = null;
  let bestDistance = Infinity;
  for (const item of [...setup.sources, ...setup.optics]) {
    const [d, limit] = distanceTo(view, item, [px, py]);
    if (d <= limit && d < bestDistance) {
      best = item.id;
      bestDistance = d;
    }
  }
  return best;
}

export interface BenchHover {
  px: number;
  py: number;
  z: number;
  y: number;
  id: Id | null;
}

export interface BenchHooks {
  onHover?(hover: BenchHover | null): void;
  onFit?(): void;
}

const OFF_AXIS_NOTE = 'Tangential (meridional) rays only — sagittal focus not computed';

function formatMm(mm: number): string {
  return Math.abs(mm) < 1 ? `${(mm * 1e3).toPrecision(3)} µm` : `${mm.toPrecision(4)} mm`;
}

/** Tooltip lines at a bench point: the position, then w(z) of each Gaussian beam that reaches z. */
export function hoverLines(state: AppState, gaussians: GaussianTrace[], z: number, y: number): string[] {
  const fixed = (v: number, digits: number) => (Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v).toFixed(digits);
  const lines = [`z ${fixed(z, 2)} mm   y ${fixed(y, 3)} mm`];
  let offAxis = false;
  for (const g of gaussians) {
    const w = radiusAt(g, z);
    if (w === null || !Number.isFinite(w)) continue;
    const source = findElement(state.setup, g.sourceId);
    if (source?.kind === 'gaussian' && (source.y !== 0 || source.angleDeg !== 0)) offAxis = true;
    const passed = g.warnings.filter((wn) => {
      const optic = state.setup.optics.find((o) => o.id === wn.opticId);
      return optic !== undefined && opticExtent(optic)[0] <= z;
    });
    const reasons = [...new Set(passed.map((wn) => wn.kind))].join(', ');
    lines.push(`${source?.label || 'Gaussian'} ${g.wavelengthNm} nm: w = ${formatMm(w)}${reasons ? ` (unreliable: ${reasons})` : ''}`);
  }
  if (offAxis) lines.push(OFF_AXIS_NOTE);
  return lines;
}

/** Rounds a dragged coordinate to a step just below the size of one pixel, so values stay readable. */
function roundToPixel(value: number, mmPerPx: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(mmPerPx)));
  return Number(value.toFixed(Math.min(decimals, 6)));
}

interface Drag {
  kind: 'element';
  id: Id;
  axis: 'z' | 'y';
  startPx: number;
  startPy: number;
  start: Source | Optic;
  key: string;
}
interface Pan {
  kind: 'pan';
  lastPx: number;
  lastPy: number;
  moved: boolean;
  downPx: number;
  downPy: number;
}

function moved(item: Source | Optic, axis: 'z' | 'y', value: number, start: Source | Optic): Source | Optic {
  if (axis === 'z') {
    if (item.kind === 'gaussian' && start.kind === 'gaussian') return { ...item, z: value, waistZ: start.waistZ + (value - start.z) };
    return { ...item, z: value };
  }
  if (isSource(item)) return { ...item, y: value };
  return item.kind === 'screen' ? item : { ...item, decentreMm: value };
}

function heightOf(item: Source | Optic): number | null {
  if (isSource(item)) return item.y;
  return item.kind === 'screen' ? null : item.decentreMm;
}

export function attachBenchInteraction(
  canvas: HTMLCanvasElement,
  store: Store,
  getView: () => View,
  setView: (v: View) => void,
  hooks: BenchHooks = {},
): void {
  let gesture: Drag | Pan | null = null;
  let gestureCount = 0;

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };
  const reportHover = (px: number, py: number, id: Id | null) => {
    const [z, y] = toWorld(getView(), px, py);
    hooks.onHover?.({ px, py, z, y, id });
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const [px, py] = local(e);
    const id = hitTest(getView(), store.get().setup, px, py);
    canvas.setPointerCapture?.(e.pointerId);
    if (id) {
      store.select(id);
      const start = findElement(store.get().setup, id)!;
      const axis = e.altKey ? 'y' : 'z';
      gesture = { kind: 'element', id, axis, startPx: px, startPy: py, start, key: `drag:${id}:${++gestureCount}` };
      canvas.style.cursor = axis === 'y' && heightOf(start) === null ? 'not-allowed' : 'grabbing';
    } else {
      gesture = { kind: 'pan', lastPx: px, lastPy: py, downPx: px, downPy: py, moved: false };
    }
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    const [px, py] = local(e);
    const view = getView();
    if (gesture?.kind === 'pan') {
      if (!gesture.moved && Math.hypot(px - gesture.downPx, py - gesture.downPy) <= CLICK_SLOP_PX) return;
      gesture.moved = true;
      canvas.style.cursor = 'move';
      setView(pan(view, px - gesture.lastPx, py - gesture.lastPy));
      gesture.lastPx = px;
      gesture.lastPy = py;
      reportHover(px, py, null);
      return;
    }
    if (gesture?.kind === 'element') {
      const drag = gesture;
      const current = findElement(store.get().setup, drag.id);
      if (!current) return;
      let value: number;
      if (drag.axis === 'z') {
        const raw = drag.start.z + (px - drag.startPx) / pxPerMmZ(view);
        value = e.shiftKey ? Math.round(raw) : roundToPixel(raw, 1 / pxPerMmZ(view));
        if (!Number.isFinite(value) || value === current.z) return;
      } else {
        const startY = heightOf(drag.start);
        if (startY === null) return;
        const raw = startY - (py - drag.startPy) / pxPerMmY(view);
        value = roundToPixel(raw, 1 / pxPerMmY(view));
        if (!Number.isFinite(value) || value === heightOf(current)) return;
      }
      store.apply(
        (s) => updateElement(s, drag.id, (item) => moved(item, drag.axis, value, drag.start)),
        `Move ${current.label || kindNames[current.kind]}`,
        { coalesce: drag.key },
      );
      reportHover(px, py, drag.id);
      return;
    }
    const id = hitTest(view, store.get().setup, px, py);
    canvas.style.cursor = id ? 'grab' : '';
    reportHover(px, py, id);
  });

  const end = (e: PointerEvent) => {
    if (!gesture) return;
    const [px, py] = local(e);
    if (gesture.kind === 'pan' && !gesture.moved && e.type === 'pointerup') store.select(null);
    gesture = null;
    canvas.releasePointerCapture?.(e.pointerId);
    const id = hitTest(getView(), store.get().setup, px, py);
    canvas.style.cursor = id ? 'grab' : '';
    reportHover(px, py, id);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => {
    if (!gesture) hooks.onHover?.(null);
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const [px, py] = local(e);
      // Browsers turn Shift+wheel into horizontal scrolling.
      const delta = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? WHEEL_LINE_PX : 1);
      setView(zoomAbout(getView(), px, py, Math.exp(-delta * WHEEL_ZOOM_PER_PX), e.shiftKey ? 'y' : 'both'));
      reportHover(px, py, hitTest(getView(), store.get().setup, px, py));
    },
    { passive: false },
  );

  canvas.addEventListener('dblclick', (e) => {
    const [px, py] = local(e);
    if (!hitTest(getView(), store.get().setup, px, py)) hooks.onFit?.();
  });

  window.addEventListener('keydown', (e) => {
    if ((e.key !== 'Delete' && e.key !== 'Backspace') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTyping(e.target) || document.querySelector('dialog[open]')) return;
    const { setup, selectedId } = store.get();
    const item = findElement(setup, selectedId);
    if (!item) return;
    e.preventDefault();
    store.apply((s) => removeElement(s, item.id), `Remove ${item.label || kindNames[item.kind]}`);
  });
}
