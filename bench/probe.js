// Вимірювальний зонд. Раннер вставляє його в сторінку ДО її власних скриптів
// (разом із web-vitals.iife.js), тому сторінки А/Б/В залишаються «чистими».
(() => {
  const m = (window.__bench = {
    lcp: null, lcpEl: null, fcp: null, ttfb: null, cls: 0, inp: null, hero: null, heroUrl: null,
    longTasks: [], videos: {},
  });

  const wv = window.webVitals;
  if (wv) {
    wv.onLCP((x) => {
      m.lcp = x.value;
      const e = x.entries[x.entries.length - 1];
      m.lcpEl = e && e.element ? (e.element.tagName + (e.url ? ':' + e.url.split('/').slice(-2).join('/') : '')).slice(0, 120) : null;
    }, { reportAllChanges: true });
    wv.onFCP((x) => (m.fcp = x.value));
    wv.onTTFB((x) => (m.ttfb = x.value));
    wv.onCLS((x) => (m.cls = x.value), { reportAllChanges: true });
    wv.onINP((x) => (m.inp = x.value), { reportAllChanges: true, durationThreshold: 16 });
  }

  // Час відображення головного зображення (атрибут elementtiming="hero" на банері в усіх конфігураціях)
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.identifier === 'hero') { m.hero = e.renderTime || e.loadTime; m.heroUrl = e.url || null; }
    }).observe({ type: 'element', buffered: true });
  } catch {}

  // Довгі задачі → TBT (сумарний час блокування понад 50 мс за всю сесію)
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) m.longTasks.push([e.startTime, e.duration]);
    }).observe({ type: 'longtask', buffered: true });
  } catch {}

  // Відео: момент, коли відео видно на ≥50%, перший 'playing' і зупинки ('waiting' після старту)
  const vid = (v) => {
    if (!v.__benchId) v.__benchId = 'v' + Object.keys(m.videos).length;
    return (m.videos[v.__benchId] ||= { visibleAt: null, playingAt: null, stalls: 0 });
  };
  document.addEventListener('playing', (e) => {
    if (!(e.target instanceof HTMLVideoElement)) return;
    const r = vid(e.target);
    if (r.playingAt == null) r.playingAt = performance.now();
  }, true);
  document.addEventListener('waiting', (e) => {
    if (!(e.target instanceof HTMLVideoElement)) return;
    const r = vid(e.target);
    if (r.playingAt != null) r.stalls++;
  }, true);
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) {
        const r = vid(en.target);
        if (r.visibleAt == null) r.visibleAt = performance.now();
      }
    }
  }, { threshold: 0.5 });
  const watch = () => document.querySelectorAll('video').forEach((v) => { if (!v.__benchWatched) { v.__benchWatched = 1; io.observe(v); } });
  document.addEventListener('DOMContentLoaded', () => {
    watch();
    new MutationObserver(watch).observe(document.body, { childList: true, subtree: true });
  });

  window.__benchCollect = () => {
    const fcp = m.fcp ?? 0;
    const tbt = m.longTasks.filter(([s]) => s >= fcp).reduce((a, [, d]) => a + Math.max(0, d - 50), 0);
    const ttp = [];
    let stalls = 0;
    for (const r of Object.values(m.videos)) {
      if (r.visibleAt != null && r.playingAt != null) ttp.push(Math.max(0, r.playingAt - r.visibleAt));
      stalls += r.stalls;
    }
    ttp.sort((a, b) => a - b);
    const med = ttp.length ? ttp[Math.floor((ttp.length - 1) / 2)] : null;
    return {
      lcp: m.lcp, lcpEl: m.lcpEl, hero: m.hero, heroUrl: m.heroUrl, fcp: m.fcp, ttfb: m.ttfb, cls: m.cls, inp: m.inp, tbt,
      videoTtp: med, videosPlayed: ttp.length, videoStalls: stalls,
      akpm: window.AKPM_STATS ? { ...window.AKPM_STATS } : null,
    };
  };
})();
