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
