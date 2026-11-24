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
  /** В2: завершені передавання за останні WINDOW_MS — для агрегованої оцінки */
  private transfers: { t0: number; t1: number; bytes: number }[] = [];
  private static readonly WINDOW_MS = 4000;

  constructor(initial?: { bps?: number; rttMs?: number }, readonly mode: 'ewma' | 'aggregate' = 'ewma') {
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

  /**
   * В2. Агрегована оцінка: сума байтів завершених передавань за вікно, поділена на час, коли канал
   * був зайнятий хоча б одним передаванням (об'єднання інтервалів). На відміну від addSample,
   * не множить швидкість окремого запиту на паралельність, яка за час запиту могла змінитися.
   */
  addTransfer(bytes: number, t0: number, t1: number): void {
    if (this.mode !== 'aggregate') { this.addSample(bytes, t1 - t0, 1); return; }
    if (!(t1 > t0) || bytes <= 0) return;
    this.transfers.push({ t0, t1, bytes });
    const from = t1 - NetworkEstimator.WINDOW_MS;
    this.transfers = this.transfers.filter((x) => x.t1 >= from);
    const iv = this.transfers.map((x) => [Math.max(x.t0, from), x.t1]).sort((a, b) => a[0] - b[0]);
    let busy = 0;
    let [s, e] = iv[0];
    for (const [a, b] of iv.slice(1)) {
      if (a > e) { busy += e - s; s = a; e = b; } else e = Math.max(e, b);
    }
    busy += e - s;
    const total = this.transfers.reduce((acc, x) => acc + x.bytes, 0);
    if (total < 24_000 || busy < 50) return; // замало даних для надійної оцінки
    const sample = total / (busy / 1000);
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
            if (this.mode === 'aggregate') this.addTransfer(e.encodedBodySize, e.responseStart, e.responseEnd);
            else this.addSample(e.encodedBodySize, e.responseEnd - e.responseStart, 1);
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
  jumps = 0;
  private lastT = performance.now();

  /** jumpGuard (В2): зсув більше ніж на 1,5 екрана за один крок — це стрибок (якір, scrollTo), а не рух */
  constructor(private readonly jumpGuard = false) {}

  update(): void {
    const now = performance.now();
    const y = window.scrollY;
    const dt = now - this.lastT;
    if (dt <= 0) return;
    if (this.jumpGuard && Math.abs(y - this.y) > 1.5 * window.innerHeight) {
      this.jumps++;
      this.v = 0;
      this.y = y;
      this.lastT = now;
      return;
    }
    const inst = (y - this.y) / dt;
    // швидке наростання, повільніше згасання — щоб короткі паузи між кроками прокручування не обнуляли прогноз
    const a = Math.abs(inst) > Math.abs(this.v) ? 0.6 : 0.25;
    this.v = this.v * (1 - a) + inst * a;
    if (Math.abs(this.v) < 0.005) this.v = 0;
    this.y = y;
    this.lastT = now;
  }
}
