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
}

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
