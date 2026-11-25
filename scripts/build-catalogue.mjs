// Usage: npm run catalogue [-- <zemaxcatalog.zip or .ZMF>] [--offline]
//
// Builds src/data/thorlabs-catalogue.json from Thorlabs' complete Zemax catalogue, the zip offered
// at https://www.thorlabs.com/software-pages/zemax?tabName=Zemax%20Catalog. With no file given it
// downloads that zip into scripts/vendor-cache/ (gitignored); --offline uses the cached copy.
//
// Parts already in src/data/lenses.json (`npm run lenses`, from each part's own Zemax file and
// checked against Thorlabs' focal-shift data) are left to that file: the catalogue lacks some of
// them and has older prescriptions for others (AC254-040-A and -075-A with legacy SF5).
//
// Every lens is read with the app's own .zmx parser. Its part number comes from the catalogue
// record: the NAME line inside the .zmx is often a description. A lens is left out if the parser
// rejects it (unsupported surface types such as toroidal, odd asphere or GRIN) or if it names a
// glass that src/data/glasses.json lacks. The parts left out, and why, are listed in
// scripts/vendor-cache/catalogue-skipped.txt.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeZmx, parseZmx } from '../src/engine/zmx.ts';
import { readZipEntry } from './lib/zip.mjs';
import { readZmf } from './lib/zmf.mjs';

const CATALOGUE_URL = 'https://media.thorlabs.com/contentassets/0ee24bcce2224cc6ae338b2bdaa9e212/zemaxcatalog.zip';
const CATALOGUE_PAGE = 'https://www.thorlabs.com/software-pages/zemax?tabName=Zemax%20Catalog';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, 'scripts', 'vendor-cache');
const cachedZip = join(cacheDir, 'zemaxcatalog.zip');
const lensesPath = join(root, 'src', 'data', 'lenses.json');
const outPath = join(root, 'src', 'data', 'thorlabs-catalogue.json');
const skippedPath = join(cacheDir, 'catalogue-skipped.txt');

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const given = args.find((a) => a !== '--offline');

async function catalogueBytes() {
  if (given) return readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), given));
  if (!offline) {
    console.log(`Downloading ${CATALOGUE_URL}`);
    const response = await fetch(CATALOGUE_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}. If the link has moved, download the zip from ${CATALOGUE_PAGE} and pass its path.`);
    }
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachedZip, Buffer.from(await response.arrayBuffer()));
  }
  if (!existsSync(cachedZip)) throw new Error(`no cached catalogue at ${cachedZip}; run without --offline first`);
  return readFileSync(cachedZip);
}

let buf = await catalogueBytes();
let zmfName = given ?? 'zemaxcatalog.zip';
if (buf.readUInt32LE(0) === 0x04034b50) {
  const entry = readZipEntry(buf, (name) => /\.zmf$/i.test(name));
  if (!entry) throw new Error('the zip holds no .ZMF catalogue');
  ({ name: zmfName, data: buf } = entry);
}

const knownGlasses = new Set(
  Object.values(JSON.parse(readFileSync(join(root, 'src', 'data', 'glasses.json'), 'utf8'))).map((g) => g.name.toLowerCase()),
);
const bundled = new Set(JSON.parse(readFileSync(lensesPath, 'utf8')).map((l) => l.partNumber));
const lenses = [];
const skipped = [];
let alreadyBundled = 0;
const byReason = new Map();
const missingGlasses = new Map();
const skip = (part, reason, group) => {
  skipped.push(`${part}\t${reason}`);
  byReason.set(group, (byReason.get(group) ?? 0) + 1);
};

// Crystals that Zemax's INFRARED catalogue names like an optical glass in glasses.json. A lens
// whose file lists that catalogue means the crystal, which glasses.json lacks.
const INFRARED_CLASHES = { BAF2: 'barium fluoride crystal (BAF2 in glasses.json is the CDGM glass)' };

const records = readZmf(buf);
for (const { part, data } of records) {
  if (bundled.has(part)) {
    alreadyBundled++;
    continue;
  }
  let lens;
  try {
    lens = parseZmx(decodeZmx(new Uint8Array(data)), 'Thorlabs');
  } catch (e) {
    skip(part, e.message, e.message.replace(/^surface \d+: /, '').replace(/\d+/g, 'N'));
    continue;
  }
  const catalogues = (/^\s*GCAT (.*)$/m.exec(decodeZmx(new Uint8Array(data)))?.[1] ?? '').trim().toUpperCase().split(/\s+/);
  const clash = catalogues.includes('INFRARED') && lens.surfaces.find((s) => s.glassAfter && s.glassAfter.toUpperCase() in INFRARED_CLASHES);
  if (clash) {
    skip(part, INFRARED_CLASHES[clash.glassAfter.toUpperCase()], 'glass not in glasses.json');
    missingGlasses.set(`${clash.glassAfter} (crystal)`, (missingGlasses.get(`${clash.glassAfter} (crystal)`) ?? 0) + 1);
    continue;
  }
  const unknown = [...new Set(lens.surfaces.flatMap((s) => (s.glassAfter && !knownGlasses.has(s.glassAfter.toLowerCase()) ? [s.glassAfter] : [])))];
  if (unknown.length) {
    skip(part, `glass not in glasses.json: ${unknown.join(', ')}`, 'glass not in glasses.json');
    for (const g of unknown) missingGlasses.set(g, (missingGlasses.get(g) ?? 0) + 1);
    continue;
  }
  lenses.push({ ...lens, partNumber: part, sourceRef: `https://www.thorlabs.com/item/${encodeURIComponent(part)}` });
}

// One lens per line keeps diffs between catalogue versions readable.
writeFileSync(outPath, `[\n${lenses.map((l) => JSON.stringify(l)).join(',\n')}\n]\n`);
mkdirSync(cacheDir, { recursive: true });
writeFileSync(skippedPath, skipped.join('\n') + '\n');

console.log(`${zmfName}: ${records.length} lenses`);
console.log(`${alreadyBundled} already in src/data/lenses.json`);
console.log(`Wrote ${lenses.length} to src/data/thorlabs-catalogue.json`);
console.log(`Left out ${skipped.length} (listed in scripts/vendor-cache/catalogue-skipped.txt):`);
for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${reason}`);
const glassList = [...missingGlasses].sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g} ${n}`);
if (glassList.length) console.log(`Glasses missing: ${glassList.join(', ')}`);
