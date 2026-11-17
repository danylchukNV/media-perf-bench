// Компонент 3. Вибір якості: q* = max { q : size(q)/B ≤ τ }   (формула 2 у тезах)

import type { ImageEntry, ImageFormat, Manifest } from './types';

export async function detectFormats(probe: Manifest['probe']): Promise<ImageFormat> {
  const test = (src?: string) =>
    new Promise<boolean>((resolve) => {
      if (!src) return resolve(false);
      const img = new Image();
      img.onload = () => resolve(img.width > 0);
      img.onerror = () => resolve(false);
      img.src = src;
    });
  if (await test(probe.avif)) return 'avif';
  if (await test(probe.webp)) return 'webp';
  return 'jpeg';
}

export interface VariantChoice {
  width: number;
  bytes: number;
  /** ширина, потрібна для повної якості на цьому екрані */
  idealWidth: number;
  degraded: boolean;
}

/**
 * Обирає найбільшу ширину, яка (1) не перевищує потрібну для екрана і
 * (2) встигає завантажитися за budgetMs за поточної оцінки мережі.
 */
export function chooseVariant(
  entry: ImageEntry,
  format: ImageFormat,
  cssWidth: number,
  dpr: number,
  budgetMs: number,
  bps: number,
  rttMs: number,
): VariantChoice {
  const table = entry.variants[format];
  const widths = Object.keys(table).map(Number).sort((a, b) => a - b);
  const need = cssWidth * dpr;
  const idealWidth = widths.find((w) => w >= need) ?? widths[widths.length - 1];
  const candidates = widths.filter((w) => w <= idealWidth);

  let chosen = candidates[0];
  for (const w of candidates) {
    const ms = rttMs + (table[w] / Math.max(1, bps)) * 1000;
    if (ms <= budgetMs) chosen = w;
  }
  return { width: chosen, bytes: table[chosen], idealWidth, degraded: chosen < idealWidth };
}

export function extFor(format: ImageFormat): string {
  return format === 'jpeg' ? 'jpg' : format;
}

/** Очікуваний розмір ідеального варіанта — для оцінки вартості C у моделі пріоритету */
export function idealBytes(entry: ImageEntry, format: ImageFormat, cssWidth: number, dpr: number): number {
  const table = entry.variants[format];
  const widths = Object.keys(table).map(Number).sort((a, b) => a - b);
  const w = widths.find((x) => x >= cssWidth * dpr) ?? widths[widths.length - 1];
  return table[w];
}
