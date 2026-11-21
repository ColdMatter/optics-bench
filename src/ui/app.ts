import { traceGaussians } from '../engine/gaussian';
import { parseSetup, serialiseSetup } from '../engine/io';
import { traceSetup } from '../engine/trace';
import type { GaussianTrace, Setup, SetupTrace } from '../engine/types';
import { h, pickFile } from './controls';
import { insertElement, kindNames, newOptic, newSource, warningsByElement, type OpticKind, type SourceKind } from './elements';
import { createPropertiesPanel } from './properties';
import type { AppState, Store } from './store';
import { createElementsTable } from './table';

export interface ViewToggles {
  showRays: boolean;
  showGaussian: boolean;
}

export interface TraceResults {
  trace: SetupTrace;
  gaussians: GaussianTrace[];
}

export interface Frame extends TraceResults {
  state: AppState;
  toggles: ViewToggles;
}

/** What later panels plug into. */
export interface App {
  store: Store;
  benchCanvas: HTMLCanvasElement;
  readoutsEl: HTMLElement;
  solverEl: HTMLElement;
  toggles(): ViewToggles;
  onTogglesChange(fn: (t: ViewToggles) => void): () => void;
  /** The trace of the current setup, computed once per setup. */
  results(): TraceResults;
  /** Called at most once per animation frame after the store, the toggles or the bench size change. */
  onFrame(fn: (frame: Frame) => void): () => void;
  requestFrame(): void;
  /** Replaces what "Add optic ▸ Catalogue lens…" does (by default it adds an AC254-100-B). */
  setCatalogueAction(action: () => void): void;
}

