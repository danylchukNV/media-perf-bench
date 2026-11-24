// Компонент 6. Контур зворотного зв'язку.
//  • «промах» — елемент став видимим, а ще не завантажений → горизонт прогнозу збільшується;
//  • «марна робота» — запит скасовано до того, як елемент хоч раз побачили → горизонт зменшується;
//  • фактичні LCP / CLS збираються через PerformanceObserver;
//  • оцінки мережі й горизонту зберігаються між відвідуваннями.

const KEY = 'akpm:v1';
const MAX_AGE_MS = 30 * 60 * 1000;

export interface Persisted { bps: number; rttMs: number; horizonMs: number; ts: number }

export class Feedback {
  horizonMs: number;
  misses = 0;
  wastes = 0;
  lcpMs: number | null = null;
  cls = 0;
  private readonly minH = 1500;
  private readonly maxH = 6000;

  constructor(horizonMs: number, private readonly persist: boolean, private readonly adaptive = true) {
    this.horizonMs = horizonMs;
  }

  static load(): Persisted | null {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const p = JSON.parse(raw) as Persisted;
      return Date.now() - p.ts < MAX_AGE_MS ? p : null;
    } catch { return null; }
  }

  save(bps: number, rttMs: number): void {
    if (!this.persist) return;
    try {
      localStorage.setItem(KEY, JSON.stringify({ bps, rttMs, horizonMs: this.horizonMs, ts: Date.now() }));
    } catch { /* приватний режим тощо */ }
  }

  miss(): void {
    this.misses++;
    if (this.adaptive) this.horizonMs = Math.min(this.maxH, this.horizonMs * 1.1);
  }

  waste(): void {
    this.wastes++;
    if (this.adaptive) this.horizonMs = Math.max(this.minH, this.horizonMs * 0.95);
  }

  observeVitals(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      new PerformanceObserver((l) => {
        const e = l.getEntries();
        const last = e[e.length - 1];
        if (last) this.lcpMs = last.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((l) => {
        for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
          if (!e.hadRecentInput) this.cls += e.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch { /* немає підтримки */ }
  }
}
