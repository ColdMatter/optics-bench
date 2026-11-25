import bundledGlasses from '../data/glasses.json';
import { makeGlassLookup } from '../engine/glass';
import { lensAbcd } from '../engine/lens';
import { withLens, withoutLens, type GlassChoice, type LocalLensEntry, type LocalLensFile } from '../engine/lensLibrary';
import { decodeZmx, parseZmx, ZmxError } from '../engine/zmx';
import type { CatalogueLens, GlassData, GlassLookup, LensPrescription, Setup } from '../engine/types';
import { formatShort, h, pickFile } from './controls';
import { catalogue, insertElement, newOptic } from './elements';
import { connectLocal, localCatalogueSupported, localStatus, updateLocal, type LocalStatus } from './localCatalogue';
import type { Store } from './store';

export type { GlassChoice };

export interface CatalogueEntry {
  prescription: LensPrescription;
  focalLengthMm: number;
  diameterMm: number;
  type: string;
  /** Set for a lens from the local catalogue file. */
  local?: LocalLensEntry;
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

/** Paraxial effective focal length at the lens's design wavelength; NaN if a glass is unknown. */
export function nominalFocalLengthMm(p: LensPrescription, glasses: GlassLookup = bundledLookup): number {
  if (p.surfaces.some((s) => s.glassAfter !== null && !glasses(s.glassAfter))) return NaN;
  const lens: CatalogueLens = { kind: 'lens', id: '', label: '', z: 0, decentreMm: 0, tiltDeg: 0, prescription: p, flipped: false };
  return -1 / lensAbcd(lens, designWavelengthNm(p), glasses)[2];
}

function lensType(p: LensPrescription): string {
  const elements = p.surfaces.length - 1;
  if (elements === 1) return p.surfaces.some((s) => s.curvature === 0) ? 'Plano-convex singlet' : 'Singlet';
  if (elements === 2 && /^AC/.test(p.partNumber)) return 'Achromatic doublet';
  return elements === 2 ? 'Cemented doublet' : `Cemented ${elements}-element lens`;
}

function entryFor(prescription: LensPrescription, glasses: GlassLookup = bundledLookup): CatalogueEntry {
  return {
    prescription,
    focalLengthMm: nominalFocalLengthMm(prescription, glasses),
    diameterMm: 2 * Math.max(...prescription.surfaces.map((s) => s.semiDiameterMm)),
    type: lensType(prescription),
  };
}

export function catalogueEntries(lenses: LensPrescription[] = catalogue): CatalogueEntry[] {
  return lenses.map((p) => entryFor(p));
}

/** Entries for the lenses in a local catalogue file, with their substitute glasses applied. */
export function localEntries(file: LocalLensFile): CatalogueEntry[] {
  return file.lenses.map((local) => ({ ...entryFor(local.prescription, makeGlassLookup(substitutedGlasses(local.substitutions))), local }));
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

/** The chosen data under the unknown glass's name, so the lens's surfaces resolve to it. */
export function substituteGlass(unknownName: string, choice: GlassChoice): GlassData {
  if (choice.kind === 'index') {
    return { name: unknownName, formula: 'constant', coefficients: [choice.index], rangeUm: [...CONSTANT_RANGE_UM] };
  }
  const glass = bundledLookup(choice.name);
  if (!glass) throw new Error(`${choice.name} is not a bundled glass`);
  return { ...glass, coefficients: [...glass.coefficients], rangeUm: [...glass.rangeUm], name: unknownName };
}

/** Glass data for each substitution that still resolves (a bundled substitute may have been renamed). */
export function substitutedGlasses(substitutions: Record<string, GlassChoice>): Record<string, GlassData> {
  const glasses: Record<string, GlassData> = {};
  for (const [name, choice] of Object.entries(substitutions)) {
    if (choice.kind === 'index' || bundledLookup(choice.name)) glasses[name] = substituteGlass(name, choice);
  }
  return glasses;
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

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));
const partName = (p: LensPrescription) => p.partNumber || 'The lens';

/**
 * The modal lens browser: search the bundled and local catalogues, add a part, or import a .zmx.
 * An imported lens goes into the setup and into the local catalogue file, if one is connected.
 */
export function openCatalogue(store: Store): void {
  const bundledEntries = catalogueEntries();
  let entries = bundledEntries;
  let shown = entries;
  let chosen: CatalogueEntry | null = null;
  let checking = localCatalogueSupported();
  let local: LocalStatus = { kind: checking ? 'none' : 'unsupported' };

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
      h(
        'tr',
        {},
        h('th', {}, 'Part'),
        h('th', { class: 'num', title: 'Paraxial focal length at 535 nm (-A coating), 855 nm (-B) or 587.6 nm (others)' }, 'f (mm)'),
        h('th', { class: 'num' }, '⌀ (mm)'),
        h('th', {}, 'Type'),
        h('th', { 'aria-label': 'Remove' }),
      ),
    ),
    tbody,
  );
  const listWrap = h('div', { class: 'cat-list' }, table);
  const localLine = h('div', { class: 'cat-local' });
  const message = h('div', { class: 'cat-message', role: 'alert' });
  const glassSection = h('div', { class: 'cat-glasses' });
  glassSection.hidden = true;
  const savePanel = h('div', { class: 'cat-save' });
  savePanel.hidden = true;

  const importButton = h('button', { title: 'Read a Zemax .zmx lens file into the setup and the local catalogue' }, 'Import .zmx…');
  const closeButton = h('button', {}, 'Close');
  const addButton = h('button', { class: 'primary' }, 'Add');
  const browseView = h('div', { class: 'cat-browse' }, h('div', { class: 'cat-search-row' }, search, count), listWrap, localLine);
  const actions = h('div', { class: 'cat-actions' }, importButton, h('span', { class: 'spacer' }), closeButton, addButton);
  const dialog = h(
    'dialog',
    { class: 'message catalogue', 'aria-label': 'Catalogue lenses' },
    h('h3', {}, 'Add a catalogue lens'),
    browseView,
    glassSection,
    savePanel,
    message,
    actions,
  );

  const close = () => dialog.close();
  dialog.addEventListener('close', () => dialog.remove());
  closeButton.addEventListener('click', close);

  const placeLens = (prescription: LensPrescription, glasses: Record<string, GlassData> = {}) =>
    insertElement(store, newOptic('lens', store.get(), prescription), glasses);
  const insert = (prescription: LensPrescription, glasses: Record<string, GlassData> = {}) => {
    placeLens(prescription, glasses);
    close();
  };

  function setLocal(status: LocalStatus) {
    local = status;
    checking = false;
    const wasLocal = chosen?.local ? chosen.prescription.partNumber : null;
    entries = status.kind === 'ready' ? [...localEntries(status.file), ...bundledEntries] : bundledEntries;
    if (wasLocal !== null) chosen = entries.find((e) => e.local && e.prescription.partNumber === wasLocal) ?? null;
    renderLocal();
    renderList();
  }

  /** Buttons to connect a catalogue file; `then` runs once one is ready. */
  function connectButtons(then: (status: LocalStatus & { kind: 'ready' }) => void): HTMLElement[] {
    const connect = async (how: 'open' | 'new') => {
      const status = await connectLocal(how);
      if (!status) return;
      if (status.kind === 'error') {
        message.textContent = `Could not use ${status.name || 'that file'}: ${status.message}`;
        setLocal(await localStatus());
        return;
      }
      message.textContent = '';
      setLocal(status);
      if (status.kind === 'ready') then(status);
    };
    const buttons = [
      h('button', { title: 'Use an existing lens catalogue file' }, 'Open file…'),
      h('button', { title: 'Create a new lens catalogue file' }, 'New file…'),
    ];
    buttons[0]!.addEventListener('click', () => connect('open'));
    buttons[1]!.addEventListener('click', () => connect('new'));
    if (local.kind === 'needs-permission') {
      const reconnect = h('button', { title: `Let the app read and write ${local.name} again` }, 'Reconnect');
      reconnect.addEventListener('click', async () => {
        const status = await localStatus(true);
        setLocal(status);
        if (status.kind === 'ready') then(status);
      });
      buttons.unshift(reconnect);
    }
    return buttons;
  }

  function renderLocal() {
    const text = (() => {
      if (checking) return 'Local catalogue: checking…';
      switch (local.kind) {
        case 'unsupported':
          return 'Imported lenses go only into the setup: the local catalogue needs Chrome or Edge.';
        case 'none':
          return 'No local catalogue file: imported lenses go only into the setup.';
        case 'needs-permission':
          return `Local catalogue: ${local.name} needs permission again.`;
        case 'ready':
          return `Local catalogue: ${local.name} (${local.file.lenses.length} ${local.file.lenses.length === 1 ? 'lens' : 'lenses'})`;
        case 'error':
          return `Local catalogue${local.name ? ` ${local.name}` : ''}: ${local.message}`;
      }
    })();
    const buttons = checking || local.kind === 'unsupported' ? [] : connectButtons(() => {});
    localLine.replaceChildren(h('span', { class: local.kind === 'error' ? 'cat-local-text error' : 'cat-local-text muted' }, text), ...buttons);
  }

  async function removeLocal(entry: CatalogueEntry) {
    const part = entry.prescription.partNumber;
    const file = local.kind === 'ready' ? local.name : 'the local catalogue';
    if (!window.confirm(`Remove ${part} from ${file}? Setups that already use it keep their own copy.`)) return;
    try {
      setLocal(await updateLocal((f) => withoutLens(f, part)));
    } catch (e) {
      message.textContent = `Could not remove ${part}: ${describe(e)}`;
    }
  }

  function renderList() {
    shown = filterCatalogue(entries, search.value);
    if (chosen && !shown.includes(chosen)) chosen = null;
    chosen ??= shown[0] ?? null;
    count.textContent = `${shown.length} of ${entries.length}`;
    tbody.replaceChildren(
      ...shown.map((entry) => {
        let removeCell: HTMLElement = h('td');
        if (entry.local) {
          const remove = h(
            'button',
            { class: 'cat-remove', title: `Remove ${entry.prescription.partNumber} from the local catalogue`, 'aria-label': 'Remove' },
            '✕',
          );
          remove.addEventListener('click', (e) => {
            e.stopPropagation();
            void removeLocal(entry);
          });
          remove.addEventListener('dblclick', (e) => e.stopPropagation());
          removeCell = h('td', { class: 'cat-remove-cell' }, remove);
        }
        const row = h(
          'tr',
          { class: entry === chosen ? 'selected' : '', 'aria-selected': String(entry === chosen) },
          h('td', {}, entry.prescription.partNumber, entry.local ? h('span', { class: 'cat-tag', title: 'From your local catalogue file' }, 'Local') : null),
          h('td', { class: 'num' }, Number.isFinite(entry.focalLengthMm) ? entry.focalLengthMm.toFixed(1) : '—'),
          h('td', { class: 'num' }, formatShort(entry.diameterMm)),
          h('td', { class: 'muted' }, entry.type),
          removeCell,
        );
        row.addEventListener('click', () => {
          chosen = entry;
          renderList();
        });
        row.addEventListener('dblclick', () => add(entry));
        return row;
      }),
    );
    if (shown.length === 0) tbody.append(h('tr', {}, h('td', { colspan: 5, class: 'muted' }, 'No part matches. Import its .zmx instead.')));
    addButton.disabled = chosen === null;
  }

  search.addEventListener('input', renderList);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && chosen) {
      e.preventDefault();
      add(chosen);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && shown.length) {
      e.preventDefault();
      const i = chosen ? shown.indexOf(chosen) : -1;
      chosen = shown[Math.min(shown.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]!;
      renderList();
      tbody.querySelector('tr.selected')?.scrollIntoView({ block: 'nearest' });
    }
  });
  addButton.addEventListener('click', () => {
    if (chosen) add(chosen);
  });

  function showBrowse() {
    glassSection.hidden = true;
    savePanel.hidden = true;
    browseView.hidden = false;
    actions.hidden = false;
    search.focus();
  }

  function showPanel(panel: HTMLElement) {
    browseView.hidden = true;
    actions.hidden = true;
    glassSection.hidden = panel !== glassSection;
    savePanel.hidden = panel !== savePanel;
  }

  /** Asks for a substitute for each glass in `names`, then hands the choices to `done`. */
  function chooseGlasses(prescription: LensPrescription, names: string[], cancelText: string, done: (choices: Record<string, GlassChoice>) => void) {
    const datalistId = 'bundled-glass-names';
    const datalist = h('datalist', { id: datalistId }, ...bundledGlassNames.map((n) => h('option', { value: n })));
    const insertButton = h('button', { class: 'primary' }, 'Insert lens');
    const cancelButton = h('button', {}, cancelText);
    const rows = names.map((name) => glassRow(name, datalistId, update));
    function update() {
      insertButton.disabled = rows.some((r) => r.glass.read() === null);
    }
    insertButton.addEventListener('click', () => {
      const choices: Record<string, GlassChoice> = {};
      for (const { glass } of rows) {
        const choice = glass.read();
        if (!choice) return;
        choices[glass.name] = choice;
      }
      done(choices);
    });
    cancelButton.addEventListener('click', () => {
      message.textContent = '';
      showBrowse();
    });
    glassSection.replaceChildren(
      h(
        'p',
        {},
        `${partName(prescription)} uses ${names.length === 1 ? 'a glass' : 'glasses'} not in the bundled data. ` +
          'Choose a substitute glass or type a constant index for each; the choice is saved with the setup under the original name' +
          (local.kind === 'unsupported' ? '.' : ', and in the local catalogue.'),
      ),
      datalist,
      ...rows.map((r) => r.row),
      h('div', { class: 'cat-actions' }, h('span', { class: 'spacer' }), cancelButton, insertButton),
    );
    update();
    showPanel(glassSection);
    rows[0]?.row.querySelector('input')?.focus();
  }

  /** Writes `entry` to the local file and closes, or says why it couldn't. */
  async function saveLocal(entry: LocalLensEntry, onlyIfPresent = false) {
    try {
      setLocal(
        await updateLocal((f) =>
          onlyIfPresent && !f.lenses.some((l) => l.prescription.partNumber === entry.prescription.partNumber) ? f : withLens(f, entry),
        ),
      );
      close();
    } catch (e) {
      showBrowse();
      message.textContent = `${partName(entry.prescription)} was added to the setup but not saved to the local catalogue: ${describe(e)}`;
    }
  }

  /** After an import is in the setup: save it locally, or offer to connect a file first. */
  async function keepImported(entry: LocalLensEntry) {
    await initialStatus;
    if (local.kind === 'ready') return void saveLocal(entry);
    if (local.kind === 'unsupported') return close();
    const notNow = h('button', {}, 'Not now');
    notNow.addEventListener('click', close);
    savePanel.replaceChildren(
      h(
        'p',
        {},
        `${partName(entry.prescription)} is in the setup. To keep it in your local catalogue, ` +
          (local.kind === 'needs-permission' ? `reconnect ${local.name} or choose another file.` : 'open or create a catalogue file.'),
      ),
      h('div', { class: 'cat-actions' }, ...connectButtons(() => void saveLocal(entry)), h('span', { class: 'spacer' }), notNow),
    );
    showPanel(savePanel);
  }

  /** Adds a catalogue entry to the setup, applying a local lens's saved glass substitutes. */
  function add(entry: CatalogueEntry) {
    if (!entry.local) return insert(entry.prescription);
    const { prescription, substitutions } = entry.local;
    const needed = unknownGlasses(prescription, store.get().setup.glasses);
    const available = substitutedGlasses(substitutions);
    const glasses = Object.fromEntries(needed.flatMap((n) => (available[n] ? [[n, available[n]]] : [])));
    const missing = needed.filter((n) => !glasses[n]);
    if (missing.length === 0) return insert(prescription, glasses);
    chooseGlasses(prescription, missing, 'Cancel', (choices) => {
      placeLens(prescription, { ...glasses, ...substitutedGlasses(choices) });
      void saveLocal({ prescription, substitutions: { ...substitutions, ...choices } }, true);
    });
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
    if (unknown.length === 0) {
      placeLens(prescription);
      void keepImported({ prescription, substitutions: {} });
      return;
    }
    chooseGlasses(prescription, unknown, 'Cancel import', (choices) => {
      placeLens(prescription, substitutedGlasses(choices));
      void keepImported({ prescription, substitutions: choices });
    });
  });

  const initialStatus = checking ? localStatus().then(setLocal) : Promise.resolve();
  renderLocal();
  renderList();
  document.body.append(dialog);
  dialog.showModal();
  search.focus();
}