const SAVE_NAME = 'optics-setup.json';
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const shortcut = (key: string, shift = false) => (isMac ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`);

function computeResults(setup: Setup): TraceResults {
  const trace = traceSetup(setup);
  return { trace, gaussians: traceGaussians(setup, trace.endZ) };
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file'].includes(target.type);
}

interface MenuItem {
  label: string;
  action: () => void;
}

function menuButton(label: string, items: MenuItem[]): HTMLElement {
  const button = h('button', { class: 'menu-button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, label, h('span', { class: 'caret' }, '▾'));
  const list = h('div', { class: 'menu', role: 'menu' });
  list.hidden = true;
  const wrapper = h('div', { class: 'menu-wrap' }, button, list);
  const close = () => {
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  for (const item of items) {
    const entry = h('button', { role: 'menuitem' }, item.label);
    entry.addEventListener('click', () => {
      close();
      item.action();
    });
    list.append(entry);
  }
  button.addEventListener('click', () => {
    const opening = list.hidden;
    list.hidden = !opening;
    button.setAttribute('aria-expanded', String(opening));
    if (opening) (list.firstElementChild as HTMLElement | null)?.focus();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!wrapper.contains(e.target as Node)) close();
  });
  wrapper.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !list.hidden) {
      close();
      button.focus();
    }
  });
  return wrapper;
}

export function showMessage(title: string, message: string): void {
  const ok = h('button', { class: 'primary', value: 'ok' }, 'OK');
  const dialog = h('dialog', { class: 'message' }, h('h3', {}, title), h('p', {}, message), h('form', { method: 'dialog' }, ok));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createApp(root: HTMLElement, store: Store): App {
  let toggles: ViewToggles = { showRays: true, showGaussian: true };
  const toggleListeners = new Set<(t: ViewToggles) => void>();
  const frameListeners = new Set<(f: Frame) => void>();
  let catalogueAction = () => insertElement(store, newOptic('lens', store.get()));

  let resultsFor: Setup | null = null;
  let cached: TraceResults = { trace: { sources: [], warnings: [], endZ: 0 }, gaussians: [] };
  const results = (): TraceResults => {
    const { setup } = store.get();
    if (setup !== resultsFor) {
      resultsFor = setup;
      try {
        cached = computeResults(setup);
      } catch (e) {
        console.error('Tracing failed', e);
        cached = { trace: { sources: [], warnings: [], endZ: 0 }, gaussians: [] };
      }
    }
    return cached;
  };

  // Toolbar
  const addSource = (kind: SourceKind) => insertElement(store, newSource(kind, store.get()));
  const addOptic = (kind: OpticKind) => insertElement(store, newOptic(kind, store.get()));
  const sourceMenu = menuButton(
    'Add source',
    (['point', 'collimated', 'gaussian'] as const).map((kind) => ({ label: kindNames[kind], action: () => addSource(kind) })),
  );
  const opticMenu = menuButton('Add optic', [
    { label: 'Catalogue lens…', action: () => catalogueAction() },
    ...(['ideal', 'slm', 'aperture', 'screen'] as const).map((kind) => ({ label: kindNames[kind], action: () => addOptic(kind) })),
  ]);

  const openButton = h('button', { title: 'Open a setup file' }, 'Open…');
  openButton.addEventListener('click', async () => {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    let setup: Setup;
    try {
      setup = parseSetup(await file.text());
    } catch (e) {
      showMessage(`Could not open ${file.name}`, (e as Error).message);
      return;
    }
    store.apply(() => setup, `Open ${file.name}`);
    store.select(null);
  });
  const saveButton = h('button', { title: 'Save the setup as a JSON file' }, 'Save');
  saveButton.addEventListener('click', () => download(SAVE_NAME, serialiseSetup(store.get().setup)));

  const undoButton = h('button', {}, 'Undo');
  const redoButton = h('button', {}, 'Redo');
  undoButton.addEventListener('click', () => store.undo());
  redoButton.addEventListener('click', () => store.redo());

  const toggleButton = (label: string, key: keyof ViewToggles) => {
    const b = h('button', { class: 'toggle', 'aria-pressed': String(toggles[key]) }, label);
    b.addEventListener('click', () => {
      const next = { ...toggles, [key]: !toggles[key] };
      if (!next.showRays && !next.showGaussian) return;
      toggles = next;
      for (const fn of [...toggleListeners]) fn(toggles);
      requestFrame();
    });
    return b;
  };
  const raysToggle = toggleButton('Rays', 'showRays');
  const gaussianToggle = toggleButton('Gaussian', 'showGaussian');

  const toolbar = h(
    'header',
    { class: 'toolbar' },
    h('span', { class: 'app-title' }, 'Optics bench'),
    sourceMenu,
    opticMenu,
    h('span', { class: 'sep' }),
    openButton,
    saveButton,
    h('span', { class: 'sep' }),
    undoButton,
    redoButton,
    h('span', { class: 'spacer' }),
    h('span', { class: 'toolbar-label' }, 'Show'),
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Show' }, raysToggle, gaussianToggle),
  );

  // Panels
  const benchCanvas = h('canvas', { class: 'bench-canvas', 'aria-label': 'Optical bench' });
  const bench = h('section', { class: 'panel bench' }, benchCanvas);
  const panel = (cls: string, title: string) => {
    const body = h('div', { class: 'panel-body' });
    const section = h('section', { class: `panel ${cls}` }, h('h2', {}, title), body);
    return { section, body };
  };
  const elements = panel('elements', 'Elements');
  const properties = panel('properties', 'Properties');
  const readouts = panel('readouts', 'Readouts');
  const solver = panel('solver', 'Solver');
  root.replaceChildren(
    h('div', { class: 'app' }, toolbar, bench, elements.section, properties.section, readouts.section, solver.section),
  );

  const table = createElementsTable(elements.body, store);
  const props = createPropertiesPanel(properties.body, store);

  // Frame loop
  const schedule: (cb: () => void) => void =
    typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : (cb) => setTimeout(cb, 16);
  let pending = false;
  function requestFrame() {
    if (pending) return;
    pending = true;
    schedule(renderFrame);
  }
  function renderFrame() {
    pending = false;
    const state = store.get();
    const frame: Frame = { state, toggles, ...results() };
    const warnings = warningsByElement(state.setup, frame.trace.warnings);
    table.render(state, warnings);
    props.render(state, warnings);
    undoButton.disabled = !store.canUndo();
    redoButton.disabled = !store.canRedo();
    undoButton.title = store.canUndo() ? `Undo ${store.undoLabel()} (${shortcut('Z')})` : 'Nothing to undo';
    redoButton.title = store.canRedo() ? `Redo ${store.redoLabel()} (${shortcut('Z', true)})` : 'Nothing to redo';
    raysToggle.setAttribute('aria-pressed', String(toggles.showRays));
    gaussianToggle.setAttribute('aria-pressed', String(toggles.showGaussian));
    for (const fn of [...frameListeners]) fn(frame);
  }
  store.subscribe(requestFrame);

  const resizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(bench.clientWidth * dpr));
    const height = Math.max(1, Math.round(bench.clientHeight * dpr));
    if (benchCanvas.width !== width || benchCanvas.height !== height) {
      benchCanvas.width = width;
      benchCanvas.height = height;
      requestFrame();
    }
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(resizeCanvas).observe(bench);
  resizeCanvas();

  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || isTyping(e.target)) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) store.undo();
    else if ((key === 'z' && e.shiftKey) || key === 'y') store.redo();
    else return;
    e.preventDefault();
  });

  requestFrame();

  return {
    store,
    benchCanvas,
    readoutsEl: readouts.body,
    solverEl: solver.body,
    toggles: () => toggles,
    onTogglesChange(fn) {
      toggleListeners.add(fn);
      return () => toggleListeners.delete(fn);
    },
    results,
    onFrame(fn) {
      frameListeners.add(fn);
      return () => frameListeners.delete(fn);
    },
    requestFrame,
    setCatalogueAction(action) {
      catalogueAction = action;
    },
  };
}
