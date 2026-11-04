export const FLIP_ATTRIBUTE = 'data-dusk-flip';
export const PAGE_ATTRIBUTE = 'data-dusk-page';
export const FRAME_ATTRIBUTE = 'data-dusk-frame';

// Common ad slot sizes. Ads are mostly pictures, so they keep their colors like photos do.
const AD_SIZES = [
  [300, 250], [336, 280], [728, 90], [970, 90], [970, 250], [160, 600], [300, 600], [120, 600],
  [320, 50], [320, 100], [300, 50], [468, 60], [250, 250], [200, 200], [300, 1050], [234, 60],
];
const MEDIA_PERMISSIONS = /\b(?:autoplay|encrypted-media|fullscreen|picture-in-picture)\b/i;
// Ad networks, and puzzles that ask people to pick out pictures.
const MEDIA_SOURCES = /googlesyndication|doubleclick|adsystem|adservice|adnxs|safeframe|google_ads|aswift|criteo|taboola|outbrain|recaptcha|hcaptcha|challenges\.cloudflare/i;

export interface FrameInfo {
  identity: string;
  allow: string;
  allowFullscreen: boolean;
  width: number;
  height: number;
}

/**
 * Whether a frame looks like it shows a page, such as a widget or a chart, rather than a video, a map or an ad.
 * Nothing inside another site's frame can be read, so this goes by how the frame is embedded.
 */
export function looksLikePage(frame: FrameInfo): boolean {
  if (frame.allowFullscreen || MEDIA_PERMISSIONS.test(frame.allow) || MEDIA_SOURCES.test(frame.identity)) return false;
  return !AD_SIZES.some(([width, height]) => Math.abs(frame.width - width!) <= 1 && Math.abs(frame.height - height!) <= 1);
}

/** Red, green and blue from 0 to 255, and alpha from 0 to 1. */
export type Color = readonly [number, number, number, number];
export type Tone = 'dark' | 'mid' | 'light';

export const WHITE: Color = [255, 255, 255, 1];

/** dark.css paints a root the site leaves bare in this off-white, which tells it apart from a site's own white. */
export const UNPAINTED_ROOT = 'rgb(255, 255, 254)';

// #595959 and #a0a0a0. Colors between them, such as most brand blues, read fine either way.
const DARK_LUMINANCE = 0.1;
const LIGHT_LUMINANCE = 0.35;

const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)/gi;

/** Reads the rgb() and rgba() forms Chrome uses for computed sRGB colors. */
export function parseRgb(value: string): Color | null {
  const match = RGB.exec(value.trim());
  if (!match) return null;
  const alpha = match[4] === undefined ? 1 : Number(match[4]) / (match[5] ? 100 : 1);
  return [Number(match[1]), Number(match[2]), Number(match[3]), alpha];
}

/** The colors in a computed gradient, or none when it also draws an image. */
export function gradientColors(image: string): string[] {
  if (!image.includes('gradient(') || image.includes('url(')) return [];
  return image.match(COLOR_FUNCTION) ?? [];
}

export function average(colors: Color[]): Color | null {
  if (colors.length === 0) return null;
  const mean = (index: number) => colors.reduce((sum, color) => sum + color[index]!, 0) / colors.length;
  return [mean(0), mean(1), mean(2), mean(3)];
}

/** Paints a color over a backdrop, which comes out opaque when the backdrop is. */
export function composite(top: Color, bottom: Color): Color {
  const alpha = top[3] + bottom[3] * (1 - top[3]);
  if (alpha === 0) return [0, 0, 0, 0];
  const channel = (index: number) => (top[index]! * top[3] + bottom[index]! * bottom[3] * (1 - top[3])) / alpha;
  return [channel(0), channel(1), channel(2), alpha];
}

const linear = (channel: number) => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

export const luminance = ([r, g, b]: Color) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

export function toneOf(color: Color): Tone {
  const value = luminance(color);
  if (value <= DARK_LUMINANCE) return 'dark';
  return value >= LIGHT_LUMINANCE ? 'light' : 'mid';
}

export function contrast(a: Color, b: Color): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** Counts the inverting filters in a computed filter, since each one flips the colors of everything inside. */
export function inversions(filter: string): number {
  let count = 0;
  for (const [, amount] of filter.matchAll(/invert\(\s*([\d.]+%?)\s*\)/g)) {
    const value = amount!.endsWith('%') ? parseFloat(amount!) / 100 : parseFloat(amount!);
    if (value >= 0.5) count += 1;
  }
  return count;
}
