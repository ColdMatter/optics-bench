import { radiusAt, traceGaussian } from '../engine/gaussian';
import { collimationError, solve, TOLERANCE, type SolveResult, type Target, type Variable } from '../engine/solver';
import { defaultEndZ, lookupFor } from '../engine/trace';
import type { GaussianSource, Id, Optic, Setup } from '../engine/types';
import { formatFull, h, numberControl } from './controls';
import type { FieldSpec } from './properties';
import { formatLength } from './readouts';
import type { AppState, Store } from './store';

type TargetKind = Target['kind'];
const targetKindNames: Record<TargetKind, string> = {
  radiusAt: 'Beam radius w at z',
  waistRadius: 'Final waist radius w₀',
  waistPosition: 'Final waist position',
  collimated: 'Collimated output',
};

interface TargetRow {
  kind: TargetKind;
  sourceId: Id;
  sourceLabel: string;
  wavelengthNm: number;
  z: number;
  radiusMm: number;
}
interface VariableRow {
  opticId: Id;
  opticLabel: string;
  minZ: number;
  maxZ: number;
}
interface Proposal {
  forSetup: Setup;
  result: SolveResult;
  variables: VariableRow[];
  achieved: string[];
}

const VARIABLE_HALF_RANGE_MM = 50;
const DEFAULT_RADIUS_MM = 1;
const TAIL_MM = 50;

const mm = (v: number) => `${v.toFixed(3)} mm`;
const isMovable = (o: Optic) => o.kind === 'lens' || o.kind === 'ideal' || o.kind === 'slm';
const gaussianSources = (setup: Setup) => setup.sources.filter((s): s is GaussianSource => s.kind === 'gaussian');

function toTarget(row: TargetRow): Target {
  const base = { sourceId: row.sourceId, wavelengthNm: row.wavelengthNm };
  switch (row.kind) {
    case 'radiusAt':
      return { kind: 'radiusAt', ...base, z: row.z, radiusMm: row.radiusMm };
    case 'waistRadius':
      return { kind: 'waistRadius', ...base, radiusMm: row.radiusMm };
    case 'waistPosition':
      return { kind: 'waistPosition', ...base, z: row.z };
    case 'collimated':
      return { kind: 'collimated', ...base };
  }
}

/** What the beam does at a target in `setup`, beside what was asked. */
function achieved(setup: Setup, target: Target, labels: Map<Id, string>): string {
  const source = gaussianSources(setup).find((s) => s.id === target.sourceId)!;
  const endZ = Math.max(defaultEndZ(setup), 'z' in target ? target.z + Math.max(TAIL_MM, 0.1 * Math.abs(target.z)) : -Infinity);
  const trace = traceGaussian(source, setup.optics, target.wavelengthNm, lookupFor(setup.glasses), endZ);
  const head = `${source.label} ${target.wavelengthNm} nm`;
  if (trace.centre.blockedBy !== null) return `${head}: beam blocked at ${labels.get(trace.centre.blockedBy) ?? trace.centre.blockedBy}`;
  const last = trace.waists[trace.waists.length - 1]!;
  const after = last.afterOpticId === null ? 'input waist' : `after ${labels.get(last.afterOpticId) ?? last.afterOpticId}`;
  switch (target.kind) {
    case 'radiusAt': {
      const w = radiusAt(trace, target.z);
      return `${head}: w at z = ${mm(target.z)} is ${w === null ? 'not reached' : formatLength(w)} (target ${formatLength(target.radiusMm)})`;
    }
    case 'waistRadius':
      return `${head}: w₀ ${after} is ${formatLength(last.radiusMm)} (target ${formatLength(target.radiusMm)})`;
    case 'waistPosition':
      return last.collimated
        ? `${head}: collimated ${after} (target waist at z = ${mm(target.z)})`
        : `${head}: waist ${after} at z = ${mm(last.z)} (target ${mm(target.z)})`;
    case 'collimated': {
      const percent = (fraction: number) => `${formatFull(Number((100 * fraction).toPrecision(2)))} %`;
      const error = Math.abs(collimationError(trace, setup));
      const verdict = error < TOLERANCE.collimated ? 'collimated' : 'not collimated';
      return `${head}: ${verdict} ${after}; collimation error ${percent(error)} (tolerance ${percent(TOLERANCE.collimated)})`;
    }
  }
}

