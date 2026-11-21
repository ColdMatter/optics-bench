import { numberRules, type NumberRule } from '../engine/io';
import { flipPrescription, lensThickness } from '../engine/lens';
import type { CatalogueLens, Id, Optic, PhaseTerm, PointSource, Slm, Source } from '../engine/types';
import { formatFull, h, numberControl, numberListControl, pickFile, textControl, type Control } from './controls';
import { findElement, kindNames, updateElement } from './elements';
import type { AppState, Store } from './store';

export interface FieldSpec {
  key: string;
  label: string;
  unit: string;
  validate: (v: number) => string | null;
}

const DEG = '°';
const DEFAULT_CONE_DEG = 5;

const ruleCheck = (r: NumberRule) => (v: number) =>
  !Number.isFinite(v) ? 'Must be a finite number' : r.ok(v) ? null : `Must be ${r.expected}`;
const field = (key: string, label: string, unit: string, r: NumberRule): FieldSpec => ({ key, label, unit, validate: ruleCheck(r) });

/** Every numeric property of an element; `wavelengthsNm` is a list, each entry checked by `validate`. */
export function fieldsFor(item: Source | Optic): FieldSpec[] {
  const { finite, positive, nonNegative, nonZero, tilt, cone, count, m2 } = numberRules;
  const sourceBase = [field('z', 'z', 'mm', finite), field('y', 'Height y', 'mm', finite), field('wavelengthsNm', 'Wavelengths', 'nm', positive)];
  const placement = (zLabel: string) => [
    field('z', zLabel, 'mm', finite),
    field('decentreMm', 'Decentre', 'mm', finite),
    field('tiltDeg', 'Tilt', DEG, tilt),
  ];
  switch (item.kind) {
    case 'point':
      return [...sourceBase, field('coneHalfAngleDeg', 'Cone half-angle', DEG, cone), field('rayCount', 'Ray count', '', count)];
    case 'collimated':
      return [
        ...sourceBase,
        field('widthMm', 'Full width', 'mm', nonNegative),
        field('angleDeg', 'Field angle', DEG, finite),
        field('rayCount', 'Ray count', '', count),
      ];
    case 'gaussian':
      return [
        { ...sourceBase[0]!, label: 'Start z' },
        ...sourceBase.slice(1),
        field('angleDeg', 'Angle', DEG, finite),
        field('waistRadiusMm', 'Waist w₀', 'mm', positive),
        field('waistZ', 'Waist z', 'mm', finite),
        field('m2', 'M²', '', m2),
      ];
    case 'lens':
      return placement('Vertex z');
    case 'ideal':
      return [...placement('z'), field('focalLengthMm', 'Focal length', 'mm', nonZero), field('apertureMm', 'Aperture ⌀', 'mm', positive)];
    case 'slm':
      return [
        ...placement('z'),
        field('apertureMm', 'Aperture', 'mm', positive),
        field('pixelPitchUm', 'Pixel pitch', 'µm', positive),
        field('designWavelengthNm', 'Design λ₀', 'nm', positive),
      ];
    case 'aperture':
      return [field('z', 'z', 'mm', finite), field('decentreMm', 'Decentre', 'mm', finite), field('diameterMm', 'Diameter', 'mm', positive)];
    case 'screen':
      return [field('z', 'z', 'mm', finite)];
  }
}

export function phaseTermFields(term: PhaseTerm): FieldSpec[] {
  switch (term.kind) {
    case 'fresnel':
      return [field('focalLengthMm', 'f at λ₀', 'mm', numberRules.nonZero)];
    case 'blaze':
      return [field('angleDeg', 'Deflection at λ₀', DEG, numberRules.finite)];
    case 'polynomial':
      return [field('coefficientsRad', 'a₁, a₂, …', 'rad', numberRules.finite)];
    case 'table':
      return [];
  }
}

const phaseTermNames: Record<PhaseTerm['kind'], string> = {
  fresnel: 'Fresnel lens',
  blaze: 'Blaze',
  polynomial: 'Polynomial Σ aₖ (y/R)ᵏ, R = aperture/2',
  table: 'Table',
};

function csvNumber(cell: string): number {
  return cell === '' ? Number.NaN : Number(cell);
}

