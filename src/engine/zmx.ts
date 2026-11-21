import type { LensPrescription, PrescriptionSurface } from './types';

export class ZmxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZmxError';
  }
}

export function decodeZmx(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

const UNIT_SCALE_MM: Record<string, number> = { MM: 1, CM: 10, IN: 25.4, METER: 1000, M: 1000 };
const SUPPORTED_TYPES = new Set(['STANDARD', 'EVENASPH']);

interface RawSurface {
  index: number;
  type: string;
  curvature: number;
  thickness: number;
  glass: string | null;
  semiDiameter: number;
  conic: number;
  parms: Map<number, number>;
}

function number(value: string | undefined, keyword: string, surface: number): number {
  const x = value === 'INFINITY' ? Infinity : Number(value);
  if (value === undefined || Number.isNaN(x)) throw new ZmxError(`surface ${surface}: unreadable ${keyword} value "${value ?? ''}"`);
  return x;
}

/** Sequential lens data from a Zemax .zmx: the surfaces from the first glass to the air surface after the last. */
export function parseZmx(text: string, vendor = '', fileName?: string): LensPrescription {
  let partNumber = fileName?.replace(/\.zmx$/i, '') ?? '';
  let scale = 1;
  const surfaces: RawSurface[] = [];

  for (const line of text.split(/\r?\n/)) {
    const [keyword, ...args] = line.trim().split(/\s+/);
    const current = surfaces.at(-1);
    switch (keyword) {
      case 'MODE':
        if (args[0] !== 'SEQ') throw new ZmxError(`not a sequential file (MODE ${args[0] ?? ''})`);
        break;
      case 'NAME':
        if (args[0]) partNumber = args[0];
        break;
      case 'UNIT': {
        const unit = args[0] ?? '';
        if (!(unit in UNIT_SCALE_MM)) throw new ZmxError(`unknown lens unit "${unit}"`);
        scale = UNIT_SCALE_MM[unit]!;
        break;
      }
      case 'SURF':
        surfaces.push({
          index: Number(args[0]),
          type: 'STANDARD',
          curvature: 0,
          thickness: 0,
          glass: null,
          semiDiameter: 0,
          conic: 0,
          parms: new Map(),
        });
        break;
    }
    if (!current || keyword === 'SURF') continue;
    switch (keyword) {
      case 'TYPE':
        current.type = args[0] ?? '';
        break;
      case 'CURV':
        current.curvature = number(args[0], 'CURV', current.index);
        break;
      case 'DISZ':
        current.thickness = number(args[0], 'DISZ', current.index);
        break;
      case 'GLAS':
        current.glass = args[0] ?? null;
        break;
      case 'DIAM':
        current.semiDiameter = number(args[0], 'DIAM', current.index);
        break;
      case 'CONI':
        current.conic = number(args[0], 'CONI', current.index);
        break;
      case 'PARM':
        current.parms.set(Number(args[0]), number(args[1], 'PARM', current.index));
        break;
    }
  }

  for (const s of surfaces) {
    if (s.type === 'COORDBRK') throw new ZmxError(`surface ${s.index}: coordinate break (TYPE COORDBRK) not supported`);
    if (!SUPPORTED_TYPES.has(s.type)) throw new ZmxError(`surface ${s.index}: surface type ${s.type} not supported`);
    if (s.glass?.toUpperCase() === 'MIRROR') throw new ZmxError(`surface ${s.index}: mirror surface (GLAS MIRROR) not supported`);
    if (s.glass?.startsWith('___BLANK')) throw new ZmxError(`surface ${s.index}: model glass (index and Abbe number) not supported`);
  }

  const glassy = surfaces.flatMap((s, i) => (s.glass ? [i] : []));
  if (glassy.length === 0) throw new ZmxError('no glass surfaces: the file holds no lens');
  const first = glassy[0]!;
  const last = glassy.at(-1)! + 1;
  if (last >= surfaces.length) throw new ZmxError('the file ends inside glass');

  const lensSurfaces = surfaces.slice(first, last + 1).map((s, i, all): PrescriptionSurface => {
    const isLast = i === all.length - 1;
    if (!isLast && !Number.isFinite(s.thickness)) throw new ZmxError(`surface ${s.index}: infinite thickness inside the lens`);
    return {
      curvature: s.curvature / scale,
      conic: s.conic,
      asphere: s.type === 'EVENASPH' ? asphereTerms(s, scale) : [],
      semiDiameterMm: s.semiDiameter * scale,
      thicknessToNextMm: isLast ? 0 : s.thickness * scale,
      glassAfter: isLast ? null : s.glass,
    };
  });

  return { partNumber, vendor, source: 'zmx', sourceRef: fileName ?? '', surfaces: lensSurfaces };
}

// PARM k of an even asphere multiplies r^(2k); its length unit scales as L^(1-2k).
function asphereTerms(s: RawSurface, scale: number): number[] {
  if ((s.parms.get(1) ?? 0) !== 0) throw new ZmxError(`surface ${s.index}: even asphere r² term (PARM 1) not supported`);
  const terms: number[] = [];
  for (let k = 2; k <= 8; k++) terms.push((s.parms.get(k) ?? 0) * scale ** (1 - 2 * k));
  while (terms.length > 0 && terms.at(-1) === 0) terms.pop();
  return terms;
}
