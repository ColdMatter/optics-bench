// The local lens catalogue: a JSON file the user chooses, read and written in place through the
// File System Access API (Chrome and Edge). The file handle is remembered in IndexedDB, so the
// same file reconnects next session, after Chrome asks once for permission again.
import { emptyLensFile, parseLensFile, serialiseLensFile, type LocalLensFile } from '../engine/lensLibrary';

// Parts of the API that TypeScript's DOM library doesn't declare.
interface PermissionedHandle extends FileSystemFileHandle {
  queryPermission?(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
}
interface PickerOptions {
  id?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
  suggestedName?: string;
  mode?: 'read' | 'readwrite';
}
interface Pickers {
  showOpenFilePicker?(options?: PickerOptions): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(options?: PickerOptions): Promise<FileSystemFileHandle>;
}

export type LocalStatus =
  | { kind: 'unsupported' }
  | { kind: 'none' }
  | { kind: 'needs-permission'; name: string }
  | { kind: 'ready'; name: string; file: LocalLensFile }
  | { kind: 'error'; name: string; message: string };

const DB_NAME = 'optics-bench';
const STORE = 'handles';
const KEY = 'local-lens-catalogue';
const PICKER = {
  id: 'local-lens-catalogue',
  types: [{ description: 'Lens catalogue', accept: { 'application/json': ['.json'] } }],
};
export const SUGGESTED_NAME = 'my-lenses.json';

const pickers = () => globalThis as unknown as Pickers;

export function localCatalogueSupported(): boolean {
  const w = pickers();
  return typeof w.showOpenFilePicker === 'function' && typeof w.showSaveFilePicker === 'function' && typeof indexedDB !== 'undefined';
}

function withStore<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE, mode);
      const request = op(tx.objectStore(STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(request.result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(tx.error ?? request.error);
      };
    };
  });
}

const savedHandle = () => withStore<PermissionedHandle | undefined>('readonly', (s) => s.get(KEY));
const saveHandle = (handle: FileSystemFileHandle) => withStore('readwrite', (s) => s.put(handle, KEY));

async function permission(handle: PermissionedHandle, request: boolean): Promise<PermissionState> {
  const state = (await handle.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
  if (state === 'granted' || !request) return state;
  return (await handle.requestPermission?.({ mode: 'readwrite' })) ?? 'denied';
}

async function read(handle: FileSystemFileHandle): Promise<LocalLensFile> {
  return parseLensFile(await (await handle.getFile()).text());
}

async function write(handle: FileSystemFileHandle, file: LocalLensFile): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(serialiseLensFile(file));
  await writable.close();
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/**
 * The remembered file's state. `requestAccess` asks Chrome for permission if it needs asking;
 * call it with true only from a click, since the browser requires a user gesture for that.
 */
export async function localStatus(requestAccess = false): Promise<LocalStatus> {
  if (!localCatalogueSupported()) return { kind: 'unsupported' };
  let handle: PermissionedHandle | undefined;
  try {
    handle = await savedHandle();
  } catch (e) {
    return { kind: 'error', name: '', message: `cannot read the browser's saved file link (${describe(e)})` };
  }
  if (!handle) return { kind: 'none' };
  try {
    if ((await permission(handle, requestAccess)) !== 'granted') return { kind: 'needs-permission', name: handle.name };
    return { kind: 'ready', name: handle.name, file: await read(handle) };
  } catch (e) {
    return { kind: 'error', name: handle.name, message: describe(e) };
  }
}

/**
 * Lets the user pick an existing catalogue file (`open`) or create one (`new`), and remembers it.
 * Resolves null if they cancel the picker. A file that isn't a lens catalogue is never
 * overwritten: the result is an error and the previously remembered file stays.
 */
export async function connectLocal(how: 'open' | 'new'): Promise<LocalStatus | null> {
  const w = pickers();
  let handle: FileSystemFileHandle;
  try {
    handle =
      how === 'open'
        ? (await w.showOpenFilePicker!({ ...PICKER, mode: 'readwrite' }))[0]!
        : await w.showSaveFilePicker!({ ...PICKER, suggestedName: SUGGESTED_NAME });
  } catch (e) {
    if (isAbort(e)) return null;
    return { kind: 'error', name: '', message: describe(e) };
  }
  try {
    if ((await permission(handle, true)) !== 'granted') return { kind: 'needs-permission', name: handle.name };
    let file: LocalLensFile;
    try {
      file = await read(handle);
    } catch (e) {
      return { kind: 'error', name: handle.name, message: `not a lens catalogue: ${describe(e)}` };
    }
    // A new file is empty until written; give it the catalogue skeleton straight away.
    if ((await handle.getFile()).size === 0) await write(handle, emptyLensFile());
    await saveHandle(handle);
    return { kind: 'ready', name: handle.name, file };
  } catch (e) {
    return { kind: 'error', name: handle.name, message: describe(e) };
  }
}

/** Re-reads the remembered file, applies `change` and writes it back. Throws if that fails. */
export async function updateLocal(change: (file: LocalLensFile) => LocalLensFile): Promise<LocalStatus & { kind: 'ready' }> {
  const handle = await savedHandle();
  if (!handle) throw new Error('no local catalogue file is connected');
  if ((await permission(handle, true)) !== 'granted') throw new Error(`no permission to write ${handle.name}`);
  const file = change(await read(handle));
  await write(handle, file);
  return { kind: 'ready', name: handle.name, file };
}