/** Reads a `y_mm, phase_rad` table; an optional header line and `#` comments are skipped. */
export function parsePhaseCsv(text: string): { yMm: number[]; phaseRad: number[] } {
  const yMm: number[] = [];
  const phaseRad: number[] = [];
  let first = true;
  text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) return;
      const lineNo = index + 1;
      const cells = line.split(/\s*[,;\t]\s*/);
      const isFirst = first;
      first = false;
      if (isFirst && cells.some((c) => !Number.isFinite(csvNumber(c)))) return;
      if (cells.length !== 2) throw new Error(`line ${lineNo}: expected 2 columns (y_mm, phase_rad), found ${cells.length}`);
      const [y, phase] = cells.map(csvNumber) as [number, number];
      if (!Number.isFinite(y) || !Number.isFinite(phase)) throw new Error(`line ${lineNo}: "${line}" is not two numbers`);
      const previous = yMm[yMm.length - 1];
      if (previous !== undefined && y <= previous) {
        throw new Error(`line ${lineNo}: y_mm must increase strictly (${y} after ${previous})`);
      }
      yMm.push(y);
      phaseRad.push(phase);
    });
  if (yMm.length < 2) throw new Error(`needs at least 2 rows of y_mm, phase_rad; found ${yMm.length}`);
  return { yMm, phaseRad };
}

type Item = Source | Optic;
type Bag = Record<string, unknown>;

let fieldSerial = 0;

function fieldRow(label: string, unit: string, control: Control, extra?: Node): HTMLElement {
  const id = `field-${++fieldSerial}`;
  control.input.id = id;
  return h(
    'div',
    { class: 'field' },
    h('label', { for: id, title: label }, label),
    control.input,
    h('span', { class: 'unit' }, unit),
    extra,
    control.message,
  );
}

function shapeOf(item: Item | undefined): string {
  if (!item) return '';
  const phase = item.kind === 'slm' ? item.phase.map((t) => t.kind).join(',') : '';
  return `${item.id}|${item.kind}|${phase}`;
}

function radius(curvature: number): string {
  return curvature === 0 ? '∞' : (1 / curvature).toFixed(2);
}

export interface PropertiesPanel {
  render(state: AppState, warnings: Map<Id, string[]>): void;
}

