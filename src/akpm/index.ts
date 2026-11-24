// Метод АКПМ — клієнтська бібліотека.
// Компонент 4 (планувальник) і 5 (оптимізація рендерингу) реалізовані тут,
// решта — в окремих модулях: context (1), priority (2), quality (3), feedback (6), video.
//
// Використання на сторінці:
//   <img class="akpm" data-akpm-id="img-007" data-akpm-importance="0.3" width="2400" height="1600" src="LQIP">
//   <video data-akpm-video="vid-001" width="1920" height="1080"></video>
//   <script src="/vendor/hls.min.js"></script><script src="/akpm.js"></script>
//   <script>AKPM.init({ manifest })</script>

import { NetworkEstimator, ScrollTracker, readDevice, type DeviceInfo } from './context';
import { computePriority, DEFAULT_WEIGHTS } from './priority';
import { chooseVariant, detectFormats, extFor, idealBytes } from './quality';
import { Feedback } from './feedback';
import { ManagedVideo } from './video';
import type { Component, Geometry, ImageEntry, ImageFormat, Options, PriorityResult, Weights } from './types';

type ImgState = 'idle' | 'loading' | 'loaded';

interface ManagedImage {
  el: HTMLImageElement;
  id: string;
  entry: ImageEntry;
  importance: number;
  geom: Geometry;
  state: ImgState;
  loadedWidth: number;
  degraded: boolean;
  ctrl?: AbortController;
  objectUrl?: string;
  seen: boolean;
  /** не перезапускати до цього моменту (після скасування) */
  cooldownUntil: number;
  last?: PriorityResult;
  /** В2: хоч раз відкладене через бюджет попереднього завантаження */
  deferred?: boolean;
}

export interface Stats {
  loads: number;
  upgrades: number;
  aborts: number;
  misses: number;
  wastes: number;
  bytes: number;
  bps: number;
  kbps: number;
  rttMs: number;
  horizonMs: number;
  format: ImageFormat;
  maxConcurrent: number;
  /** мітка варіанта методу та вимкнені компоненти (абляція) */
  variant: string;
  disabled: Component[];
  /** В2: скільки елементів хоч раз відкладено через бюджет попереднього завантаження */
  prefetchSkips: number;
  /** В2: скільки стрибків прокручування розпізнано */
  jumps: number;
}

class Engine {
  private readonly opts: Required<Omit<Options, 'weights' | 'maxConcurrent'>> & { maxConcurrent?: number };
  private readonly weights: Weights;
  private readonly net: NetworkEstimator;
  private readonly scroll: ScrollTracker;
  private readonly off: Record<Component, boolean>;
  /** В2: «маркерне відро» байтів для попереднього завантаження невидимих елементів */
  private tokens = 0;
  private lastRefill = performance.now();
  private readonly fb: Feedback;
  private dev: DeviceInfo = readDevice();
  private format: ImageFormat = 'jpeg';
  private images: ManagedImage[] = [];
  private videos: ManagedVideo[] = [];
  private active = 0;
  private timer = 0;
  private readonly t0 = performance.now();
  readonly stats: Stats;

  constructor(options: Options) {
    this.opts = {
      baseUrl: '',
      horizonMs: 3000,
      visibleBudgetMs: 1500,
      dprCap: 2,
      heroGateMs: 2500,
      hlsUrl: '/vendor/hls.min.js',
      persist: true,
      tickMs: 100,
      debug: false,
      disable: [],
      // значення за замовчуванням = поведінка версії В (теза 3)
      prefetchShare: 0,
      prefetchT: 0.05,
      prefetchDistVh: 1.5,
      jumpGuard: false,
      throughput: 'ewma',
      heroGateStrict: false,
      upgradeMinGain: 1,
      variant: 'c',
      ...options,
    } as Engine['opts'];
    const dis = new Set(this.opts.disable);
    this.off = { prediction: dis.has('prediction'), quality: dis.has('quality'), abort: dis.has('abort'), feedback: dis.has('feedback') };
    this.weights = { ...DEFAULT_WEIGHTS, ...options.weights };
    this.scroll = new ScrollTracker(this.opts.jumpGuard);
    const stored = this.opts.persist && !this.off.feedback ? Feedback.load() : null;
    this.net = new NetworkEstimator(stored ?? undefined, this.opts.throughput);
    this.fb = new Feedback(stored?.horizonMs ?? this.opts.horizonMs, this.opts.persist && !this.off.feedback, !this.off.feedback);
    this.stats = {
      loads: 0, upgrades: 0, aborts: 0, misses: 0, wastes: 0, bytes: 0,
      bps: this.net.bps, kbps: this.net.kbps, rttMs: this.net.rttMs,
      horizonMs: this.fb.horizonMs, format: 'jpeg', maxConcurrent: 0,
      variant: this.opts.variant, disabled: [...dis], prefetchSkips: 0, jumps: 0,
    };
  }

