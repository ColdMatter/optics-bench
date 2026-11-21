import bundledGlasses from '../data/glasses.json';
import { makeGlassLookup } from '../engine/glass';
import { lensAbcd } from '../engine/lens';
import { decodeZmx, parseZmx, ZmxError } from '../engine/zmx';
import type { CatalogueLens, GlassData, LensPrescription, Setup } from '../engine/types';
import { formatShort, h, pickFile } from './controls';
import { catalogue, insertElement, newOptic } from './elements';
import type { Store } from './store';

export interface CatalogueEntry {
  prescription: LensPrescription;
  focalLengthMm: number;
  diameterMm: number;
  type: string;
}

// Thorlabs quotes an achromat's focal length at the centre of its coating band, a singlet's at 587.6 nm.
const BAND_CENTRE_NM: Record<string, number> = { A: 535, B: 855 };
const SINGLET_DESIGN_NM = 587.6;
const FOCAL_MATCH_FRACTION = 0.02;
const MIN_INDEX = 1;
const MAX_INDEX = 3;
// A constant index applies at every wavelength.
const CONSTANT_RANGE_UM: [number, number] = [0, 1000];

const bundled = Object.values(bundledGlasses as unknown as Record<string, GlassData>);
export const bundledGlassNames = bundled.map((g) => g.name).sort((a, b) => a.localeCompare(b));
const bundledLookup = makeGlassLookup();

function designWavelengthNm(p: LensPrescription): number {
  const coating = /-([AB])$/.exec(p.partNumber)?.[1];
  return coating ? BAND_CENTRE_NM[coating]! : SINGLET_DESIGN_NM;
}

/** Paraxial effective focal length at the lens's design wavelength. */
export function nominalFocalLengthMm(p: LensPrescription): number {
  const lens: CatalogueLens = { kind: 'lens', id: '', label: '', z: 0, decentreMm: 0, tiltDeg: 0, prescription: p, flipped: false };
  return -1 / lensAbcd(lens, designWavelengthNm(p), bundledLookup)[2];
}

function lensType(p: LensPrescription): string {
  const elements = p.surfaces.length - 1;
  if (elements === 1) return p.surfaces.some((s) => s.curvature === 0) ? 'Plano-convex singlet' : 'Singlet';
  if (elements === 2 && /^AC/.test(p.partNumber)) return 'Achromatic doublet';
  return elements === 2 ? 'Cemented doublet' : `Cemented ${elements}-element lens`;
}

export function catalogueEntries(lenses: LensPrescription[] = catalogue): CatalogueEntry[] {
  return lenses.map((prescription) => ({
    prescription,
    focalLengthMm: nominalFocalLengthMm(prescription),
    diameterMm: 2 * Math.max(...prescription.surfaces.map((s) => s.semiDiameterMm)),
    type: lensType(prescription),
  }));
}

/** Entries whose part number contains the query, or, for a number, whose focal length is within 2 % of it. */
export function filterCatalogue(entries: CatalogueEntry[], query: string): CatalogueEntry[] {
  const q = query.trim().toLowerCase();
  if (q === '') return entries;
  const focal = Number(q);
  return entries.filter(
    (e) =>
      e.prescription.partNumber.toLowerCase().includes(q) ||
      (Number.isFinite(focal) && focal > 0 && Math.abs(e.focalLengthMm - focal) <= FOCAL_MATCH_FRACTION * focal),
  );
}

/** Glasses the lens names that neither the bundled data nor the setup provide. */
export function unknownGlasses(p: LensPrescription, setupGlasses: Setup['glasses']): string[] {
  const lookup = makeGlassLookup(setupGlasses);
  const names = p.surfaces.flatMap((s) => (s.glassAfter && !lookup(s.glassAfter) ? [s.glassAfter] : []));
  return [...new Set(names)];
}

export type GlassChoice = { kind: 'bundled'; name: string } | { kind: 'index'; index: number };

/** The chosen data under the unknown glass's name, so the lens's surfaces resolve to it. */
export function substituteGlass(unknownName: string, choice: GlassChoice): GlassData {
  if (choice.kind === 'index') {
    return { name: unknownName, formula: 'constant', coefficients: [choice.index], rangeUm: [...CONSTANT_RANGE_UM] };
  }
  const glass = bundledLookup(choice.name);
  if (!glass) throw new Error(`${choice.name} is not a bundled glass`);
  return { ...glass, coefficients: [...glass.coefficients], rangeUm: [...glass.rangeUm], name: unknownName };
}

