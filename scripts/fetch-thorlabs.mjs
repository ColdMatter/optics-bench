// Usage: node scripts/fetch-thorlabs.mjs [--offline]
//
// Downloads the Thorlabs Zemax files, drawings and focal-shift data for the
// bundled lenses into scripts/vendor-cache/ (gitignored), then writes from that
// cache src/data/lenses.json, src/data/thorlabs-focal-shift/<part>.json and the
// drawings' focal lengths (tests/fixtures/thorlabs-drawing-focal-lengths.json).
// --offline skips the download. Reading the drawings needs pdftotext (Poppler).
//
// thorlabs.com is a single-page app, so product data is read from the GraphQL
// responses the pages make while loading in headless Chromium.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { decodeZmx, parseZmx } from '../src/engine/zmx.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, 'scripts', 'vendor-cache');
const manifestPath = join(cacheDir, 'manifest.json');
const lensesPath = join(root, 'src', 'data', 'lenses.json');
const focalShiftDir = join(root, 'src', 'data', 'thorlabs-focal-shift');
const drawingFocalLengthsPath = join(root, 'tests', 'fixtures', 'thorlabs-drawing-focal-lengths.json');
const glasses = JSON.parse(readFileSync(join(root, 'src', 'data', 'glasses.json'), 'utf8'));

const FAMILY_PAGES = [
  'https://www.thorlabs.com/unmounted-achromatic-doublets-ar-coated-400---700-nm',
  'https://www.thorlabs.com/unmounted-achromatic-doublets-ar-coated-650---1050-nm',
  'https://www.thorlabs.com/n-bk7-plano-convex-lenses-uncoated',
];

const achromats = (prefix, focals) =>
  ['A', 'B'].flatMap((coating) => focals.map((f) => `${prefix}-${String(f).padStart(3, '0')}-${coating}`));
// Ø1" rows of the N-BK7 plano-convex family table, f = 25 … 1000 mm.
const PLANO_CONVEX = [
  'LA1951', 'LA1805', 'LA1027', 'LA1422', 'LA1131', 'LA1134', 'LA1608', 'LA1509', 'LA1986',
  'LA1433', 'LA1229', 'LA1708', 'LA1461', 'LA1484', 'LA1172', 'LA1908', 'LA1978', 'LA1464',
];
const PARTS = [
  ...achromats('AC254', [30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 400, 500]),
  ...PLANO_CONVEX,
  ...achromats('AC508', [75, 100, 150, 200, 250, 300, 400, 500, 750, 1000]),
];

// Parts left out of the catalogue, and why.
const EXCLUDED = {
  'AC254-060-A': 'its flint, HOYA FD10, is not in the refractiveindex.info database',
};

const offline = process.argv.includes('--offline');
mkdirSync(cacheDir, { recursive: true });
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};

if (!offline) await download();
extractArchives();
const included = writeLenses();
writeFocalShifts(included);
writeDrawingFocalLengths(included);