function selectEl(options: [string, string][], current: string, onChange: (v: string) => void, label: string): HTMLSelectElement {
  const select = h('select', { 'aria-label': label });
  for (const [value, text] of options) select.append(h('option', { value, selected: value === current }, text));
  select.value = current;
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

const spec = (label: string, unit: string, validate: (v: number) => string | null): FieldSpec => ({ key: label, label, unit, validate });
const anyFinite = (v: number) => (Number.isFinite(v) ? null : 'Must be a finite number');
const positiveRadius = (v: number) => (Number.isFinite(v) && v > 0 ? null : 'Must be greater than 0');

/** Targets and free positions for the solver; Run proposes positions that Accept applies as one undo step. */
export function createSolverPanel(el: HTMLElement, store: Store): { render(state: AppState): void } {
  let targets: TargetRow[] = [];
  let variables: VariableRow[] = [];
  let proposal: Proposal | null = null;
  let notes: string[] = [];
  let error: string | null = null;
  let solving = false;
  let shapeKey = '';

  const addTargetButton = h('button', {}, '+ Target');
  const addVariableButton = h('button', {}, '+ Variable');
  const runButton = h('button', { class: 'primary' }, 'Run');
  const rowsEl = h('div', { class: 'solver-rows' });
  const resultEl = h('div', { class: 'solver-result' });
  el.replaceChildren(
    h('div', { class: 'solver-bar' }, addTargetButton, addVariableButton, h('span', { class: 'spacer' }), runButton),
    rowsEl,
    resultEl,
  );

  const setup = () => store.get().setup;
  const labelsOf = (s: Setup) => new Map([...s.sources, ...s.optics].map((e) => [e.id, e.label] as const));

  function invalidate() {
    proposal = null;
    error = null;
    renderResult();
  }

  addTargetButton.addEventListener('click', () => {
    const source = gaussianSources(setup())[0];
    if (!source) return;
    const screen = setup().optics.find((o) => o.kind === 'screen');
    targets.push({
      kind: 'waistPosition',
      sourceId: source.id,
      sourceLabel: source.label,
      wavelengthNm: source.wavelengthsNm[0]!,
      z: screen ? screen.z : Math.round(defaultEndZ(setup())),
      radiusMm: DEFAULT_RADIUS_MM,
    });
    notes = [];
    invalidate();
    renderRows();
  });

  addVariableButton.addEventListener('click', () => {
    const { setup: s, selectedId } = store.get();
    const used = new Set(variables.map((v) => v.opticId));
    const free = s.optics.filter((o) => isMovable(o) && !used.has(o.id));
    const optic = free.find((o) => o.id === selectedId) ?? free[0];
    if (!optic) return;
    variables.push(variableFor(optic));
    notes = [];
    invalidate();
    renderRows();
  });

  const variableFor = (optic: Optic): VariableRow => ({
    opticId: optic.id,
    opticLabel: optic.label,
    minZ: optic.z - VARIABLE_HALF_RANGE_MM,
    maxZ: optic.z + VARIABLE_HALF_RANGE_MM,
  });

  runButton.addEventListener('click', () => void run());

  function validationError(s: Setup): string | null {
    if (targets.length === 0) return 'Add at least one target';
    if (variables.length === 0) return 'Add at least one variable';
    const seen = new Set<Id>();
    for (const v of variables) {
      if (seen.has(v.opticId)) return `${v.opticLabel} is listed twice as a variable`;
      seen.add(v.opticId);
      if (v.minZ > v.maxZ) return `${v.opticLabel}: the lower z limit is above the upper one`;
    }
    for (const t of targets) {
      const source = gaussianSources(s).find((g) => g.id === t.sourceId);
      if (!source?.wavelengthsNm.includes(t.wavelengthNm)) return `${t.sourceLabel} has no ${t.wavelengthNm} nm beam`;
    }
    return null;
  }

  async function run() {
    error = validationError(setup());
    proposal = null;
    if (error) {
      renderResult();
      return;
    }
    solving = true;
    renderResult();
    // Let the browser paint "Solving…" before the synchronous solve blocks it.
    await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    try {
      const current = setup();
      const solverTargets = targets.map(toTarget);
      const result = solve(
        current,
        solverTargets,
        variables.map((v): Variable => ({ opticId: v.opticId, minZ: v.minZ, maxZ: v.maxZ })),
      );
      const labels = labelsOf(result.setup);
      proposal = {
        forSetup: current,
        result,
        variables: variables.map((v) => ({ ...v })),
        achieved: solverTargets.map((t) => achieved(result.setup, t, labels)),
      };
    } catch (e) {
      error = (e as Error).message;
    } finally {
      solving = false;
    }
    renderResult();
  }

  function accept() {
    if (!proposal) return;
    const zById = new Map(proposal.result.setup.optics.map((o) => [o.id, o.z]));
    const ids = new Set(proposal.variables.map((v) => v.opticId));
    proposal = null;
    notes = ['Accepted: the new positions are one undo step.'];
    store.apply(
      (s) => ({ ...s, optics: s.optics.map((o) => (ids.has(o.id) && zById.has(o.id) ? { ...o, z: zById.get(o.id)! } : o)) }),
      'Accept solver result',
    );
    renderResult();
  }

  function discard() {
    proposal = null;
    notes = [];
    renderResult();
  }

  function targetRow(row: TargetRow, index: number): HTMLElement {
    const s = setup();
    const sources = gaussianSources(s);
    const source = sources.find((g) => g.id === row.sourceId);
    const kind = selectEl(
      (Object.keys(targetKindNames) as TargetKind[]).map((k) => [k, targetKindNames[k]]),
      row.kind,
      (v) => {
        row.kind = v as TargetKind;
        invalidate();
        renderRows();
      },
      'Target kind',
    );
    const sourceSelect = selectEl(
      sources.map((g) => [g.id, g.label]),
      row.sourceId,
      (v) => {
        const next = sources.find((g) => g.id === v)!;
        row.sourceId = next.id;
        row.sourceLabel = next.label;
        if (!next.wavelengthsNm.includes(row.wavelengthNm)) row.wavelengthNm = next.wavelengthsNm[0]!;
        invalidate();
        renderRows();
      },
      'Source',
    );
    const wavelength = selectEl(
      (source?.wavelengthsNm ?? [row.wavelengthNm]).map((nm) => [String(nm), `${nm} nm`]),
      String(row.wavelengthNm),
      (v) => {
        row.wavelengthNm = Number(v);
        invalidate();
      },
      'Wavelength',
    );
    const values: (HTMLElement | string)[] = [];
    const valueInput = (label: string, key: 'z' | 'radiusMm', validate: (v: number) => string | null) => {
      const control = numberControl({
        spec: spec(label, 'mm', validate),
        read: () => row[key],
        commit: (v) => {
          row[key] = v;
          invalidate();
        },
        className: 'num solver-num',
      });
      values.push(h('span', { class: 'muted' }, label), control.input, h('span', { class: 'unit' }, 'mm'), control.message);
    };
    if (row.kind === 'radiusAt' || row.kind === 'waistPosition') valueInput('z', 'z', anyFinite);
    if (row.kind === 'radiusAt') valueInput('w', 'radiusMm', positiveRadius);
    if (row.kind === 'waistRadius') valueInput('w₀', 'radiusMm', positiveRadius);
    const remove = h('button', { class: 'icon-btn', title: 'Remove this target', 'aria-label': 'Remove this target' }, '×');
    remove.addEventListener('click', () => {
      targets.splice(index, 1);
      invalidate();
      renderRows();
    });
    return h('div', { class: 'solver-row' }, h('span', { class: 'row-tag' }, 'Target'), kind, sourceSelect, wavelength, ...values, remove);
  }

  function variableRow(row: VariableRow, index: number): HTMLElement {
    const s = setup();
    const used = new Set(variables.filter((v) => v !== row).map((v) => v.opticId));
    const choices = s.optics.filter((o) => isMovable(o) && (o.id === row.opticId || !used.has(o.id)));
    const optic = selectEl(
      choices.map((o) => [o.id, o.label]),
      row.opticId,
      (v) => {
        variables[index] = variableFor(s.optics.find((o) => o.id === v)!);
        invalidate();
        renderRows();
      },
      'Optic',
    );
    const bound = (label: string, key: 'minZ' | 'maxZ') => {
      const control = numberControl({
        spec: spec(label, 'mm', anyFinite),
        read: () => row[key],
        commit: (v) => {
          row[key] = v;
          invalidate();
        },
        className: 'num solver-num',
      });
      return [control.input, control.message];
    };
    const remove = h('button', { class: 'icon-btn', title: 'Remove this variable', 'aria-label': 'Remove this variable' }, '×');
    remove.addEventListener('click', () => {
      variables.splice(index, 1);
      invalidate();
      renderRows();
    });
    return h(
      'div',
      { class: 'solver-row' },
      h('span', { class: 'row-tag' }, 'Vary z'),
      optic,
      h('span', { class: 'muted' }, 'from'),
      ...bound('Lowest z', 'minZ'),
      h('span', { class: 'muted' }, 'to'),
      ...bound('Highest z', 'maxZ'),
      h('span', { class: 'unit' }, 'mm'),
      remove,
    );
  }

  function renderRows() {
    const s = setup();
    const hasGaussian = gaussianSources(s).length > 0;
    addTargetButton.disabled = !hasGaussian;
    addTargetButton.title = hasGaussian ? 'Add a beam-size target' : 'The solver works on Gaussian beams: add a Gaussian source first';
    const used = new Set(variables.map((v) => v.opticId));
    const canVary = s.optics.some((o) => isMovable(o) && !used.has(o.id));
    addVariableButton.disabled = !canVary;
    addVariableButton.title = canVary ? 'Let the solver move a lens (the selected one if it is a lens)' : 'No more lenses or SLMs to vary';
    const rows = [...targets.map(targetRow), ...variables.map(variableRow)];
    if (rows.length === 0) {
      rows.push(
        h(
          'p',
          { class: 'placeholder muted' },
          hasGaussian
            ? 'Add targets for a Gaussian beam and the lens positions the solver may change, then Run.'
            : 'The solver moves lenses to meet beam-size targets on a Gaussian beam: add a Gaussian source first.',
        ),
      );
    }
    rowsEl.replaceChildren(...rows);
  }

  function renderResult() {
    runButton.disabled = solving;
    runButton.textContent = solving ? 'Solving…' : 'Run';
    const parts: HTMLElement[] = notes.map((n) => h('div', { class: 'line note' }, n));
    if (error) parts.push(h('div', { class: 'line warn' }, error));
    if (proposal) {
      const { result } = proposal;
      const zAfter = new Map(result.setup.optics.map((o) => [o.id, o.z]));
      const zBefore = new Map(proposal.forSetup.optics.map((o) => [o.id, o.z]));
      const acceptButton = h('button', { class: 'primary' }, 'Accept');
      const discardButton = h('button', {}, 'Discard');
      acceptButton.addEventListener('click', accept);
      discardButton.addEventListener('click', discard);
      parts.push(
        h(
          'div',
          { class: 'line' },
          `Cost ${result.cost.toPrecision(3)} · converged: `,
          h('strong', { class: result.converged ? 'ok' : 'warn' }, result.converged ? 'yes' : 'no'),
        ),
        ...proposal.variables.map((v) =>
          h('div', { class: 'line' }, `${v.opticLabel}: z ${mm(zBefore.get(v.opticId)!)} → ${mm(zAfter.get(v.opticId)!)}`),
        ),
        ...proposal.achieved.map((a) => h('div', { class: 'line' }, a)),
        h('div', { class: 'solver-accept' }, acceptButton, discardButton),
      );
    }
    resultEl.replaceChildren(...parts);
  }

  /** Drops rows naming elements or wavelengths that are gone, with a note saying so. */
  function prune(s: Setup) {
    const dropped: string[] = [];
    const sources = new Map(gaussianSources(s).map((g) => [g.id, g]));
    targets = targets.filter((t) => {
      const source = sources.get(t.sourceId);
      if (!source) dropped.push(`a target on ${t.sourceLabel || 'a deleted source'} (source deleted)`);
      else if (!source.wavelengthsNm.includes(t.wavelengthNm)) dropped.push(`a target on ${source.label} at ${t.wavelengthNm} nm (wavelength removed)`);
      else {
        t.sourceLabel = source.label;
        return true;
      }
      return false;
    });
    const optics = new Map(s.optics.filter(isMovable).map((o) => [o.id, o]));
    variables = variables.filter((v) => {
      const optic = optics.get(v.opticId);
      if (!optic) {
        dropped.push(`the variable ${v.opticLabel || 'for a deleted optic'} (element deleted)`);
        return false;
      }
      v.opticLabel = optic.label;
      return true;
    });
    if (dropped.length) notes = [`Dropped ${dropped.join('; ')}.`];
  }

  renderRows();
  renderResult();

  return {
    render(state) {
      const s = state.setup;
      if (proposal && proposal.forSetup !== s) {
        proposal = null;
        notes = ['Proposal cleared: the setup changed before it was accepted.'];
        renderResult();
      }
      const key = JSON.stringify([
        gaussianSources(s).map((g) => [g.id, g.label, g.wavelengthsNm]),
        s.optics.filter(isMovable).map((o) => [o.id, o.label]),
      ]);
      if (key === shapeKey) return;
      shapeKey = key;
      const before = targets.length + variables.length;
      prune(s);
      if (targets.length + variables.length !== before) renderResult();
      renderRows();
    },
  };
}
