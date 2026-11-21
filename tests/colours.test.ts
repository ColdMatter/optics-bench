import { describe, expect, test } from 'vitest';
import { wavelengthColour } from '../src/ui/colours';

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

describe('wavelength colours', () => {
  test('532 nm is green-dominant', () => {
    const [r, g, b] = rgb(wavelengthColour(532));
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  test('450 nm is blue-dominant and 650 nm red-dominant', () => {
    const blue = rgb(wavelengthColour(450));
    const red = rgb(wavelengthColour(650));
    expect(blue[2]).toBeGreaterThan(Math.max(blue[0], blue[1]));
    expect(red[0]).toBeGreaterThan(Math.max(red[1], red[2]));
  });

  test('780, 852 and 1064 nm return three different colours', () => {
    expect(new Set([780, 852, 1064].map(wavelengthColour)).size).toBe(3);
  });

  test('the same input always returns the same colour', () => {
    for (const nm of [405, 532, 780, 852, 1064, 1550, 913.4]) expect(wavelengthColour(nm)).toBe(wavelengthColour(nm));
  });

  test('every colour is a hex string', () => {
    for (const nm of [300, 380, 500, 750, 751, 2000]) expect(wavelengthColour(nm)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
