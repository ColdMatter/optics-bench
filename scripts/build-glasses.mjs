// Usage: node scripts/build-glasses.mjs <path-to-refractiveindex.info-database-clone>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('Usage: node scripts/build-glasses.mjs <path-to-refractiveindex.info-database>');
  process.exit(1);
}

// Earlier vendors win when two catalogues share a name.
const vendors = ['schott', 'ohara', 'cdgm', 'hoya', 'sumita', 'hikari'];
const glasses = {};

// Materials that vendors' Zemax files name with Zemax's own catalogue names (its MISC
// catalogue), mapped to a refractiveindex.info page with a formula 1–3 entry. Not available:
// B270 (tabulated only), ZNS_IR (formula 4), INFRASIL, and moulded variants of catalogue glasses.
const MATERIALS = {
  F_SILICA: 'main/SiO2/nk/Malitson.yml',
  CAF2: 'main/CaF2/nk/Malitson.yml',
  ZNSE: 'main/ZnSe/nk/Connolly.yml',
  SILICON: 'main/Si/nk/Salzberg.yml',
  GERMANIUM: 'main/Ge/nk/Burnett.yml',
  MGF2: 'main/MgF2/nk/Dodge-o.yml',
  ACRYLIC: 'organic/(C5H8O2)n - poly(methyl methacrylate)/nk/Szczurowski.yml',
  // Schott's old BK7, replaced by N-BK7 with the same index and dispersion.
  BK7: 'specs/schott/optical/N-BK7.yml',
};

function read(name, path) {
  const doc = parse(readFileSync(path, 'utf8'));
  const entry = (doc.DATA ?? []).find((d) => /^formula [123]$/.test(d.type));
  if (!entry) return null;
  const [lo, hi] = String(entry.wavelength_range).trim().split(/\s+/).map(Number);
  return {
    name,
    formula: Number(entry.type.slice('formula '.length)),
    coefficients: String(entry.coefficients).trim().split(/\s+/).map(Number),
    rangeUm: [lo, hi],
  };
}

for (const vendor of vendors) {
  const dir = join(dbPath, 'database', 'data', 'specs', vendor, 'optical');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml')).sort()) {
    const name = file.slice(0, -'.yml'.length);
    if (name in glasses) continue;
    const glass = read(name, join(dir, file));
    if (glass) glasses[name] = glass;
  }
}

for (const [name, page] of Object.entries(MATERIALS)) {
  if (name in glasses) throw new Error(`${name} is already a catalogue glass`);
  const glass = read(name, join(dbPath, 'database', 'data', page));
  if (!glass) throw new Error(`${page}: no formula 1–3 entry`);
  glasses[name] = glass;
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'glasses.json');
writeFileSync(out, JSON.stringify(glasses) + '\n');
console.log(`Wrote ${Object.keys(glasses).length} glasses to ${out}`);
