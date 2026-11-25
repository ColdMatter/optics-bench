import { parseSetup, serialiseSetup } from '../engine/io';
import type { Id, Setup } from '../engine/types';

export interface AppState {
  setup: Setup;
  /** A source, an optic or a measurement arrow. */
  selectedId: Id | null;
}

export interface Store {
  get(): AppState;
  /** `coalesce`: consecutive updates with the same key form one undo step; `select` breaks a run. */
  apply(update: (s: Setup) => Setup, label: string, opts?: { coalesce?: string }): void;
  select(id: Id | null): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Label of the edit that undo (or redo) would revert (or re-apply). */
  undoLabel(): string | null;
  redoLabel(): string | null;
  subscribe(fn: (s: AppState) => void): () => void;
}

const AUTOSAVE_KEY = 'optics-sim/setup/v1';
const UNREADABLE_KEY = `${AUTOSAVE_KEY}/unreadable`;

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function storedText(storage: Storage | null): string | null {
  try {
    return storage?.getItem(AUTOSAVE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** The autosaved setup, or why it could not be read (e.g. saved by a newer build); null if none. */
export function readAutosave(storage: Storage | null = browserStorage()): { setup: Setup } | { error: string } | null {
  const text = storedText(storage);
  if (text === null) return null;
  try {
    return { setup: parseSetup(text) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function loadAutosave(storage: Storage | null = browserStorage()): Setup | null {
  const saved = readAutosave(storage);
  return saved && 'setup' in saved ? saved.setup : null;
}

/** Keeps an unreadable autosave under a separate key; false if it could not be kept. */
function backUpUnreadable(storage: Storage | null): boolean {
  const saved = readAutosave(storage);
  if (!saved || 'setup' in saved) return true;
  try {
    storage!.setItem(UNREADABLE_KEY, storedText(storage)!);
    return true;
  } catch {
    return false;
  }
}

function autosave(storage: Storage | null, setup: Setup): void {
  if (!storage) return;
  try {
    storage.setItem(AUTOSAVE_KEY, serialiseSetup(setup));
  } catch {
    // Private windows and full quotas refuse writes; the session carries on unsaved.
  }
}

function hasElement(setup: Setup, id: Id): boolean {
  return setup.sources.some((s) => s.id === id) || setup.optics.some((o) => o.id === id) || !!setup.measurements?.some((m) => m.id === id);
}

interface Step {
  setup: Setup;
  label: string;
}

export function createStore(initial: Setup, storageIn: Storage | null = browserStorage()): Store {
  // Overwriting an autosave we could neither read nor back up would lose someone's work.
  const storage = backUpUnreadable(storageIn) ? storageIn : null;
  let state: AppState = { setup: initial, selectedId: null };
  const past: Step[] = [];
  const future: Step[] = [];
  let coalescing: string | null = null;
  const listeners = new Set<(s: AppState) => void>();

  const emit = () => {
    for (const fn of [...listeners]) fn(state);
  };
  const setSetup = (setup: Setup) => {
    const selectedId = state.selectedId !== null && hasElement(setup, state.selectedId) ? state.selectedId : null;
    state = { setup, selectedId };
    autosave(storage, setup);
    emit();
  };
  const travel = (from: Step[], to: Step[]) => {
    const step = from.pop();
    if (!step) return;
    to.push({ setup: state.setup, label: step.label });
    coalescing = null;
    setSetup(step.setup);
  };

  autosave(storage, initial);

  return {
    get: () => state,
    apply(update, label, opts) {
      const next = update(state.setup);
      if (next === state.setup) return;
      const key = opts?.coalesce ?? null;
      if (key === null || key !== coalescing || past.length === 0) past.push({ setup: state.setup, label });
      coalescing = key;
      future.length = 0;
      setSetup(next);
    },
    select(id) {
      coalescing = null;
      if (id === state.selectedId) return;
      state = { ...state, selectedId: id };
      emit();
    },
    undo: () => travel(past, future),
    redo: () => travel(future, past),
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    undoLabel: () => past[past.length - 1]?.label ?? null,
    redoLabel: () => future[future.length - 1]?.label ?? null,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