async function download() {
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const products = new Map();
  const capture = async (req) => {
    if (!req.url().endsWith('/graphql')) return;
    const op = /"operationName":"(\w+)"/.exec(req.postData() ?? '')?.[1];
    if (op !== 'SearchFamilyProducts' && op !== 'GetProduct') return;
    try {
      const data = JSON.parse(await (await req.response()).text()).data;
      for (const p of op === 'GetProduct' ? [data.product] : data.familyProducts) {
        products.set(p.code, { ...products.get(p.code), ...p });
      }
    } catch {
      // A response that failed or was cut short: the part is retried from its own page below.
    }
  };
  page.on('requestfinished', capture);

  for (const url of FAMILY_PAGES) {
    console.log(`family ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 180_000 });
  }
  for (const part of PARTS) {
    if (products.get(part)?.assets) continue;
    console.log(`item ${part}`);
    await page.goto(`https://www.thorlabs.com/item/${part}`, { waitUntil: 'networkidle', timeout: 120_000 });
  }

  for (const part of PARTS) {
    const product = products.get(part);
    if (!product?.assets) {
      console.warn(`${part}: no product data`);
      continue;
    }
    const asset = (group) => product.assets.find((a) => a.group === group);
    const zemax = asset('Zemax (ZMX)') ?? asset('Zemax (ZAR)');
    const shiftTab = (product.infoIconTabsTL ?? []).find((t) => /focal length shift/i.test(t.title));
    const shiftHref = shiftTab && /href="([^"]+\.xlsx[^"]*)"/.exec(shiftTab.content)?.[1];
    const entry = {
      productPage: `https://www.thorlabs.com/item/${part}`,
      status: product.itemStatusTL,
      zemaxUrl: zemax?.optiUrl ?? null,
      zemaxKind: zemax ? (zemax.group === 'Zemax (ZMX)' ? 'zmx' : 'zar') : null,
      drawingUrl: asset('CAD PDF')?.optiUrl ?? null,
      focalShiftUrl: shiftHref ? toMediaUrl(shiftHref) : null,
    };
    manifest[part] = entry;
    if (entry.zemaxUrl) await save(page, entry.zemaxUrl, `${part}.${entry.zemaxKind}`);
    if (entry.drawingUrl) await save(page, entry.drawingUrl, `${part}.pdf`);
    if (entry.focalShiftUrl) await save(page, entry.focalShiftUrl, `${part}_flshift.xlsx`);
  }
  await browser.close();
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

// Asset links point at the CMS origin; media.thorlabs.com serves the same paths.
function toMediaUrl(url) {
  return url.replace(/^https:\/\/[^/]+\.episerver\.net\//, 'https://media.thorlabs.com/');
}

async function save(page, url, name) {
  const path = join(cacheDir, name);
  if (existsSync(path)) return;
  const response = await page.request.get(url);
  if (!response.ok()) throw new Error(`${url}: HTTP ${response.status()}`);
  writeFileSync(path, await response.body());
  console.log(`  saved ${name}`);
}

function extractArchives() {
  for (const [part, entry] of Object.entries(manifest)) {
    const zar = join(cacheDir, `${part}.zar`);
    if (entry.zemaxKind !== 'zar' || !existsSync(zar)) continue;
    writeFileSync(join(cacheDir, `${part}.zmx`), extractZmxFromZar(readFileSync(zar)));
  }
}

// In a Zemax archive each file is a 0x14c-byte header (compressed size as uint32
// LE at byte 12, NUL-terminated name from byte 32) followed by LZW data:
// MSB-first codes starting at 9 bits, no clear code. The lens is "<name>.ZMX.LZW".
function extractZmxFromZar(buf) {
  const match = buf.indexOf('.ZMX.LZW', 0, 'latin1');
  if (match < 0) throw new Error('no .ZMX in archive');
  const header = buf.lastIndexOf(0, match) + 1 - 32;
  const size = buf.readUInt32LE(header + 12);
  return lzwDecode(buf.subarray(header + 0x14c, header + 0x14c + size));
}

function lzwDecode(data) {
  const dictionary = Array.from({ length: 256 }, (_, i) => Buffer.from([i]));
  const out = [];
  let bits = 9;
  let position = 0;
  let previous = null;
  while (position + bits <= data.length * 8) {
    let code = 0;
    for (let i = 0; i < bits; i++) {
      const bit = position + i;
      code = (code << 1) | ((data[bit >> 3] >> (7 - (bit & 7))) & 1);
    }
    position += bits;
    let entry;
    if (code < dictionary.length) entry = dictionary[code];
    else if (code === dictionary.length && previous) entry = Buffer.concat([previous, previous.subarray(0, 1)]);
    else throw new Error(`corrupt LZW stream (code ${code}, dictionary ${dictionary.length})`);
    out.push(entry);
    if (previous) dictionary.push(Buffer.concat([previous, entry.subarray(0, 1)]));
    previous = entry;
    if (dictionary.length >= 1 << bits) {
      if (bits === 12) throw new Error('LZW dictionary overflow: archive layout not understood');
      bits++;
    }
  }
  return Buffer.concat(out);
}

function readZipEntry(buf, wanted) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    if (name === wanted) {
      const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
      const raw = buf.subarray(dataStart, dataStart + compressedSize);
      return (method === 8 ? inflateRawSync(raw) : raw).toString('utf8');
    }
    p += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function readFocalShiftXlsx(buf) {
  const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const strings = [...(readZipEntry(buf, 'xl/sharedStrings.xml') ?? '').matchAll(/<si>(.*?)<\/si>/gs)].map((m) =>
    decode([...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((t) => t[1]).join('')),
  );
  const cells = new Map();
  for (const m of readZipEntry(buf, 'xl/worksheets/sheet1.xml').matchAll(/<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
    const value = /<v>(.*?)<\/v>/s.exec(m[4] ?? '')?.[1];
    if (value === undefined) continue;
    cells.set(`${m[1]}${m[2]}`, /t="s"/.test(m[3]) ? strings[Number(value)] : Number(value));
  }
  const header = (pattern) => [...cells].find(([, v]) => typeof v === 'string' && pattern.test(v));
  const wavelengthHeader = header(/^wavelength \(nm\)$/i);
  const shiftHeader = header(/^focal (length )?shift \((mm|µm|um)\)$/i);
  if (!wavelengthHeader || !shiftHeader) throw new Error('focal-shift sheet: headers not found');
  const column = (ref) => /^[A-Z]+/.exec(ref)[0];
  const scale = /\(mm\)/i.test(shiftHeader[1]) ? 1000 : 1;
  const rows = [];
  for (let r = Number(/\d+/.exec(wavelengthHeader[0])[0]) + 1; ; r++) {
    const wavelengthNm = cells.get(`${column(wavelengthHeader[0])}${r}`);
    const shift = cells.get(`${column(shiftHeader[0])}${r}`);
    if (typeof wavelengthNm !== 'number' || typeof shift !== 'number') break;
    rows.push({ wavelengthNm: round(wavelengthNm, 3), shiftUm: round(shift * scale, 3) });
  }
  return rows;
}

function round(x, digits) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function writeFocalShifts(parts) {
  rmSync(focalShiftDir, { recursive: true, force: true });
  mkdirSync(focalShiftDir, { recursive: true });
  for (const part of parts) {
    const path = join(cacheDir, `${part}_flshift.xlsx`);
    if (!existsSync(path)) continue;
    const rows = readFocalShiftXlsx(readFileSync(path));
    writeFileSync(join(focalShiftDir, `${part}.json`), JSON.stringify(rows) + '\n');
  }
}

function writeDrawingFocalLengths(parts) {
  const focalLengths = {};
  for (const part of parts) {
    const text = execFileSync('pdftotext', ['-layout', join(cacheDir, `${part}.pdf`), '-'], { encoding: 'utf8' });
    const match = /FOCAL LENGTH:\s*(?:f\s*=\s*)?([\d.]+)\s*mm/.exec(text);
    if (!match) throw new Error(`${part}: no focal length on the drawing`);
    focalLengths[part] = { focalLengthMm: Number(match[1]), sourceRef: manifest[part].drawingUrl };
  }
  writeFileSync(drawingFocalLengthsPath, JSON.stringify(focalLengths, null, 1) + '\n');
}

function writeLenses() {
  const knownGlasses = new Set(Object.values(glasses).map((g) => g.name.toLowerCase()));
  const lenses = [];
  const missing = [];
  for (const part of PARTS) {
    if (part in EXCLUDED) {
      console.warn(`${part} left out: ${EXCLUDED[part]}`);
      continue;
    }
    const entry = manifest[part];
    const zmxPath = join(cacheDir, `${part}.zmx`);
    if (!entry?.zemaxUrl || !existsSync(zmxPath)) {
      missing.push(part);
      continue;
    }
    const lens = parseZmx(decodeZmx(readFileSync(zmxPath)), 'Thorlabs');
    if (lens.partNumber !== part) console.warn(`${part}: file NAME says ${lens.partNumber}`);
    for (const s of lens.surfaces) {
      if (s.glassAfter && !knownGlasses.has(s.glassAfter.toLowerCase())) {
        throw new Error(`${part}: glass ${s.glassAfter} is not in glasses.json; add it there or to EXCLUDED`);
      }
    }
    lenses.push({ ...lens, partNumber: part, sourceRef: entry.zemaxUrl });
  }
  writeFileSync(lensesPath, JSON.stringify(lenses, null, 1) + '\n');
  console.log(`Wrote ${lenses.length} lenses to ${lensesPath}`);
  if (missing.length) console.warn(`No Zemax file for: ${missing.join(', ')}`);
  return lenses.map((l) => l.partNumber);
}