  async start(): Promise<void> {
    this.net.observeResourceTiming();
    this.fb.observeVitals();
    this.collect();
    this.measure();
    this.format = await detectFormats(this.opts.manifest.probe);
    this.stats.format = this.format;

    window.addEventListener('resize', () => { this.dev = readDevice(); this.measure(); }, { passive: true });
    // Зміна висоти документа (шрифти, content-visibility, динамічний вміст) → перевимірюємо геометрію
    if (typeof ResizeObserver !== 'undefined') {
      let pending = false;
      new ResizeObserver(() => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; this.measure(); });
      }).observe(document.body);
    }
    // Нові елементи (наприклад, нескінченна стрічка)
    new MutationObserver(() => { if (this.collect()) this.measure(); })
      .observe(document.body, { childList: true, subtree: true });
    const save = () => this.fb.save(this.net.bps, this.net.rttMs);
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });

    this.tick();
    this.timer = window.setInterval(() => this.tick(), this.opts.tickMs);
  }

  /** Знаходить керовані елементи. Повертає true, якщо додано нові. */
  private collect(): boolean {
    const m = this.opts.manifest;
    let added = false;
    document.querySelectorAll<HTMLImageElement>('img[data-akpm-id]:not([data-akpm-bound])').forEach((el) => {
      const id = el.dataset.akpmId!;
      const entry = m.images[id];
      if (!entry) return;
      el.dataset.akpmBound = '1';
      el.decoding = 'async';
      // Компонент 5: резервуємо місце (запобігання CLS), якщо розмітка цього не зробила
      if (!el.getAttribute('width')) { el.width = entry.w; el.height = entry.h; }
      if (!el.getAttribute('src')) el.src = entry.lqip;
      this.images.push({
        el, id, entry,
        importance: Number(el.dataset.akpmImportance ?? '0'),
        geom: { top: 0, bottom: 0, height: 0 },
        state: 'idle', loadedWidth: 0, degraded: false, seen: false, cooldownUntil: 0,
      });
      added = true;
    });
    document.querySelectorAll<HTMLVideoElement>('video[data-akpm-video]:not([data-akpm-bound])').forEach((el) => {
      const id = el.dataset.akpmVideo!;
      const entry = m.videos[id];
      if (!entry) return;
      el.dataset.akpmBound = '1';
      this.videos.push(new ManagedVideo(el, id, entry, this.opts.baseUrl, this.opts.hlsUrl));
      added = true;
    });
    return added;
  }

  /** Геометрія в координатах документа: читається пакетно лише при зміні макета, а не на кожному кроці. */
  private measure(): void {
    const sy = window.scrollY;
    for (const it of this.images) {
      const r = it.el.getBoundingClientRect();
      it.geom = { top: r.top + sy, bottom: r.bottom + sy, height: r.height };
    }
    for (const v of this.videos) {
      const r = v.el.getBoundingClientRect();
      v.geom = { top: r.top + sy, bottom: r.bottom + sy, height: r.height };
    }
  }

  private heroPending(): boolean {
    if (performance.now() - this.t0 > this.opts.heroGateMs) return false;
    const hero = document.querySelector<HTMLImageElement>('img[data-akpm-hero]');
    if (hero && !hero.complete) return true;
    return this.images.some((i) => i.importance >= 1 && i.state !== 'loaded');
  }

  private maxConcurrent(): number {
    if (this.opts.maxConcurrent) return this.opts.maxConcurrent;
    const n = Math.floor(this.net.kbps / 1500) + 1;
    return Math.max(2, Math.min(6, n));
  }

  private tick(): void {
    this.scroll.update();
    const { vh, dpr } = this.dev;
    const dprEff = Math.min(dpr, this.opts.dprCap);
    const sy = this.scroll.y;
    // Абляція «без прогнозу»: швидкість 0 → для невидимих T = 0, τ = ∞ (лишається тільки відстань V)
    const v = this.off.prediction ? 0 : this.scroll.v;
    const horizon = this.fb.horizonMs;
    this.refillTokens(horizon);

    // Відео: свій життєвий цикл, але займають слоти мережі
    let videoBusy = 0;
    for (const vid of this.videos) {
      const p = computePriority({
        geom: vid.geom, scrollY: sy, vh, velocity: v, importance: 0.2,
        bytes: vid.entry.posterBytes, bps: this.net.bps, rttMs: this.net.rttMs,
        horizonMs: horizon, weights: this.weights,
      });
      vid.tick(p, vh, this.net.bps);
      if (vid.busy && p.dist < vh) videoBusy++;
    }

    const queue: { it: ManagedImage; p: PriorityResult; upgrade: boolean; bytes: number }[] = [];
    for (const it of this.images) {
      const cssW = it.geom.bottom > it.geom.top ? it.el.clientWidth || this.dev.vw : this.dev.vw;
      const bytes = idealBytes(it.entry, this.format, cssW, dprEff);
      const p = computePriority({
        geom: it.geom, scrollY: sy, vh, velocity: v, importance: it.importance,
        bytes, bps: this.net.bps, rttMs: this.net.rttMs, horizonMs: horizon, weights: this.weights,
      });
      // Зворотний зв'язок: «промах» — елемент з'явився, а повної версії ще немає
      if (p.visible && !it.seen) {
        it.seen = true;
        if (it.state !== 'loaded' && performance.now() - this.t0 > this.opts.heroGateMs) this.fb.miss();
      }
      it.last = p;

      if (it.state === 'loading') {
        // Скасовуємо запити до елементів, що вийшли із зони інтересу.
        // Межа скасування (2,5 екрана) далі за межу запуску (1,5 екрана) — гістерезис проти «скасував → запустив».
        const leaving = !p.visible && p.dist > 2.5 * vh && p.T < 0.05;
        if (leaving && it.ctrl && !this.off.abort) {
          it.ctrl.abort();
          it.cooldownUntil = performance.now() + 1000;
          this.stats.aborts++;
          if (!it.seen) this.fb.waste();
        }
        continue;
      }
      if (it.state === 'idle') {
        const eligible = (p.visible || p.T > this.opts.prefetchT || p.dist < this.opts.prefetchDistVh * vh)
          && performance.now() >= it.cooldownUntil;
        if (eligible) queue.push({ it, p, upgrade: false, bytes });
      } else if (it.state === 'loaded' && it.degraded && p.visible && !this.dev.saveData) {
        queue.push({ it, p: { ...p, P: p.P - 1 }, upgrade: true, bytes }); // покращення якості — найнижчий пріоритет
      }
    }

    queue.sort((a, b) => b.p.P - a.p.P);
    const gate = this.heroPending();
    let limit = this.maxConcurrent() - videoBusy;
    if (gate) limit = Math.min(limit, 1);
    limit = Math.max(1, limit);
    if (gate && this.opts.heroGateStrict) limit = 0; // В2: канал повністю віддано головному зображенню
    this.stats.maxConcurrent = limit;

    for (const q of queue) {
      if (this.active >= limit) break;
      if (gate && !q.p.visible) break;            // поки головне зображення не готове — тільки видиме
      if (q.upgrade && this.active > 0) break;    // покращення — лише коли мережа вільна
      if (q.upgrade && queue.some((x) => !x.upgrade)) break;
      // В2: попереднє завантаження невидимих — у межах бюджету байтів
      if (!q.p.visible && !q.upgrade && !this.spendTokens(q.bytes)) {
        if (!q.it.deferred) { q.it.deferred = true; this.stats.prefetchSkips++; }
        continue;
      }
      void this.load(q.it, q.p, cssWidth(q.it, this.dev.vw), dprEff, q.upgrade);
    }

    this.stats.bps = this.net.bps;
    this.stats.kbps = Math.round(this.net.kbps);
    this.stats.rttMs = Math.round(this.net.rttMs);
    this.stats.horizonMs = Math.round(this.fb.horizonMs);
    this.stats.misses = this.fb.misses;
    this.stats.wastes = this.fb.wastes;
    this.stats.jumps = this.scroll.jumps;
  }

  /** В2: поповнення бюджету попереднього завантаження зі швидкістю prefetchShare × B */
  private refillTokens(horizonMs: number): void {
    const now = performance.now();
    const dt = (now - this.lastRefill) / 1000;
    this.lastRefill = now;
    if (!(this.opts.prefetchShare > 0)) return;
    const rate = this.opts.prefetchShare * this.net.bps;
    this.tokens = Math.min(this.tokenCap(horizonMs), this.tokens + rate * dt);
  }

  private tokenCap(horizonMs: number): number {
    // ємність — стільки, скільки виділена частка каналу передає за горизонт прогнозу (не менше 64 КБ)
    return Math.max(64_000, this.opts.prefetchShare * this.net.bps * (horizonMs / 1000));
  }

  private spendTokens(bytes: number): boolean {
    if (!(this.opts.prefetchShare > 0)) return true;
    // повне відро пропускає і ресурс, більший за ємність, — інакше великий файл не завантажився б ніколи
    if (this.tokens < bytes && this.tokens < this.tokenCap(this.fb.horizonMs) * 0.99) return false;
    this.tokens = Math.max(0, this.tokens - bytes);
    return true;
  }

  private async load(it: ManagedImage, p: PriorityResult, cssW: number, dpr: number, upgrade: boolean): Promise<void> {
    // Бюджет часу: для видимого — фіксований, для наближуваного — прогнозований час до появи
    let budget: number;
    if (upgrade) budget = Infinity;
    else if (p.visible) budget = this.opts.visibleBudgetMs;
    else if (isFinite(p.tauMs)) budget = Math.min(10_000, Math.max(300, p.tauMs * 0.8));
    else budget = this.opts.visibleBudgetMs * 2; // користувач стоїть: є час, але не нескінченний

    // Абляція «без вибору якості»: нескінченний бюджет → завжди ідеальна для екрана роздільність
    if (this.off.quality) budget = Infinity;
    const choice = chooseVariant(it.entry, this.format, cssW, dpr, budget, this.net.bps / Math.max(1, this.active + 1), this.net.rttMs);
    if (upgrade && (choice.width <= it.loadedWidth || choice.width < it.loadedWidth * this.opts.upgradeMinGain)) {
      it.degraded = false;
      return;
    }

    const url = `${this.opts.baseUrl}/media/img/${it.id}/${choice.width}.${extFor(this.format)}`;
    const ctrl = new AbortController();
    it.ctrl = ctrl;
    it.state = 'loading';
    this.active++;
    const concurrencyAtStart = this.active;
    try {
      const init: RequestInit & { priority?: string } = {
        signal: ctrl.signal,
        priority: p.visible ? 'high' : 'low',
      };
      const t0 = performance.now();
      const res = await fetch(url, init);
      const tHead = performance.now();
      this.net.addRtt(tHead - t0);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const tEnd = performance.now();
      if (this.opts.throughput === 'aggregate') this.net.addTransfer(blob.size, tHead, tEnd);
      else this.net.addSample(blob.size, tEnd - tHead, Math.max(concurrencyAtStart, this.active));
      this.stats.bytes += blob.size;

      const objectUrl = URL.createObjectURL(blob);
      const prev = it.objectUrl;
      // Компонент 5: асинхронне декодування поза головним потоком перед заміною
      const pre = new Image();
      pre.src = objectUrl;
      try { await pre.decode(); } catch { /* декодуємо при відображенні */ }
      it.el.src = objectUrl;
      it.el.classList.add('akpm-loaded');
      it.objectUrl = objectUrl;
      if (prev) setTimeout(() => URL.revokeObjectURL(prev), 1000);

      it.state = 'loaded';
      it.loadedWidth = choice.width;
      it.degraded = choice.degraded;
      if (upgrade) this.stats.upgrades++; else this.stats.loads++;
      if (this.opts.debug) console.log('[AKPM]', it.id, choice.width, Math.round(budget), 'ms budget', Math.round(this.net.kbps), 'kbps');
    } catch (e) {
      it.state = it.loadedWidth > 0 ? 'loaded' : 'idle';
      if (this.opts.debug && (e as Error).name !== 'AbortError') console.warn('[AKPM]', it.id, e);
    } finally {
      it.ctrl = undefined;
      this.active--;
    }
  }

  stop(): void { clearInterval(this.timer); }
}

function cssWidth(it: ManagedImage, vw: number): number {
  return it.el.clientWidth || vw;
}

let engine: Engine | undefined;

export function init(options: Options): Engine {
  if (engine) return engine;
  engine = new Engine(options);
  const go = () => void engine!.start();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
  else go();
  (window as unknown as { AKPM_STATS: Stats }).AKPM_STATS = engine.stats;
  return engine;
}

export type { Options, Manifest } from './types';
