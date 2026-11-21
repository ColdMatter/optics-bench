export interface GlassData {
  name: string; // catalogue name, e.g. "N-BK7"
  formula: 1 | 2 | 3 | 'constant'; // refractiveindex.info formula number
  coefficients: number[]; // as in the YAML, wavelengths in µm
  rangeUm: [number, number];
}

export type GlassLookup = (name: string) => GlassData | undefined;