export function parseConstantIndex(text: string): { index: number } | { error: string } {
  const n = Number(text.trim());
  if (text.trim() === '' || !Number.isFinite(n)) return { error: 'Enter a number' };
  if (n <= MIN_INDEX || n >= MAX_INDEX) return { error: `Must be between ${MIN_INDEX} and ${MAX_INDEX}` };
  return { index: n };
}

interface GlassRow {
  name: string;
  read(): GlassChoice | null;
}

function glassRow(name: string, datalistId: string, onChange: () => void): { row: HTMLElement; glass: GlassRow } {
  const mode = h(
    'select',
    { 'aria-label': `How to replace ${name}` },
    h('option', { value: 'bundled' }, 'Substitute glass'),
    h('option', { value: 'index' }, 'Constant index n'),
  );
  const value = h('input', {
    type: 'text',
    list: datalistId,
    placeholder: 'Search glasses',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': `Substitute for ${name}`,
  });
  const message = h('span', { class: 'field-error' });
  const read = (): GlassChoice | null => {
    const text = value.value.trim();
    if (mode.value === 'index') {
      const parsed = parseConstantIndex(text);
      message.textContent = text === '' || !('error' in parsed) ? '' : parsed.error;
      return 'error' in parsed ? null : { kind: 'index', index: parsed.index };
    }
    const glass = bundledLookup(text);
    message.textContent = text === '' || glass ? '' : 'Not a bundled glass';
    return glass ? { kind: 'bundled', name: glass.name } : null;
  };
  mode.addEventListener('change', () => {
    value.value = '';
    value.setAttribute('placeholder', mode.value === 'index' ? 'e.g. 1.72' : 'Search glasses');
    if (mode.value === 'index') value.removeAttribute('list');
    else value.setAttribute('list', datalistId);
    value.setAttribute('inputmode', mode.value === 'index' ? 'decimal' : 'text');
    onChange();
  });
  value.addEventListener('input', onChange);
  const row = h('div', { class: 'glass-row' }, h('span', { class: 'glass-name' }, name), mode, value, message);
  return { row, glass: { name, read } };
}

