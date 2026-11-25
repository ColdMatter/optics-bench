import { readPrescription, SetupFormatError } from './io';
import type { LensPrescription } from './types';

/** What an unknown glass was replaced with when its lens was imported. */
export type GlassChoice = { kind: 'bundled'; name: string } | { kind: 'index'; index: number };

/** One lens in a local catalogue file, with the substitutes chosen for its non-bundled glasses. */
export interface LocalLensEntry {
  prescription: LensPrescription;
  substitutions: Record<string, GlassChoice>;
}

/** A local lens catalogue file (`my-lenses.json`). */
export interface LocalLensFile {
  version: 1;
  lenses: LocalLensEntry[];
}

export const emptyLensFile = (): LocalLensFile => ({ version: 1, lenses: [] });

const fail = (path: string, expected: string): never => {
  throw new SetupFormatError(`${path}: ${expected}`);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function readChoice(v: unknown, path: string): GlassChoice {
  if (!isObj(v)) return fail(path, 'expected an object');
  if (v.kind === 'bundled') {
    if (typeof v.name !== 'string' || v.name === '') return fail(`${path}.name`, 'expected a non-empty string');
    return { kind: 'bundled', name: v.name };
  }
  if (v.kind === 'index') {
    if (typeof v.index !== 'number' || !Number.isFinite(v.index) || v.index <= 1) return fail(`${path}.index`, 'expected a number greater than 1');
    return { kind: 'index', index: v.index };
  }
  return fail(`${path}.kind`, 'expected "bundled" or "index"');
}

/** Reads a local catalogue file. Empty text is an empty catalogue (a newly created file). */
export function parseLensFile(text: string): LocalLensFile {
  if (text.trim() === '') return emptyLensFile();
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new SetupFormatError(`not JSON (${(e as Error).message})`);
  }
  if (!isObj(doc)) return fail('document', 'expected an object');
  if (doc.version !== 1) {
    if (typeof doc.version === 'number' && doc.version > 1) throw new SetupFormatError('made by a newer version of the app');
    return fail('version', 'expected 1');
  }
  if (!Array.isArray(doc.lenses)) return fail('lenses', 'expected an array');
  return {
    version: 1,
    lenses: doc.lenses.map((v, i) => {
      const path = `lenses[${i}]`;
      if (!isObj(v)) return fail(path, 'expected an object');
      const subs = v.substitutions ?? {};
      if (!isObj(subs)) return fail(`${path}.substitutions`, 'expected an object');
      return {
        prescription: readPrescription(v.prescription, `${path}.prescription`),
        substitutions: Object.fromEntries(Object.entries(subs).map(([name, c]) => [name, readChoice(c, `${path}.substitutions.${name}`)])),
      };
    }),
  };
}

export function serialiseLensFile(file: LocalLensFile): string {
  return JSON.stringify(file, null, 2) + '\n';
}

/** The file with `entry` added, replacing any lens with the same part number in place. */
export function withLens(file: LocalLensFile, entry: LocalLensEntry): LocalLensFile {
  const i = file.lenses.findIndex((l) => l.prescription.partNumber === entry.prescription.partNumber);
  const lenses = i < 0 ? [...file.lenses, entry] : file.lenses.map((l, j) => (j === i ? entry : l));
  return { ...file, lenses };
}

export function withoutLens(file: LocalLensFile, partNumber: string): LocalLensFile {
  return { ...file, lenses: file.lenses.filter((l) => l.prescription.partNumber !== partNumber) };
}

/**
 * The prescription as the shared catalogue would hold it, which has no room for substitutions:
 * a glass replaced by a bundled glass is renamed to it; a constant index or a missing substitute
 * makes the lens unpromotable. `bundledName` gives a bundled glass's canonical name, or null.
 */
export function forSharedCatalogue(
  entry: LocalLensEntry,
  bundledName: (glass: string) => string | null,
): { prescription: LensPrescription } | { reason: string } {
  const surfaces = [];
  for (const s of entry.prescription.surfaces) {
    if (s.glassAfter === null || bundledName(s.glassAfter)) {
      surfaces.push(s);
      continue;
    }
    const choice = entry.substitutions[s.glassAfter];
    if (!choice) return { reason: `glass ${s.glassAfter} is not bundled and has no substitute` };
    if (choice.kind === 'index') {
      return { reason: `glass ${s.glassAfter} was replaced by a constant index (n = ${choice.index}), which the shared catalogue cannot hold` };
    }
    const name = bundledName(choice.name);
    if (!name) return { reason: `the substitute for ${s.glassAfter}, ${choice.name}, is not a bundled glass` };
    surfaces.push({ ...s, glassAfter: name });
  }
  return { prescription: { ...entry.prescription, surfaces } };
}
