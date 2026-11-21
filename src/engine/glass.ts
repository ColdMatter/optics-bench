import bundled from '../data/glasses.json';
import type { GlassData, GlassLookup } from './types';

export function refractiveIndex(glass: GlassData, wavelengthNm: number): number {
  const c = glass.coefficients;
  if (glass.formula === 'constant') return c[0] ?? NaN;
  const l2 = (wavelengthNm / 1000) ** 2;
  const lambdaUm = wavelengthNm / 1000;
  let n2 = 0;
  if (glass.formula === 3) {
    n2 = c[0] ?? 0;
    for (let i = 1; i + 1 < c.length; i += 2) n2 += (c[i] ?? 0) * lambdaUm ** (c[i + 1] ?? 0);
    return Math.sqrt(n2);
  }
  n2 = 1 + (c[0] ?? 0);
  for (let i = 1; i + 1 < c.length; i += 2) {
    const b = c[i] ?? 0;
    const pole = c[i + 1] ?? 0;
    n2 += (b * l2) / (l2 - (glass.formula === 1 ? pole * pole : pole));
  }
  return Math.sqrt(n2);
}

export function inRange(glass: GlassData, wavelengthNm: number): boolean {
  const um = wavelengthNm / 1000;
  return um >= glass.rangeUm[0] && um <= glass.rangeUm[1];
}

export function makeGlassLookup(extra: Record<string, GlassData> = {}): GlassLookup {
  const byLowerName = new Map<string, GlassData>();
  for (const glass of Object.values(bundled as unknown as Record<string, GlassData>)) {
    byLowerName.set(glass.name.toLowerCase(), glass);
  }
  for (const glass of Object.values(extra)) byLowerName.set(glass.name.toLowerCase(), glass);
  return (name) => byLowerName.get(name.toLowerCase());
}