/** The modal lens browser: search the bundled catalogue, add a part, or import a .zmx. */
export function openCatalogue(store: Store): void {
  const entries = catalogueEntries();
  let shown = entries;
  let chosen: CatalogueEntry | null = null;

  const search = h('input', {
    type: 'search',
    class: 'cat-search',
    placeholder: 'Part number or focal length in mm',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Search the catalogue',
  });
  const count = h('span', { class: 'muted' });
  const tbody = h('tbody');
  const table = h(
    'table',
    { class: 'cat-table' },
    h(
      'thead',
      {},
      h('tr', {}, h('th', {}, 'Part'), h('th', { class: 'num', title: 'Paraxial focal length at 535 nm (-A coating), 855 nm (-B) or 587.6 nm (singlets)' }, 'f (mm)'), h('th', { class: 'num' }, '⌀ (mm)'), h('th', {}, 'Type')),
    ),
    tbody,
  );
  const listWrap = h('div', { class: 'cat-list' }, table);
  const message = h('div', { class: 'cat-message', role: 'alert' });
  const glassSection = h('div', { class: 'cat-glasses' });
  glassSection.hidden = true;

  const importButton = h('button', { title: 'Read a Zemax .zmx lens file' }, 'Import .zmx…');
  const closeButton = h('button', {}, 'Close');
  const addButton = h('button', { class: 'primary' }, 'Add');
  const browseView = h('div', { class: 'cat-browse' }, h('div', { class: 'cat-search-row' }, search, count), listWrap);
  const actions = h('div', { class: 'cat-actions' }, importButton, h('span', { class: 'spacer' }), closeButton, addButton);
  const dialog = h(
    'dialog',
    { class: 'message catalogue', 'aria-label': 'Catalogue lenses' },
    h('h3', {}, 'Add a catalogue lens'),
    browseView,
    glassSection,
    message,
    actions,
  );

  const close = () => dialog.close();
  dialog.addEventListener('close', () => dialog.remove());
  closeButton.addEventListener('click', close);

  const insert = (prescription: LensPrescription, glasses: Record<string, GlassData> = {}) => {
    insertElement(store, newOptic('lens', store.get(), prescription), glasses);
    close();
  };

  function renderList() {
    shown = filterCatalogue(entries, search.value);
    if (chosen && !shown.includes(chosen)) chosen = null;
    chosen ??= shown[0] ?? null;
    count.textContent = `${shown.length} of ${entries.length}`;
    tbody.replaceChildren(
      ...shown.map((entry) => {
        const row = h(
          'tr',
          { class: entry === chosen ? 'selected' : '', 'aria-selected': String(entry === chosen) },
          h('td', {}, entry.prescription.partNumber),
          h('td', { class: 'num' }, entry.focalLengthMm.toFixed(1)),
          h('td', { class: 'num' }, formatShort(entry.diameterMm)),
          h('td', { class: 'muted' }, entry.type),
        );
        row.addEventListener('click', () => {
          chosen = entry;
          renderList();
        });
        row.addEventListener('dblclick', () => insert(entry.prescription));
        return row;
      }),
    );
    if (shown.length === 0) tbody.append(h('tr', {}, h('td', { colspan: 4, class: 'muted' }, 'No part matches. Import its .zmx instead.')));
    addButton.disabled = chosen === null;
  }

  search.addEventListener('input', renderList);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && chosen) {
      e.preventDefault();
      insert(chosen.prescription);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && shown.length) {
      e.preventDefault();
      const i = chosen ? shown.indexOf(chosen) : -1;
      chosen = shown[Math.min(shown.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]!;
      renderList();
      tbody.querySelector('tr.selected')?.scrollIntoView({ block: 'nearest' });
    }
  });
  addButton.addEventListener('click', () => {
    if (chosen) insert(chosen.prescription);
  });

  function showBrowse() {
    glassSection.hidden = true;
    browseView.hidden = false;
    actions.hidden = false;
    search.focus();
  }

  function chooseGlasses(prescription: LensPrescription, names: string[]) {
    const datalistId = 'bundled-glass-names';
    const datalist = h('datalist', { id: datalistId }, ...bundledGlassNames.map((n) => h('option', { value: n })));
    const insertButton = h('button', { class: 'primary' }, 'Insert lens');
    const cancelButton = h('button', {}, 'Cancel import');
    const rows = names.map((name) => glassRow(name, datalistId, update));
    function update() {
      insertButton.disabled = rows.some((r) => r.glass.read() === null);
    }
    insertButton.addEventListener('click', () => {
      const glasses: Record<string, GlassData> = {};
      for (const { glass } of rows) {
        const choice = glass.read();
        if (!choice) return;
        glasses[glass.name] = substituteGlass(glass.name, choice);
      }
      insert(prescription, glasses);
    });
    cancelButton.addEventListener('click', () => {
      message.textContent = '';
      showBrowse();
    });
    glassSection.replaceChildren(
      h(
        'p',
        {},
        `${prescription.partNumber || 'This lens'} uses ${names.length === 1 ? 'a glass' : 'glasses'} not in the bundled data. ` +
          'Choose a substitute glass or type a constant index for each; the choice is saved with the setup under the original name.',
      ),
      datalist,
      ...rows.map((r) => r.row),
      h('div', { class: 'cat-actions' }, h('span', { class: 'spacer' }), cancelButton, insertButton),
    );
    update();
    browseView.hidden = true;
    actions.hidden = true;
    glassSection.hidden = false;
    rows[0]?.row.querySelector('input')?.focus();
  }

  importButton.addEventListener('click', async () => {
    const file = await pickFile('.zmx,.ZMX');
    if (!file) return;
    message.textContent = '';
    let prescription: LensPrescription;
    try {
      prescription = parseZmx(decodeZmx(new Uint8Array(await file.arrayBuffer())), '', file.name);
    } catch (e) {
      const reason = e instanceof ZmxError ? e.message : `unreadable file (${(e as Error).message})`;
      message.textContent = `Could not import ${file.name}: ${reason}`;
      return;
    }
    const unknown = unknownGlasses(prescription, store.get().setup.glasses);
    if (unknown.length === 0) insert(prescription);
    else chooseGlasses(prescription, unknown);
  });

  renderList();
  document.body.append(dialog);
  dialog.showModal();
  search.focus();
}
