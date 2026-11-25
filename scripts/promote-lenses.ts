// Usage: npm run promote-lenses -- <my-lenses.json> [part …] [--replace]
//
// Copies lenses from a local catalogue file (the one the app's Import .zmx… writes) into the
// shared catalogue, src/data/extra-lenses.json, which the app lists alongside the Thorlabs parts.
// With no parts named it promotes every lens in the file. Not lenses.json: `npm run lenses`
// regenerates that from the Thorlabs list.
//
// The shared catalogue can't hold glass substitutions, so a glass replaced by a bundled glass is
// renamed to that glass, and a lens whose glass was replaced by a constant index (or has no
// substitute) is refused. A part already in the shared catalogue is refused unless --replace,
// and a Thorlabs part is always refused. Exits non-zero if anything was refused.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeGlassLookup } from '../src/engine/glass';
import { forSharedCatalogue, parseLensFile } from '../src/engine/lensLibrary';
import type { LensPrescription } from '../src/engine/types';

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const [fileArg, ...parts] = args.filter((a) => a !== '--replace');
if (!fileArg) {
  console.error('Usage: npm run promote-lenses -- <my-lenses.json> [part …] [--replace]');
  process.exit(2);
}

// npm runs scripts from the package root; read the user's path relative to where they ran it.
const local = parseLensFile(readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), fileArg), 'utf8'));
const dataDir = join(process.cwd(), 'src', 'data');
const extraPath = join(dataDir, 'extra-lenses.json');
const thorlabs = new Set((JSON.parse(readFileSync(join(dataDir, 'lenses.json'), 'utf8')) as LensPrescription[]).map((l) => l.partNumber.toLowerCase()));
const extra = JSON.parse(readFileSync(extraPath, 'utf8')) as LensPrescription[];

const lookup = makeGlassLookup();
const bundledName = (glass: string) => lookup(glass)?.name ?? null;

const say = (label: string, text: string) => console.log(`${`${label}:`.padEnd(10)}${text}`);

const wanted = new Set(parts.map((p) => p.toLowerCase()));
const selected = wanted.size ? local.lenses.filter((l) => wanted.has(l.prescription.partNumber.toLowerCase())) : local.lenses;
let failed = false;
for (const part of wanted) {
  if (!local.lenses.some((l) => l.prescription.partNumber.toLowerCase() === part)) {
    say('not found', `${part} is not in ${fileArg}`);
    failed = true;
  }
}

let changed = false;
for (const entry of selected) {
  const part = entry.prescription.partNumber;
  const key = part.toLowerCase();
  const refuse = (reason: string) => {
    say('refused', `${part}: ${reason}`);
    failed = true;
  };
  if (thorlabs.has(key)) {
    refuse('it is a bundled Thorlabs part');
    continue;
  }
  const existing = extra.findIndex((l) => l.partNumber.toLowerCase() === key);
  if (existing >= 0 && !replace) {
    refuse('already in the shared catalogue (pass --replace to overwrite it)');
    continue;
  }
  const result = forSharedCatalogue(entry, bundledName);
  if ('reason' in result) {
    refuse(result.reason);
    continue;
  }
  const renamed = entry.prescription.surfaces.flatMap((s, i) => {
    const now = result.prescription.surfaces[i]!.glassAfter;
    return s.glassAfter !== now ? [`${s.glassAfter} → ${now}`] : [];
  });
  if (existing >= 0) extra[existing] = result.prescription;
  else extra.push(result.prescription);
  changed = true;
  say(existing >= 0 ? 'replaced' : 'added', `${part}${renamed.length ? ` (glass ${[...new Set(renamed)].join(', ')})` : ''}`);
}

if (changed) {
  writeFileSync(extraPath, JSON.stringify(extra, null, 1) + '\n');
  console.log(`Wrote ${extra.length} ${extra.length === 1 ? 'lens' : 'lenses'} to src/data/extra-lenses.json. Rebuild and commit it.`);
} else {
  console.log('Nothing changed.');
}
process.exit(failed ? 1 : 0);
