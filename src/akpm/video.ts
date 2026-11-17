// Керування відео (частина компонентів 3–4): вибір стартового рівня HLS за оцінкою мережі,
// підключення потоку лише при наближенні до вікна, пауза та зупинка завантаження поза екраном.

import type { Geometry, PriorityResult, VideoEntry } from './types';

interface HlsInstance {
  loadSource(url: string): void;
  attachMedia(el: HTMLMediaElement): void;
  startLoad(pos?: number): void;
  stopLoad(): void;
  destroy(): void;
}
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

    if (p.visibleRatio >= 0.5) {
      if (this.el.paused && (this.state === 'loading' || this.state === 'stopped')) this.el.play().catch(() => {});
    } else if (!this.el.paused) {
      this.el.pause();
    }
  }

  private async attach(bps: number): Promise<void> {
    this.state = 'attaching';
    const native = this.el.canPlayType('application/vnd.apple.mpegurl') !== '';
    if (!native) await loadHls(this.hlsUrl);
    const levels = this.entry.levels;
    const bits = bps * 8 * 0.7; // запас 30%
    let start = 0;
    levels.forEach((l, i) => { if (l.bitrate <= bits) start = i; });
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
      this.hls.loadSource(url);
      this.hls.attachMedia(this.el);
    } else if (this.el.canPlayType('application/vnd.apple.mpegurl')) {
      this.el.src = url; // Safari — нативний HLS
    } else {
      this.el.src = this.base + this.entry.mp4;
    }
    this.state = 'loading';
  }
}
