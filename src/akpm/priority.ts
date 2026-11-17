// Компонент 2. Модель пріоритету: P = wv·V + ws·S + wt·T − wc·C   (формула 1 у тезах)

import type { Geometry, PriorityResult, Weights } from './types';

export const DEFAULT_WEIGHTS: Weights = { v: 0.4, s: 0.3, t: 0.3, c: 0.2 };

export interface PriorityInput {
  geom: Geometry;
  scrollY: number;
  vh: number;
  /** швидкість прокручування, px/мс («+» — вниз) */
  velocity: number;
  /** семантична важливість 0..1 */
  importance: number;
  /** очікуваний розмір ресурсу, байт */
  bytes: number;
  bps: number;
  rttMs: number;
  horizonMs: number;
  weights: Weights;
}

export function computePriority(i: PriorityInput): PriorityResult {
  const viewTop = i.scrollY;
  const viewBottom = i.scrollY + i.vh;
  const { top, bottom, height } = i.geom;

  const overlap = Math.max(0, Math.min(bottom, viewBottom) - Math.max(top, viewTop));
  const visible = overlap > 0;
  const visibleRatio = height > 0 ? overlap / height : 0;

  let dist = 0;
  let dir = 0; // +1 — елемент нижче вікна, −1 — вище
  if (!visible) {
    if (top >= viewBottom) { dist = top - viewBottom; dir = 1; }
    else { dist = viewTop - bottom; dir = -1; }
  }

  // V — нормована близькість до вікна перегляду (0 на відстані ≥ 3 висот екрана)
  const V = visible ? 1 : Math.max(0, 1 - dist / (3 * i.vh));

  // T — імовірність потрапляння у вікно протягом горизонту, з урахуванням швидкості та напряму прокручування
  let tauMs = Infinity;
  let T = 0;
  if (visible) { tauMs = 0; T = 1; }
  else {
    const toward = i.velocity * dir; // > 0 — рух у бік елемента
    if (toward > 0.02) {
      tauMs = dist / toward;
      T = Math.exp(-tauMs / i.horizonMs);
    }
  }

  // C — нормована вартість: час завантаження відносно горизонту
  const loadMs = i.rttMs + (i.bytes / Math.max(1, i.bps)) * 1000;
  const C = Math.min(1, loadMs / i.horizonMs);

  const w = i.weights;
  const P = w.v * V + w.s * i.importance + w.t * T - w.c * C;
  return { P, V, T, C, tauMs, dist, visible, visibleRatio };
}