export function createPropertiesPanel(container: HTMLElement, store: Store): PropertiesPanel {
  let shape: string | null = null;
  let current: Item | undefined;
  let refreshers: (() => void)[] = [];
  const warningsBox = h('ul', { class: 'prop-warnings' });

  const update = (label: string, change: (item: Item) => Item) => {
    const target = current;
    if (!target) return;
    store.apply((s) => updateElement(s, target.id, change), `${label} of ${target.label || kindNames[target.kind]}`);
  };
  const setKey = (key: string, label: string, value: unknown) =>
    update(`Set ${label}`, (item) => ({ ...item, [key]: value }) as Item);
  const read = (key: string) => (current as unknown as Bag)[key];

  function numericFields(item: Item): HTMLElement {
    const grid = h('div', { class: 'fields' });
    const label = textControl({ label: 'Label', read: () => current?.label ?? '', commit: (v) => setKey('label', 'label', v) });
    refreshers.push(label.refresh);
    grid.append(fieldRow('Label', '', label));
    for (const spec of fieldsFor(item)) {
      if (spec.key === 'wavelengthsNm') {
        const control = numberListControl({
          spec,
          allowEmpty: false,
          read: () => read(spec.key) as number[],
          commit: (v) => setKey(spec.key, spec.label, v),
        });
        refreshers.push(control.refresh);
        grid.append(fieldRow(spec.label, spec.unit, control));
      } else if (spec.key === 'coneHalfAngleDeg') {
        grid.append(coneRow(spec));
      } else {
        const control = numberControl({ spec, read: () => read(spec.key) as number, commit: (v) => setKey(spec.key, spec.label, v) });
        refreshers.push(control.refresh);
        grid.append(fieldRow(spec.label, spec.unit, control));
      }
    }
    return grid;
  }

  function coneRow(spec: FieldSpec): HTMLElement {
    const cone = () => (current as PointSource).coneHalfAngleDeg;
    const control = numberControl({
      spec,
      read: () => (cone() === 'fill' ? Number.NaN : (cone() as number)),
      commit: (v) => setKey(spec.key, spec.label, v),
    });
    const fill = h('input', { type: 'checkbox' });
    fill.addEventListener('change', () => setKey(spec.key, spec.label, fill.checked ? 'fill' : DEFAULT_CONE_DEG));
    refreshers.push(() => {
      fill.checked = cone() === 'fill';
      control.input.disabled = fill.checked;
      control.input.placeholder = fill.checked ? 'fill' : '';
      control.refresh();
    });
    return fieldRow(spec.label, spec.unit, control, h('label', { class: 'check' }, fill, 'fill first optic'));
  }

  function lensSection(): HTMLElement {
    const lens = () => current as CatalogueLens;
    const p = lens().prescription;
    const sourceText = p.source === 'zmx' ? 'from Zemax file' : 'from drawing';
    const sourceNode = /^https?:\/\//.test(p.sourceRef)
      ? h('a', { href: p.sourceRef, target: '_blank', rel: 'noopener' }, sourceText)
      : h('span', { title: p.sourceRef }, sourceText);
    const flip = h('input', { type: 'checkbox' });
    flip.addEventListener('change', () =>
      update(flip.checked ? 'Flip' : 'Unflip', (item) => ({ ...(item as CatalogueLens), flipped: flip.checked })),
    );
    const body = h('tbody');
    const thickness = h('span', { class: 'num' });
    const hasConic = p.surfaces.some((s) => s.conic !== 0);
    const hasAsphere = p.surfaces.some((s) => s.asphere.length > 0);
    refreshers.push(() => {
      flip.checked = lens().flipped;
      const shown = lens().flipped ? flipPrescription(lens().prescription) : lens().prescription;
      thickness.textContent = `${formatFull(lensThickness(shown))} mm`;
      body.replaceChildren(
        ...shown.surfaces.map((s, i) =>
          h(
            'tr',
            {},
            h('td', {}, String(i + 1)),
            h('td', { class: 'num' }, radius(s.curvature)),
            h('td', { class: 'num' }, formatFull(s.thicknessToNextMm)),
            h('td', {}, s.glassAfter ?? 'air'),
            h('td', { class: 'num' }, formatFull(2 * s.semiDiameterMm)),
            hasConic && h('td', { class: 'num' }, formatFull(s.conic)),
            hasAsphere && h('td', { class: 'num' }, s.asphere.length ? `${s.asphere.length} terms` : '—'),
          ),
        ),
      );
    });
    return h(
      'div',
      { class: 'lens-info' },
      h(
        'dl',
        { class: 'facts' },
        h('dt', {}, 'Part'),
        h('dd', {}, `${p.partNumber}`, p.vendor && h('span', { class: 'muted' }, ` · ${p.vendor}`)),
        h('dt', {}, 'Data'),
        h('dd', {}, sourceNode),
        h('dt', {}, 'Centre thickness'),
        h('dd', {}, thickness),
      ),
      h('label', { class: 'check flip' }, flip, 'Flip (light meets the last surface first)'),
      h(
        'table',
        { class: 'surfaces' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { title: 'In the order the light meets them' }, '#'),
            h('th', { class: 'num' }, 'R (mm)'),
            h('th', { class: 'num' }, 't (mm)'),
            h('th', {}, 'Glass after'),
            h('th', { class: 'num' }, '⌀ (mm)'),
            hasConic && h('th', { class: 'num' }, 'Conic'),
            hasAsphere && h('th', { class: 'num' }, 'Asphere'),
          ),
        ),
        body,
      ),
    );
  }

  function phaseSection(slm: Slm): HTMLElement {
    const terms = () => (current as Slm).phase;
    const setTerms = (label: string, next: PhaseTerm[]) => update(label, (item) => ({ ...(item as Slm), phase: next }));
    const termCard = (term: PhaseTerm, index: number) => {
      const remove = h('button', { class: 'icon-btn', title: 'Remove this term', 'aria-label': `Remove ${phaseTermNames[term.kind]} term` }, '×');
      remove.addEventListener('click', () => setTerms('Remove phase term', terms().filter((_, i) => i !== index)));
      const card = h('div', { class: 'term' }, h('div', { class: 'term-head' }, h('span', {}, phaseTermNames[term.kind]), remove));
      const termValue = (key: string) => (terms()[index] as unknown as Bag)[key];
      const setTermValue = (key: string, label: string, value: unknown) =>
        setTerms(
          `Set ${label}`,
          terms().map((t, i) => (i === index ? ({ ...t, [key]: value } as PhaseTerm) : t)),
        );
      const grid = h('div', { class: 'fields' });
      for (const spec of phaseTermFields(term)) {
        const control =
          spec.key === 'coefficientsRad'
            ? numberListControl({
                spec,
                allowEmpty: true,
                read: () => termValue(spec.key) as number[],
                commit: (v) => setTermValue(spec.key, 'polynomial coefficients', v),
              })
            : numberControl({ spec, read: () => termValue(spec.key) as number, commit: (v) => setTermValue(spec.key, spec.label, v) });
        refreshers.push(control.refresh);
        grid.append(fieldRow(spec.label, spec.unit, control));
      }
      if (term.kind === 'table') {
        const summary = h('div', { class: 'term-summary num' });
        refreshers.push(() => {
          const t = terms()[index];
          if (t?.kind !== 'table') return;
          const lo = Math.min(...t.phaseRad);
          const hi = Math.max(...t.phaseRad);
          summary.textContent =
            `${t.yMm.length} points, y ${formatFull(t.yMm[0]!)} … ${formatFull(t.yMm[t.yMm.length - 1]!)} mm, ` +
            `φ ${formatFull(lo)} … ${formatFull(hi)} rad`;
        });
        card.append(summary);
      }
      card.append(grid);
      return card;
    };

    const csvError = h('span', { class: 'field-error', role: 'alert' });
    csvError.hidden = true;
    const addButton = (label: string, term: PhaseTerm) => {
      const b = h('button', {}, label);
      b.addEventListener('click', () => setTerms(`Add ${term.kind} term`, [...terms(), term]));
      return b;
    };
    const loadCsv = h('button', {}, 'Load table from CSV…');
    loadCsv.addEventListener('click', async () => {
      const file = await pickFile('.csv,text/csv,text/plain');
      if (!file) return;
      try {
        const table = parsePhaseCsv(await file.text());
        csvError.hidden = true;
        setTerms('Load phase table', [...terms(), { kind: 'table', ...table }]);
      } catch (e) {
        csvError.textContent = `${file.name}: ${(e as Error).message}`;
        csvError.hidden = false;
      }
    });

    return h(
      'div',
      { class: 'phase' },
      h('div', { class: 'section-head' }, 'Phase profile φ₀(y)', h('span', { class: 'muted' }, ' — sum of the terms, at λ₀')),
      slm.phase.length === 0 ? h('p', { class: 'muted empty-terms' }, 'No phase terms: the SLM acts as a plain window.') : null,
      ...slm.phase.map(termCard),
      h(
        'div',
        { class: 'term-actions' },
        addButton('+ Fresnel lens', { kind: 'fresnel', focalLengthMm: 500 }),
        addButton('+ Blaze', { kind: 'blaze', angleDeg: 0.5 }),
        addButton('+ Polynomial', { kind: 'polynomial', coefficientsRad: [0] }),
        loadCsv,
      ),
      csvError,
    );
  }

  function build(item: Item | undefined) {
    refreshers = [];
    if (!item) {
      container.replaceChildren(h('p', { class: 'muted placeholder' }, 'Select an element in the table to edit it.'));
      return;
    }
    const title = h('span', { class: 'prop-title' });
    refreshers.push(() => (title.textContent = current?.label ?? ''));
    const sections = [
      h('div', { class: 'prop-head' }, h('span', { class: 'prop-kind' }, kindNames[item.kind]), title),
      warningsBox,
      numericFields(item),
    ];
    if (item.kind === 'lens') sections.push(lensSection());
    if (item.kind === 'slm') sections.push(phaseSection(item));
    container.replaceChildren(...sections);
  }

  return {
    render(state, warnings) {
      current = findElement(state.setup, state.selectedId);
      const nextShape = shapeOf(current);
      if (nextShape !== shape) {
        shape = nextShape;
        build(current);
      }
      const messages = current ? (warnings.get(current.id) ?? []) : [];
      warningsBox.replaceChildren(...messages.map((m) => h('li', {}, m)));
      warningsBox.hidden = messages.length === 0;
      for (const refresh of refreshers) refresh();
    },
  };
}
