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
const vendors = ['schott', 'ohara', 'cdgm', 'hoya', 'sumita'];
const glasses = {};

for (const vendor of vendors) {
  const dir = join(dbPath, 'database', 'data', 'specs', vendor, 'optical');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml')).sort()) {
    const name = file.slice(0, -'.yml'.length);
    if (name in glasses) continue;
    const doc = parse(readFileSync(join(dir, file), 'utf8'));
    const entry = (doc.DATA ?? []).find((d) => /^formula [123]$/.test(d.type));
    if (!entry) continue;
    const [lo, hi] = String(entry.wavelength_range).trim().split(/\s+/).map(Number);
    glasses[name] = {
      name,
      formula: Number(entry.type.slice('formula '.length)),
      coefficients: String(entry.coefficients).trim().split(/\s+/).map(Number),
      rangeUm: [lo, hi],
    };
  }
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'glasses.json');
writeFileSync(out, JSON.stringify(glasses) + '\n');
console.log(`Wrote ${Object.keys(glasses).length} glasses to ${out}`);
