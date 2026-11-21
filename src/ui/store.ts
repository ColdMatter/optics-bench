import { parseSetup, serialiseSetup } from '../engine/io';
import type { Id, Setup } from '../engine/types';

export interface AppState {
  setup: Setup;
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

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadAutosave(storage: Storage | null = browserStorage()): Setup | null {
  if (!storage) return null;
  try {
    const text = storage.getItem(AUTOSAVE_KEY);
    return text === null ? null : parseSetup(text);
  } catch {
    return null;
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
  return setup.sources.some((s) => s.id === id) || setup.optics.some((o) => o.id === id);
}

interface Step {
  setup: Setup;
  label: string;
}

export function createStore(initial: Setup, storage: Storage | null = browserStorage()): Store {
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
