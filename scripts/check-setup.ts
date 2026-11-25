// Usage: npm run check-setup -- <setup.json> [more.json …]
//
// Validates each setup as the app's Open… does and prints what the readouts panel would:
// warnings, the focus of every point and collimated source per wavelength, Gaussian waists,
// and the spot and magnification on every screen. Exits non-zero if any file fails to parse.
import { readFileSync } from 'node:fs';
import { focusPerWavelength, screenMagnifications, screenStats, type Magnification } from '../src/engine/focus';
import { radiusAt, traceGaussians } from '../src/engine/gaussian';
import { parseSetup } from '../src/engine/io';
import { traceSetup } from '../src/engine/trace';

const mm = (v: number | null) => (v === null ? '—' : `${v.toFixed(3)} mm`);
const um = (v: number | null) => (v === null ? '—' : `${(v * 1e3).toFixed(2)} µm`);
const mag = (m: Magnification | undefined, spotRmsMm?: number | null) => {
  if (!m) return '';
  if (m.value === null) return `, M — (${m.reason})`;
  const objectSide = spotRmsMm != null && Math.abs(m.value) > 1e-9 ? `, object-side RMS ${um(spotRmsMm / Math.abs(m.value))}` : '';
  return `, M ${m.value.toPrecision(6)}${objectSide}`;
};

let failed = false;
for (const file of process.argv.slice(2)) {
  console.log(`== ${file}`);
  let setup;
  try {
    setup = parseSetup(readFileSync(file, 'utf8'));
  } catch (e) {
    console.log(`  cannot open: ${(e as Error).message}`);
    failed = true;
    continue;
  }
  const trace = traceSetup(setup);
  for (const w of trace.warnings) console.log(`  warning: ${JSON.stringify(w)}`);
  const screens = setup.optics.filter((o) => o.kind === 'screen');
  const gaussians = traceGaussians(setup, trace.endZ);
  for (const source of setup.sources) {
    console.log(`  ${source.label} (${source.kind}, id ${source.id})`);
    const magnifications = screenMagnifications(setup, source.id);
    const magAt = (screenId: string, nm: number, spotRmsMm?: number | null) =>
      mag(magnifications.get(screenId)?.find((m) => m.wavelengthNm === nm), spotRmsMm);
    if (source.kind === 'gaussian') {
      for (const screen of screens) {
        if (screen.z < source.z) continue;
        for (const g of gaussians.filter((b) => b.sourceId === source.id)) {
          console.log(`    ${screen.label} @ z ${screen.z}, ${g.wavelengthNm} nm: w ${um(radiusAt(g, screen.z))}${magAt(screen.id, g.wavelengthNm)}`);
        }
      }
    }
    if (source.kind !== 'gaussian') {
      for (const f of focusPerWavelength(setup, source.id)) {
        const approx = f.approximate ? ' approx.' : '';
        console.log(
          `    ${f.wavelengthNm} nm: ${f.status}; paraxial z ${mm(f.paraxialZ)}, best z ${mm(f.bestZ)}${approx}, RMS at best ${um(f.rmsAtBestMm)}`,
        );
      }
      const sourceTrace = trace.sources.find((s) => s.sourceId === source.id)!;
      for (const screen of screens) {
        for (const spot of screenStats(sourceTrace, screen.id)) {
          console.log(
            `    ${screen.label} @ z ${screen.z}, ${spot.wavelengthNm} nm: ${spot.heightsMm.length} rays, centroid ${mm(spot.centroidMm)}, RMS ${um(spot.rmsMm)}${magAt(screen.id, spot.wavelengthNm, source.kind === 'point' ? spot.rmsMm : null)}`,
          );
        }
      }
    }
  }
  for (const g of gaussians) {
    const label = setup.sources.find((s) => s.id === g.sourceId)?.label;
    for (const waist of g.waists) {
      const where = waist.collimated ? 'collimated' : `z ${mm(waist.z)}`;
      console.log(`  ${label} ${g.wavelengthNm} nm waist after ${waist.afterOpticId ?? 'source'}: w0 ${um(waist.radiusMm)}, ${where}`);
    }
    for (const w of g.warnings) console.log(`  ${label} ${g.wavelengthNm} nm Gaussian unreliable: ${w.kind} at ${w.opticId}`);
  }
}
if (failed) process.exit(1);
