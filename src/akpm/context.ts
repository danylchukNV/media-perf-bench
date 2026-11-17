// Компонент 1. Модуль збору контексту: мережа, пристрій, поведінка користувача.

interface NetInfo { downlink?: number; rtt?: number; saveData?: boolean; effectiveType?: string }

function netInfo(): NetInfo | undefined {
  return (navigator as unknown as { connection?: NetInfo }).connection;
}

/** Оцінка пропускної здатності (байт/с) і RTT з експоненційним згладжуванням. */
export class NetworkEstimator {
  bps: number;
  rttMs: number;
  samples = 0;
  private readonly alpha = 0.3;

  constructor(initial?: { bps?: number; rttMs?: number }) {
    const ni = netInfo();
    const fromNi = ni?.downlink ? (ni.downlink * 1e6) / 8 * 0.8 : undefined;
    this.bps = initial?.bps ?? fromNi ?? 150_000; // за замовчуванням ~1.2 Мбіт/с — обережно
    this.rttMs = initial?.rttMs ?? ni?.rtt ?? 150;
  }

  /**
   * Додати вимір. bytes — розмір тіла відповіді, durationMs — час передавання тіла,
   * concurrency — скільки передавань ішло паралельно (канал ділиться між ними).
   */
  addSample(bytes: number, durationMs: number, concurrency = 1): void {
    if (bytes < 12_000 || durationMs <= 5) return; // малі відповіді дають шумну оцінку
    const sample = (bytes / (durationMs / 1000)) * Math.max(1, concurrency);
    const a = this.samples === 0 ? 0.6 : this.alpha;
    this.bps = this.bps * (1 - a) + sample * a;
    this.samples++;
  }

  addRtt(ms: number): void {
    if (ms <= 0 || !isFinite(ms)) return;
    this.rttMs = this.rttMs * 0.7 + ms * 0.3;
  }

  /** Підхоплюємо виміри з ресурсів, завантажених не бібліотекою (HTML, CSS, головне зображення). */
  observeResourceTiming(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceResourceTiming[]) {
          if (e.initiatorType === 'fetch') continue; // власні запити бібліотеки враховуються окремо
          if (e.responseStart > 0 && e.requestStart > 0) this.addRtt(e.responseStart - e.requestStart);
          if (e.encodedBodySize > 0 && e.responseEnd > e.responseStart) {
            this.addSample(e.encodedBodySize, e.responseEnd - e.responseStart, 1);
          }
        }
      });
      po.observe({ type: 'resource', buffered: true });
    } catch { /* старі браузери */ }
  }

  get kbps(): number { return (this.bps * 8) / 1000; }
}

export interface DeviceInfo {
  dpr: number;
  vw: number;
  vh: number;
  deviceMemory?: number;
  cores?: number;
  saveData: boolean;
}

export function readDevice(): DeviceInfo {
  return {
    dpr: window.devicePixelRatio || 1,
    vw: window.innerWidth,
    vh: window.innerHeight,
    deviceMemory: (navigator as unknown as { deviceMemory?: number }).deviceMemory,
    cores: navigator.hardwareConcurrency,
    saveData: !!netInfo()?.saveData,
  };
}

/** Швидкість (px/мс, «+» — вниз) та напрям прокручування зі згладжуванням. */
export class ScrollTracker {
  y = window.scrollY;
  v = 0;
  private lastT = performance.now();

  update(): void {
    const now = performance.now();
    const y = window.scrollY;
    const dt = now - this.lastT;
    if (dt <= 0) return;
    const inst = (y - this.y) / dt;
    // швидке наростання, повільніше згасання — щоб короткі паузи між кроками прокручування не обнуляли прогноз
    const a = Math.abs(inst) > Math.abs(this.v) ? 0.6 : 0.25;
    this.v = this.v * (1 - a) + inst * a;
    if (Math.abs(this.v) < 0.005) this.v = 0;
    this.y = y;
    this.lastT = now;
  }
}
