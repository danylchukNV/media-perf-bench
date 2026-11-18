// Керування відео (частина компонентів 3–4): вибір стартового рівня HLS за оцінкою мережі,
// підключення потоку лише при наближенні до вікна, пауза та зупинка завантаження поза екраном.

import type { Geometry, PriorityResult, VideoEntry } from './types';

interface HlsInstance {
  loadSource(url: string): void;
  attachMedia(el: HTMLMediaElement): void;
  startLoad(pos?: number): void;
  stopLoad(): void;
  destroy(): void;
  on(event: string, cb: () => void): void;
  autoLevelCapping: number;
}
const MANIFEST_PARSED = 'hlsManifestParsed'; // Hls.Events.MANIFEST_PARSED
interface HlsCtor {
  new (cfg: Record<string, unknown>): HlsInstance;
  isSupported(): boolean;
}

function getHls(): HlsCtor | undefined {
  return (window as unknown as { Hls?: HlsCtor }).Hls;
}

let hlsLoading: Promise<HlsCtor | undefined> | undefined;
/** hls.js (~600 КБ) завантажується лише тоді, коли воно справді потрібне */
function loadHls(url: string): Promise<HlsCtor | undefined> {
  if (getHls()) return Promise.resolve(getHls());
  if (!url || typeof MediaSource === 'undefined') return Promise.resolve(undefined);
  hlsLoading ??= new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => resolve(getHls());
    s.onerror = () => resolve(undefined);
    document.head.appendChild(s);
  });
  return hlsLoading;
}

export type VideoState = 'idle' | 'attaching' | 'loading' | 'stopped';

export class ManagedVideo {
  geom: Geometry = { top: 0, bottom: 0, height: 0 };
  state: VideoState = 'idle';
  private hls?: HlsInstance;
  private posterSet = false;

  constructor(
    readonly el: HTMLVideoElement,
    readonly id: string,
    readonly entry: VideoEntry,
    private readonly base: string,
    private readonly hlsUrl = '',
  ) {
    el.muted = true;
    el.playsInline = true;
    el.loop = true;
    el.preload = 'none';
  }

  /** Скільки слотів мережі займає відео (для планувальника) */
  get busy(): boolean { return this.state === 'loading' || this.state === 'attaching'; }

  tick(p: PriorityResult, vh: number, bps: number): void {
    // постер — лише коли елемент поруч
    if (!this.posterSet && p.dist < 1.5 * vh) {
      this.el.poster = this.base + this.entry.poster;
      this.posterSet = true;
    }
    const near = p.visible || p.tauMs < 2500 || p.dist < 0.5 * vh;
    if (near && this.state === 'idle') void this.attach(bps);
    else if (near && this.state === 'stopped') { this.hls?.startLoad(-1); this.state = 'loading'; }
    else if (!near && this.state === 'loading' && p.dist > 2 * vh) { this.hls?.stopLoad(); this.state = 'stopped'; }

    // Розмір плеєра може змінитися (поворот екрана, зміна ширини вікна)
    if (this.hls) this.applyCap(this.sizeCap());

    if (p.visibleRatio >= 0.5) {
      if (this.el.paused && (this.state === 'loading' || this.state === 'stopped')) this.el.play().catch(() => {});
    } else if (!this.el.paused) {
      this.el.pause();
    }
  }

  private async attach(bps: number): Promise<void> {
    this.state = 'attaching';
    // hls.js — завжди, коли є MSE: інакше в Chrome ≥ 142 (вбудований HLS) метод втратив би
    // керування рівнем і зупинкою завантаження, а Б при цьому йшла б через hls.js.
    // Вбудований HLS лишається запасним варіантом для браузерів без MSE (Safari на iPhone).
    await loadHls(this.hlsUrl);
    const levels = this.entry.levels;
    const bits = bps * 8 * 0.7; // запас 30%
    let start = 0;
    levels.forEach((l, i) => { if (l.bitrate <= bits) start = i; });
    // Не вище за розмір плеєра (як для зображень)
    const cap = this.sizeCap();
    if (cap >= 0) start = Math.min(start, cap);
    const Hls = getHls();
    const url = this.base + this.entry.master;
    if (Hls && Hls.isSupported()) {
      this.hls = new Hls({
        startLevel: start,
        capLevelToPlayerSize: true,
        maxBufferLength: 8,
        maxMaxBufferLength: 16,
        abrEwmaDefaultEstimate: Math.max(200_000, bps * 8),
        testBandwidth: false,
      });
      // Стелю задаємо самі: власне capLevelToPlayerSize у hls.js покладається на ResizeObserver
      // і не завжди отримує розмір плеєра, тоді ABR піднімає рівень до 1080p у малий плеєр.
      // Розбір маніфесту скидає стелю, тому ставимо її саме після нього.
      this.hls.on(MANIFEST_PARSED, () => this.applyCap(this.sizeCap()));
      this.hls.loadSource(url);
      this.hls.attachMedia(this.el);
    } else if (this.el.canPlayType('application/vnd.apple.mpegurl')) {
      this.el.src = url; // браузер без MSE — вбудований HLS
    } else {
      this.el.src = this.base + this.entry.mp4;
    }
    this.state = 'loading';
  }

  /** Індекс найменшого рівня, що покриває фізичну ширину плеєра; −1, якщо розмір невідомий */
  private sizeCap(): number {
    const physW = this.el.clientWidth * (window.devicePixelRatio || 1);
    if (!(physW > 0)) return -1;
    const levels = this.entry.levels;
    const i = levels.findIndex((l) => l.width >= physW);
    return i < 0 ? levels.length - 1 : i;
  }

  private applyCap(cap: number): void {
    if (!this.hls || cap < 0 || this.hls.autoLevelCapping === cap) return;
    this.hls.autoLevelCapping = cap;
  }
}
