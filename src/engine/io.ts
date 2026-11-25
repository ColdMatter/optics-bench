import type {
  Aperture,
  GlassData,
  Id,
  LensPrescription,
  Optic,
  PhaseTerm,
  PrescriptionSurface,
  Setup,
  Source,
} from './types';

export class SetupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupFormatError';
  }
}

export function newId(): Id {
  return crypto.randomUUID().slice(0, 8);
}

export function serialiseSetup(setup: Setup): string {
  return JSON.stringify(setup, null, 2);
}

type Obj = Record<string, unknown>;

const fail = (path: string, expected: string): never => {
  throw new SetupFormatError(`${path}: ${expected}`);
};
const at = (path: string, key: string) => (path ? `${path}.${key}` : key);

function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path || 'document', 'expected an object');
  return v as Obj;
}
function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, 'expected an array');
  return v as unknown[];
}
function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'expected a finite number');
  return v as number;
}
function numWhere(v: unknown, path: string, ok: (n: number) => boolean, expected: string): number {
  const n = num(v, path);
  if (!ok(n)) fail(path, `expected ${expected}`);
  return n;
}

/** Range rules for finite numbers in a setup, shared with the UI's field validation. */
export interface NumberRule {
  ok: (n: number) => boolean;
  expected: string;
}
export const numberRules = {
  finite: { ok: () => true, expected: 'a finite number' },
  positive: { ok: (n) => n > 0, expected: 'a number greater than zero' },
  nonNegative: { ok: (n) => n >= 0, expected: 'a number of at least zero' },
  nonZero: { ok: (n) => n !== 0, expected: 'a non-zero number' },
  tilt: { ok: (n) => Math.abs(n) < 90, expected: 'an angle strictly between -90 and 90' },
  cone: { ok: (n) => n > 0 && n < 90, expected: 'an angle between 0 and 90' },
  count: { ok: (n) => Number.isInteger(n) && n >= 1, expected: 'an integer of at least 1' },
  m2: { ok: (n) => n >= 1, expected: 'a number of at least 1' },
} satisfies Record<string, NumberRule>;

const byRule = (rule: NumberRule) => (v: unknown, path: string) => numWhere(v, path, rule.ok, rule.expected);
const positive = byRule(numberRules.positive);
const nonNegative = byRule(numberRules.nonNegative);
const nonZero = byRule(numberRules.nonZero);
function str(v: unknown, path: string): string {
  if (typeof v !== 'string') fail(path, 'expected a string');
  return v as string;
}
function nonEmptyStr(v: unknown, path: string): string {
  if (typeof v !== 'string' || v === '') fail(path, 'expected a non-empty string');
  return v as string;
}
function numArr(v: unknown, path: string, minLength = 0): number[] {
  const a = arr(v, path);
  if (a.length < minLength) fail(path, `expected at least ${minLength} number${minLength === 1 ? '' : 's'}`);
  a.forEach((x, i) => num(x, `${path}[${i}]`));
  return a as number[];
}
function oneOf<T extends string>(v: unknown, path: string, options: readonly T[]): T {
  if (!options.includes(v as T)) fail(path, `expected one of ${options.map((o) => `"${o}"`).join(', ')}, got ${JSON.stringify(v)}`);
  return v as T;
}

function readPlaced(o: Obj, path: string) {
  return {
    id: nonEmptyStr(o.id, at(path, 'id')),
    label: str(o.label, at(path, 'label')),
    z: num(o.z, at(path, 'z')),
    decentreMm: num(o.decentreMm, at(path, 'decentreMm')),
    tiltDeg: byRule(numberRules.tilt)(o.tiltDeg, at(path, 'tiltDeg')),
  };
}

