import { describe, expect, test } from 'vitest';
import { createStore, loadAutosave, readAutosave } from '../src/ui/store';
import type { Setup } from '../src/engine/types';

const initial: Setup = {
  version: 1,
  sources: [],
  optics: [{ kind: 'screen', id: 'sc', label: 'Screen', z: 100 }],
  glasses: {},
};
const moveScreen = (z: number) => (s: Setup): Setup => ({ ...s, optics: [{ kind: 'screen', id: 'sc', label: 'Screen', z }] });
const screenZ = (s: Setup) => s.optics[0]!.z;

class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

class ThrowingStorage extends MemoryStorage {
  override getItem(): string | null {
    throw new Error('denied');
  }
  override setItem(): void {
    throw new Error('quota');
  }
}

describe('history', () => {
  test('undo/redo', () => {
    const store = createStore(initial, null);
    store.apply(moveScreen(120), 'first');
    store.apply(moveScreen(140), 'second');
    store.undo();
    store.undo();
    expect(store.get().setup).toEqual(initial);
    expect(store.canUndo()).toBe(false);
    store.redo();
    expect(screenZ(store.get().setup)).toBe(120);
    expect(store.canRedo()).toBe(true);
  });

  test('coalesced drag is one step', () => {
    const store = createStore(initial, null);
    for (let i = 1; i <= 10; i++) store.apply(moveScreen(100 + i), 'drag', { coalesce: 'drag:sc' });
    expect(screenZ(store.get().setup)).toBe(110);
    store.undo();
    expect(store.get().setup).toEqual(initial);
  });

  test('selecting between drags of the same element splits them', () => {
    const store = createStore(initial, null);
    store.apply(moveScreen(110), 'drag', { coalesce: 'drag:sc' });
    store.select('sc');
    store.apply(moveScreen(120), 'drag', { coalesce: 'drag:sc' });
    store.undo();
    expect(screenZ(store.get().setup)).toBe(110);
  });

  test('a new edit clears the redo stack', () => {
    const store = createStore(initial, null);
    store.apply(moveScreen(120), 'first');
    store.undo();
    store.apply(moveScreen(130), 'other');
    expect(store.canRedo()).toBe(false);
  });

  test('selection is cleared when its element disappears', () => {
    const store = createStore(initial, null);
    store.select('sc');
    store.apply((s) => ({ ...s, optics: [] }), 'remove');
    expect(store.get().selectedId).toBeNull();
  });

  test('subscribers hear changes until they unsubscribe', () => {
    const store = createStore(initial, null);
    let calls = 0;
    const unsubscribe = store.subscribe(() => calls++);
    store.apply(moveScreen(120), 'move');
    store.select('sc');
    unsubscribe();
    store.undo();
    expect(calls).toBe(2);
  });
});

describe('autosave', () => {
  test('autosave survives throwing storage', () => {
    const storage = new ThrowingStorage();
    expect(() => {
      const store = createStore(initial, storage);
      store.apply(moveScreen(120), 'move');
    }).not.toThrow();
    expect(loadAutosave(storage)).toBeNull();
  });

  test('autosave round trip', () => {
    const storage = new MemoryStorage();
    createStore(initial, storage);
    expect(loadAutosave(storage)).toEqual(initial);
  });

  test('autosave follows edits and undo', () => {
    const storage = new MemoryStorage();
    const store = createStore(initial, storage);
    store.apply(moveScreen(120), 'move');
    expect(screenZ(loadAutosave(storage)!)).toBe(120);
    store.undo();
    expect(screenZ(loadAutosave(storage)!)).toBe(100);
  });

  test('a corrupt autosave is ignored, with the reason', () => {
    const storage = new MemoryStorage();
    storage.setItem('optics-sim/setup/v1', '{"version": 1, "sources": "nope"}');
    expect(loadAutosave(storage)).toBeNull();
    expect(readAutosave(storage)).toEqual({ error: 'sources: expected an array' });
  });

  test('nothing stored reads as null', () => expect(readAutosave(new MemoryStorage())).toBeNull());

  test('an unreadable autosave is backed up, not lost, when a store starts', () => {
    const storage = new MemoryStorage();
    const newer = '{"version": 2, "sources": []}';
    storage.setItem('optics-sim/setup/v1', newer);
    createStore(initial, storage);
    expect(storage.getItem('optics-sim/setup/v1/unreadable')).toBe(newer);
    expect(loadAutosave(storage)).toEqual(initial);
  });

  test('if the backup cannot be written the unreadable autosave is left alone', () => {
    class NoBackupStorage extends MemoryStorage {
      override setItem(key: string, value: string) {
        if (key.endsWith('/unreadable')) throw new Error('quota');
        super.setItem(key, value);
      }
    }
    const storage = new NoBackupStorage();
    storage.setItem('optics-sim/setup/v1', 'not json');
    const store = createStore(initial, storage);
    store.apply(moveScreen(120), 'move');
    expect(storage.getItem('optics-sim/setup/v1')).toBe('not json');
  });
});
