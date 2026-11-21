const VISIBLE_MAX_NM = 750;

/** Not spectral hues, so they cannot be mistaken for a visible wavelength. */
const IR_PALETTE = ['#d6336c', '#7950f2', '#a47148', '#e64980', '#868e96', '#c2255c', '#b5838d', '#9c36b5'];
const IR_SLOTS: Record<number, number> = { 767: 7, 780: 0, 785: 5, 795: 4, 808: 6, 852: 1, 1064: 2, 1550: 3 };

const hex = (v: number) =>
  Math.round(Math.min(Math.max(v, 0), 1) * 255)
    .toString(16)
    .padStart(2, '0');

function spectrum(nm: number): string {
  const l = Math.min(Math.max(nm, 380), VISIBLE_MAX_NM);
  let r = 0;
  let g = 0;
  let b = 0;
  if (l < 440) [r, b] = [(440 - l) / 60, 1];
  else if (l < 490) [g, b] = [(l - 440) / 50, 1];
  else if (l < 510) [g, b] = [1, (510 - l) / 20];
  else if (l < 580) [r, g] = [(l - 510) / 70, 1];
  else if (l < 645) [r, g] = [1, (645 - l) / 65];
  else r = 1;
  // Fade towards the ends of the eye's response, but stay visible enough to draw with.
  const intensity = l < 420 ? 0.5 + (0.5 * (l - 380)) / 40 : l > 700 ? 0.5 + (0.5 * (VISIBLE_MAX_NM - l)) / 50 : 1;
  const tone = (c: number) => (c === 0 ? 0 : (c * intensity) ** 0.8);
  return `#${hex(tone(r))}${hex(tone(g))}${hex(tone(b))}`;
}

function infrared(nm: number): string {
  const key = Math.round(nm);
  return IR_PALETTE[IR_SLOTS[key] ?? key % IR_PALETTE.length]!;
}

export const isInfrared = (nm: number) => nm > VISIBLE_MAX_NM;

/** Drawing colour for a wavelength: the visible spectrum up to 750 nm, a fixed palette for IR. */
export function wavelengthColour(nm: number): string {
  return isInfrared(nm) ? infrared(nm) : spectrum(nm);
}
