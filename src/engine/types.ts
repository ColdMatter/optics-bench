export interface GlassData {
  name: string; // catalogue name, e.g. "N-BK7"
  formula: 1 | 2 | 3 | 'constant'; // refractiveindex.info formula number
  coefficients: number[]; // as in the YAML, wavelengths in µm
  rangeUm: [number, number];
}

export type GlassLookup = (name: string) => GlassData | undefined;

export interface Ray {
  z: number;
  y: number;
  dz: number; // (dz, dy) is a unit vector; dz > 0 in normal use
  dy: number;
  wavelengthNm: number;
}

export interface SurfaceShape {
  curvature: number; // 1/mm; positive = centre of curvature at +z of the vertex
  conic: number;
  asphere: number[]; // [A4, A6, …]: sag += Σ A(2k+2) y^(2k+2)
  semiDiameterMm: number;
}

export type Id = string;
interface SourceBase {
  id: Id;
  label: string;
  z: number;
  y: number;
  wavelengthsNm: number[];
}
export interface PointSource extends SourceBase {
  kind: 'point';
  coneHalfAngleDeg: number | 'fill';
  rayCount: number;
}
export interface CollimatedSource extends SourceBase {
  kind: 'collimated';
  widthMm: number;
  angleDeg: number;
  rayCount: number;
}
export interface GaussianSource extends SourceBase {
  kind: 'gaussian';
  angleDeg: number;
  waistRadiusMm: number;
  waistZ: number;
  m2: number;
}
export type Source = PointSource | CollimatedSource | GaussianSource;

export interface PrescriptionSurface extends SurfaceShape {
  thicknessToNextMm: number;
  glassAfter: string | null; // null = air; last surface has thickness 0, glass null
}
export interface LensPrescription {
  partNumber: string;
  vendor: string;
  source: 'zmx' | 'drawing';
  sourceRef: string;
  surfaces: PrescriptionSurface[];
}

interface Placed {
  id: Id;
  label: string;
  z: number; // first vertex (lens) or plane
  decentreMm: number;
  tiltDeg: number;
}
export interface CatalogueLens extends Placed {
  kind: 'lens';
  prescription: LensPrescription;
  flipped: boolean;
}
export interface IdealLens extends Placed {
  kind: 'ideal';
  focalLengthMm: number;
  apertureMm: number; // diameter
}
export type PhaseTerm =
  | { kind: 'fresnel'; focalLengthMm: number } // at design wavelength
  | { kind: 'blaze'; angleDeg: number } // deflection at design wavelength
  | { kind: 'polynomial'; coefficientsRad: number[] } // Σ a_k (y/R)^k, k = 1…, R = aperture/2
  | { kind: 'table'; yMm: number[]; phaseRad: number[] };
export interface Slm extends Placed {
  kind: 'slm';
  apertureMm: number;
  pixelPitchUm: number;
  designWavelengthNm: number;
  phase: PhaseTerm[];
}
export interface Aperture {
  kind: 'aperture';
  id: Id;
  label: string;
  z: number;
  decentreMm: number;
  diameterMm: number;
}
export interface Screen {
  kind: 'screen';
  id: Id;
  label: string;
  z: number;
}
export type Optic = CatalogueLens | IdealLens | Slm | Aperture | Screen;

export interface Setup {
  version: 1;
  sources: Source[];
  optics: Optic[];
  glasses: Record<string, GlassData>;
}

export interface RayPath {
  wavelengthNm: number;
  points: [number, number][];
  blockedBy: Id | null;
  final: Ray | null; // ray leaving the last optic it met; null if blocked
}
export type TraceWarning =
  | { kind: 'overlap'; ids: [Id, Id] }
  | { kind: 'unknown-glass'; opticId: Id; glass: string }
  | { kind: 'glass-extrapolated'; glass: string; wavelengthNm: number }
  | { kind: 'slm-pitch-limit'; opticId: Id };
export interface SourceTrace {
  sourceId: Id;
  byWavelength: { wavelengthNm: number; rays: RayPath[] }[];
}
export interface SetupTrace {
  sources: SourceTrace[];
  warnings: TraceWarning[];
  endZ: number;
}