function readSource(v: unknown, path: string): Source {
  const o = obj(v, path);
  const kind = oneOf(o.kind, at(path, 'kind'), ['point', 'collimated', 'gaussian'] as const);
  const base = {
    id: nonEmptyStr(o.id, at(path, 'id')),
    label: str(o.label, at(path, 'label')),
    z: num(o.z, at(path, 'z')),
    y: num(o.y, at(path, 'y')),
    wavelengthsNm: numArr(o.wavelengthsNm, at(path, 'wavelengthsNm'), 1),
  };
  base.wavelengthsNm.forEach((w, i) => positive(w, `${at(path, 'wavelengthsNm')}[${i}]`));
  const rayCount = () => byRule(numberRules.count)(o.rayCount, at(path, 'rayCount'));
  if (kind === 'point') {
    const cone = o.coneHalfAngleDeg;
    const coneHalfAngleDeg =
      cone === 'fill'
        ? 'fill'
        : numWhere(cone, at(path, 'coneHalfAngleDeg'), numberRules.cone.ok, `"fill" or ${numberRules.cone.expected}`);
    return { ...base, kind, coneHalfAngleDeg, rayCount: rayCount() };
  }
  if (kind === 'collimated') {
    return {
      ...base,
      kind,
      widthMm: nonNegative(o.widthMm, at(path, 'widthMm')),
      angleDeg: num(o.angleDeg, at(path, 'angleDeg')),
      rayCount: rayCount(),
    };
  }
  return {
    ...base,
    kind,
    angleDeg: num(o.angleDeg, at(path, 'angleDeg')),
    waistRadiusMm: positive(o.waistRadiusMm, at(path, 'waistRadiusMm')),
    waistZ: num(o.waistZ, at(path, 'waistZ')),
    m2: byRule(numberRules.m2)(o.m2, at(path, 'm2')),
  };
}

function readSurface(v: unknown, path: string, last: boolean): PrescriptionSurface {
  const o = obj(v, path);
  let glassAfter: string | null;
  if (o.glassAfter === null) glassAfter = null;
  else if (last) return fail(at(path, 'glassAfter'), 'expected null on the last surface');
  else glassAfter = nonEmptyStr(o.glassAfter, at(path, 'glassAfter'));
  return {
    curvature: num(o.curvature, at(path, 'curvature')),
    conic: num(o.conic, at(path, 'conic')),
    asphere: numArr(o.asphere, at(path, 'asphere')),
    semiDiameterMm: positive(o.semiDiameterMm, at(path, 'semiDiameterMm')),
    thicknessToNextMm: nonNegative(o.thicknessToNextMm, at(path, 'thicknessToNextMm')),
    glassAfter,
  };
}

export function readPrescription(v: unknown, path: string): LensPrescription {
  const o = obj(v, path);
  const surfacesPath = at(path, 'surfaces');
  const surfaces = arr(o.surfaces, surfacesPath);
  if (surfaces.length < 2) fail(surfacesPath, 'expected at least 2 surfaces');
  const design = o.designWavelengthNm === undefined ? {} : { designWavelengthNm: positive(o.designWavelengthNm, at(path, 'designWavelengthNm')) };
  return {
    ...design,
    partNumber: nonEmptyStr(o.partNumber, at(path, 'partNumber')),
    vendor: str(o.vendor, at(path, 'vendor')),
    source: oneOf(o.source, at(path, 'source'), ['zmx', 'drawing'] as const),
    sourceRef: str(o.sourceRef, at(path, 'sourceRef')),
    surfaces: surfaces.map((s, i) => readSurface(s, `${surfacesPath}[${i}]`, i === surfaces.length - 1)),
  };
}

function readPhaseTerm(v: unknown, path: string): PhaseTerm {
  const o = obj(v, path);
  const kind = oneOf(o.kind, at(path, 'kind'), ['fresnel', 'blaze', 'polynomial', 'table'] as const);
  if (kind === 'fresnel') return { kind, focalLengthMm: nonZero(o.focalLengthMm, at(path, 'focalLengthMm')) };
  if (kind === 'blaze') return { kind, angleDeg: num(o.angleDeg, at(path, 'angleDeg')) };
  if (kind === 'polynomial') return { kind, coefficientsRad: numArr(o.coefficientsRad, at(path, 'coefficientsRad')) };
  const yMm = numArr(o.yMm, at(path, 'yMm'), 2);
  if (yMm.some((y, i) => i > 0 && y <= (yMm[i - 1] as number))) fail(at(path, 'yMm'), 'expected strictly increasing values');
  const phaseRad = numArr(o.phaseRad, at(path, 'phaseRad'));
  if (phaseRad.length !== yMm.length) fail(at(path, 'phaseRad'), `expected ${yMm.length} values to match yMm`);
  return { kind, yMm, phaseRad };
}

