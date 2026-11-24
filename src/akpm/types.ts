export type ImageFormat = 'avif' | 'webp' | 'jpeg';

export interface ImageEntry {
  w: number;
  h: number;
  color: string;
  lqip: string;
  origBytes: number;
  /** формат → (ширина → розмір файлу в байтах) */
  variants: Record<ImageFormat, Record<string, number>>;
}

export interface VideoLevel { height: number; width: number; bitrate: number }

export interface VideoEntry {
  w: number;
  h: number;
  master: string;
  mp4: string;
  poster: string;
  posterBytes: number;
  mp4Bytes: number;
  levels: VideoLevel[];
}

export interface Manifest {
  widths: number[];
  images: Record<string, ImageEntry>;
  videos: Record<string, VideoEntry>;
  probe: { avif?: string; webp?: string };
}

/** Вагові коефіцієнти моделі пріоритету P = wv·V + ws·S + wt·T − wc·C */
export interface Weights { v: number; s: number; t: number; c: number }

export interface Options {
  manifest: Manifest;
  /** Префікс URL медіа, за замовчуванням '' (той самий origin) */
  baseUrl?: string;
  weights?: Partial<Weights>;
  /** Горизонт прогнозування, мс (початкове значення; далі коригується зворотним зв'язком) */
  horizonMs?: number;
  /** Бюджет часу на завантаження вже видимого елемента, мс */
  visibleBudgetMs?: number;
  /** Обмеження DPR при виборі роздільності (вище 2 різниця майже непомітна) */
  dprCap?: number;
  /** Фіксована межа одночасних запитів (інакше — залежно від мережі) */
  maxConcurrent?: number;
  /** Скільки мс чекати на головне (LCP) зображення, перш ніж завантажувати інше */
  heroGateMs?: number;
  /** Звідки підвантажувати hls.js — лише коли відео наближається до вікна перегляду */
  hlsUrl?: string;
  /** Зберігати оцінки мережі та горизонту між відвідуваннями */
  persist?: boolean;
  /** Інтервал перерахунку пріоритетів, мс */
  tickMs?: number;
  debug?: boolean;

  // ---------- Абляційний аналіз ----------
  /**
   * Вимкнути окремі компоненти методу (лише для експерименту):
   *  prediction — без прогнозу за прокручуванням (T = 0, τ = ∞ для невидимих);
   *  quality    — без вибору якості за дедлайном (завжди ідеальна роздільність);
   *  abort      — без скасування запитів до елементів, що вийшли із зони інтересу;
   *  feedback   — без зворотного зв'язку (горизонт прогнозу не коригується).
   */
  disable?: Component[];

  // ---------- Параметри версії В2 (за замовчуванням — поведінка В) ----------
  /** Частка оцінки пропускної здатності для попереднього завантаження невидимих елементів (0 — без обмеження) */
  prefetchShare?: number;
  /** Поріг імовірності T, з якого невидимий елемент можна завантажувати наперед (В: 0,05) */
  prefetchT?: number;
  /** Відстань до вікна (у висотах екрана), ближче якої елемент завантажується без прогнозу (В: 1,5) */
  prefetchDistVh?: number;
  /** Не вважати стрибок прокручування (якір, scrollTo) швидкістю — інакше прогноз «бачить» шалений рух */
  jumpGuard?: boolean;
  /** Оцінка пропускної здатності: ewma — за окремими запитами × паралельність (В); aggregate — сумарні байти за час зайнятості каналу */
  throughput?: 'ewma' | 'aggregate';
  /** Поки головне зображення не відображено, не запускати жодних інших запитів зображень (В: дозволено один видимий) */
  heroGateStrict?: boolean;
  /** Покращувати якість, лише якщо нова ширина більша щонайменше в стільки разів (В: будь-яка більша) */
  upgradeMinGain?: number;
  /** Мітка варіанта для статистики (наприклад, 'c2', 'c-no-pred') */
  variant?: string;
}

export type Component = 'prediction' | 'quality' | 'abort' | 'feedback';

export interface Geometry { top: number; bottom: number; height: number }

export interface PriorityResult {
  P: number;
  V: number;
  T: number;
  C: number;
  /** прогнозований час до появи у вікні перегляду, мс (0 — вже видимий, Infinity — не наближається) */
  tauMs: number;
  /** відстань до вікна перегляду, px (0 — видимий) */
  dist: number;
  visible: boolean;
  /** частка висоти елемента у вікні перегляду */
  visibleRatio: number;
}
