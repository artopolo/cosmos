import type { StatusValue } from '../types';

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** h in [0,360), s and l in [0,1] */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return [h, s, l];
}

/** Linear mix of a hex color toward white: t=0 → white-ish, t=1 → full color. */
export function tint(hex: string, t: number): string {
  const [r, g, b] = hexToRgb(hex);
  const m = (c: number) => 255 + (c - 255) * Math.max(0, Math.min(1, t));
  return rgbToHex(m(r), m(g), m(b));
}

/** Distinct hues for layers (status keeps red/yellow/green for itself). */
export const LAYER_PALETTE = [
  '#4c7dd0', // blue
  '#9061c2', // purple
  '#e8823a', // orange
  '#2a9db4', // cyan
  '#c05299', // magenta
  '#5661c9', // indigo
  '#a07040', // brown
  '#607a94', // steel
];

/** The muted grays layers were originally seeded with (pre-palette). */
export const LEGACY_LAYER_GRAYS = new Set(['#aab4be', '#8b97a3', '#6c7a87', '#4e5d6b']);

/**
 * Background color for a layer×depth cell: the layer's hue, stronger with
 * depth. Layer-only (depth null) is the faintest wash.
 */
export function cellColor(
  layerColor: string,
  depth: number | null,
  maxDepth: number,
): string {
  if (depth == null) return tint(layerColor, 0.14);
  const t = 0.28 + 0.55 * ((depth - 1) / Math.max(1, maxDepth - 1));
  return tint(layerColor, t);
}

/**
 * Suggest a Cosmos status for a SimpleMind topic color.
 * Pale fills carry little hue information, so when the fill is washed out we
 * fall back to the stroke color (SimpleMind pastel-fill + saturated-stroke pattern).
 */
export function suggestStatus(fill: string | null, stroke: string | null): StatusValue | null {
  const pick = (hex: string | null): StatusValue | null => {
    if (!hex) return null;
    const [h, s, l] = rgbToHsl(...hexToRgb(hex));
    if (s < 0.18 || l > 0.93 || l < 0.08) return null; // effectively monochrome
    if (h < 22 || h >= 335) return 'red';
    if (h >= 22 && h < 68) return 'yellow';
    if (h >= 68 && h < 170) return 'green';
    return null; // blues/purples: no suggestion
  };
  return pick(fill) ?? pick(stroke);
}