function readOptic(v: unknown, path: string): Optic {
  const o = obj(v, path);
  const kind = oneOf(o.kind, at(path, 'kind'), ['lens', 'ideal', 'slm', 'aperture', 'screen'] as const);
  if (kind === 'screen') {
    return { kind, id: nonEmptyStr(o.id, at(path, 'id')), label: str(o.label, at(path, 'label')), z: num(o.z, at(path, 'z')) };
  }
  if (kind === 'aperture') {
    const aperture: Aperture = {
      kind,
      id: nonEmptyStr(o.id, at(path, 'id')),
      label: str(o.label, at(path, 'label')),
      z: num(o.z, at(path, 'z')),
      decentreMm: num(o.decentreMm, at(path, 'decentreMm')),
      diameterMm: positive(o.diameterMm, at(path, 'diameterMm')),
    };
    return aperture;
  }
  const placed = readPlaced(o, path);
  if (kind === 'lens') {
    if (typeof o.flipped !== 'boolean') fail(at(path, 'flipped'), 'expected true or false');
    return { ...placed, kind, prescription: readPrescription(o.prescription, at(path, 'prescription')), flipped: o.flipped as boolean };
  }
  if (kind === 'ideal') {
    return {
      ...placed,
      kind,
      focalLengthMm: nonZero(o.focalLengthMm, at(path, 'focalLengthMm')),
      apertureMm: positive(o.apertureMm, at(path, 'apertureMm')),
    };
  }
  const phasePath = at(path, 'phase');
  return {
    ...placed,
    kind,
    apertureMm: positive(o.apertureMm, at(path, 'apertureMm')),
    pixelPitchUm: positive(o.pixelPitchUm, at(path, 'pixelPitchUm')),
    designWavelengthNm: positive(o.designWavelengthNm, at(path, 'designWavelengthNm')),
    phase: arr(o.phase, phasePath).map((t, i) => readPhaseTerm(t, `${phasePath}[${i}]`)),
  };
}

function readGlass(v: unknown, path: string): GlassData {
  const o = obj(v, path);
  const formula = o.formula;
  if (formula !== 1 && formula !== 2 && formula !== 3 && formula !== 'constant') {
    fail(at(path, 'formula'), `expected 1, 2, 3 or "constant", got ${JSON.stringify(formula)}`);
  }
  const rangePath = at(path, 'rangeUm');
  const range = numArr(o.rangeUm, rangePath);
  if (range.length !== 2) fail(rangePath, 'expected two numbers');
  return {
    name: str(o.name, at(path, 'name')),
    formula: formula as GlassData['formula'],
    coefficients: numArr(o.coefficients, at(path, 'coefficients'), 1),
    rangeUm: [range[0] as number, range[1] as number],
  };
}

export function parseSetup(text: string): Setup {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new SetupFormatError(`not valid JSON: ${(e as Error).message}`);
  }
  const root = obj(doc, '');
  if (typeof root.version === 'number' && root.version > 1) {
    throw new SetupFormatError(`version: ${root.version} was made by a newer version of this simulator`);
  }
  if (root.version !== 1) fail('version', 'expected 1');
  const sources = arr(root.sources, 'sources').map((s, i) => readSource(s, `sources[${i}]`));
  const optics = arr(root.optics, 'optics').map((o, i) => readOptic(o, `optics[${i}]`));
  const glassObj = obj(root.glasses, 'glasses');
  const glasses: Record<string, GlassData> = {};
  for (const [name, g] of Object.entries(glassObj)) glasses[name] = readGlass(g, `glasses[${JSON.stringify(name)}]`);

  const seen = new Set<Id>();
  const claim = (id: Id, path: string) => {
    if (seen.has(id)) fail(path, `duplicate id "${id}"`);
    seen.add(id);
  };
  sources.forEach((s, i) => claim(s.id, `sources[${i}].id`));
  optics.forEach((o, i) => claim(o.id, `optics[${i}].id`));
  return { version: 1, sources, optics, glasses };
}
