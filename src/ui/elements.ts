import lenses from '../data/lenses.json';
import { newId } from '../engine/io';
import { opticExtent } from '../engine/optic';
import type { GlassData, Id, LensPrescription, Optic, Setup, Source, TraceWarning } from '../engine/types';
import type { AppState, Store } from './store';

export const catalogue = lenses as LensPrescription[];
const DEFAULT_LENS = 'AC254-100-B';
const GAP_MM = 25;

export type SourceKind = Source['kind'];
export type OpticKind = Optic['kind'];

export const kindNames: Record<SourceKind | OpticKind, string> = {
  point: 'Point source',
  collimated: 'Collimated beam',
  gaussian: 'Gaussian beam',
  lens: 'Catalogue lens',
  ideal: 'Ideal lens',
  slm: 'SLM',
  aperture: 'Aperture',
  screen: 'Screen',
};

const labelPrefix: Record<SourceKind | OpticKind, string> = {
  point: 'S',
  collimated: 'S',
  gaussian: 'S',
  lens: 'L',
  ideal: 'L',
  slm: 'SLM ',
  aperture: 'Iris ',
  screen: 'Screen ',
};

export function isSource(item: Source | Optic): item is Source {
  return item.kind === 'point' || item.kind === 'collimated' || item.kind === 'gaussian';
}

export function findElement(setup: Setup, id: Id | null): Source | Optic | undefined {
  if (id === null) return undefined;
  return setup.sources.find((s) => s.id === id) ?? setup.optics.find((o) => o.id === id);
}

function nextLabel(setup: Setup, kind: SourceKind | OpticKind): string {
  const prefix = labelPrefix[kind];
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let highest = 0;
  for (const item of [...setup.sources, ...setup.optics]) {
    const match = pattern.exec(item.label);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}${highest + 1}`;
}

const roundMm = (z: number) => Math.round(z * 10) / 10;

/** The z just past the selected element, or past everything when nothing is selected. */
function zAfterSelection({ setup, selectedId }: AppState): number {
  const selected = findElement(setup, selectedId);
  if (selected) return isSource(selected) ? selected.z : opticExtent(selected)[1];
  const ends = [...setup.sources.map((s) => s.z), ...setup.optics.map((o) => opticExtent(o)[1])];
  return ends.length ? Math.max(...ends) : 0;
}

export function newSource(kind: SourceKind, state: AppState): Source {
  const { setup } = state;
  const starts = [...setup.sources.map((s) => s.z), ...setup.optics.map((o) => o.z - 100)];
  const base = {
    id: newId(),
    label: nextLabel(setup, kind),
    z: starts.length ? roundMm(Math.min(...starts)) : 0,
    y: 0,
    wavelengthsNm: [780],
  };
  switch (kind) {
    case 'point':
      return { ...base, kind, coneHalfAngleDeg: 'fill', rayCount: 11 };
    case 'collimated':
      return { ...base, kind, widthMm: 5, angleDeg: 0, rayCount: 11 };
    case 'gaussian':
      return { ...base, kind, angleDeg: 0, waistRadiusMm: 0.5, waistZ: base.z, m2: 1 };
  }
}

export function newOptic(kind: OpticKind, state: AppState, prescription?: LensPrescription): Optic {
  const common = { id: newId(), label: nextLabel(state.setup, kind), z: roundMm(zAfterSelection(state) + GAP_MM) };
  const placed = { ...common, decentreMm: 0, tiltDeg: 0 };
  switch (kind) {
    case 'lens': {
      const chosen = prescription ?? catalogue.find((p) => p.partNumber === DEFAULT_LENS);
      if (!chosen) throw new Error(`${DEFAULT_LENS} is missing from the bundled catalogue`);
      return { ...placed, kind, prescription: chosen, flipped: false };
    }
    case 'ideal':
      return { ...placed, kind, focalLengthMm: 100, apertureMm: 25.4 };
    case 'slm':
      return { ...placed, kind, apertureMm: 15.36, pixelPitchUm: 12.5, designWavelengthNm: 780, phase: [] };
    case 'aperture':
      return { ...common, kind, decentreMm: 0, diameterMm: 5 };
    case 'screen':
      return { ...common, kind };
  }
}

function insertAfter<T extends { id: Id }>(list: T[], item: T, afterId: Id | null): T[] {
  const index = afterId === null ? -1 : list.findIndex((x) => x.id === afterId);
  if (index < 0) return [...list, item];
  return [...list.slice(0, index + 1), item, ...list.slice(index + 1)];
}

/** Adds the element, and any glasses it needs, after the selection (in list order) as one undo step, and selects it. */
export function insertElement(store: Store, item: Source | Optic, glasses: Record<string, GlassData> = {}): void {
  const { selectedId } = store.get();
  store.apply((s) => {
    const withGlasses = Object.keys(glasses).length ? { ...s, glasses: { ...s.glasses, ...glasses } } : s;
    return isSource(item)
      ? { ...withGlasses, sources: insertAfter(s.sources, item, selectedId) }
      : { ...withGlasses, optics: insertAfter(s.optics, item, selectedId) };
  }, `Add ${item.label}`);
  store.select(item.id);
}

export function removeElement(setup: Setup, id: Id): Setup {
  return {
    ...setup,
    sources: setup.sources.filter((s) => s.id !== id),
    optics: setup.optics.filter((o) => o.id !== id),
  };
}

export function updateElement(setup: Setup, id: Id, update: (item: Source | Optic) => Source | Optic): Setup {
  return {
    ...setup,
    sources: setup.sources.map((s) => (s.id === id ? (update(s) as Source) : s)),
    optics: setup.optics.map((o) => (o.id === id ? (update(o) as Optic) : o)),
  };
}

/** Trace warnings as messages keyed by the element they concern. */
export function warningsByElement(setup: Setup, warnings: TraceWarning[]): Map<Id, string[]> {
  const byId = new Map<Id, string[]>();
  const add = (id: Id, message: string) => {
    const list = byId.get(id) ?? [];
    if (!list.includes(message)) list.push(message);
    byId.set(id, list);
  };
  const labelOf = (id: Id) => findElement(setup, id)?.label || id;
  for (const w of warnings) {
    switch (w.kind) {
      case 'overlap':
        add(w.ids[0], `Overlaps ${labelOf(w.ids[1])}`);
        add(w.ids[1], `Overlaps ${labelOf(w.ids[0])}`);
        break;
      case 'unknown-glass':
        add(w.opticId, `Unknown glass ${w.glass}: rays are blocked here`);
        break;
      case 'slm-pitch-limit':
        add(w.opticId, 'Phase gradient exceeds what the pixel pitch can show');
        break;
      case 'glass-extrapolated': {
        const glass = w.glass.toLowerCase();
        for (const o of setup.optics) {
          if (o.kind === 'lens' && o.prescription.surfaces.some((s) => s.glassAfter?.toLowerCase() === glass)) {
            add(o.id, `${w.glass} index extrapolated beyond its data at ${w.wavelengthNm} nm`);
          }
        }
        break;
      }
    }
  }
  return byId;
}
