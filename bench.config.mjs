// Єдина конфігурація експерименту. Змінюйте тут — усі скрипти читають цей файл.

export default {
  // ---------- Медіа ----------
  media: {
    imageCount: 60,          // скільки зображень у стрічці (якщо немає власних у media-source/images)
    videoCount: 4,           // скільки відео (якщо немає власних у media-source/videos)
    videoEvery: 10,          // відео-картка після кожних N зображень (63 у стрічці / 10 → 6 відео)
    sourceWidth: 2400,       // ширина синтетичного «оригіналу»
    sourceHeight: 1600,
    widths: [320, 480, 640, 960, 1280, 1920],
    quality: { avif: 50, webp: 75, jpeg: 80, origJpeg: 90 },
    avifEffort: 3,           // 0..9: вище — менші файли, довше кодування
    videoLevels: [           // рівні HLS
      { height: 360, bitrate: 600 },
      { height: 720, bitrate: 1800 },
      { height: 1080, bitrate: 4500 },
    ],
    videoSeconds: 20,        // тривалість синтетичних відео
    hlsSegmentSeconds: 4,
  },

  // ---------- Додаткові макети сторінок (розширений експеримент) ----------
  // URL: /<макет>/<конфігурація>, наприклад /gallery/c. Стрічка (feed) лишається на /a, /b, /b2, /c.
  // Якщо власних фото менше, ніж потрібно, вони повторюються з окремими URL (…/img-007~1/…):
  // сервер віддає той самий файл, але для браузера це окремий ресурс без кешу.
  layouts: {
    gallery:  { items: 240 },                          // сітка-мозаїка лише із зображень
    infinite: { laps: 2, initialCards: 12, batch: 12 }, // нескінченна стрічка: довантаження порціями
    video:    { videos: 12, imageEvery: 2 },           // відеосторінка: 12 плеєрів, зображення після кожних 2
  },

  // ---------- Варіанти методу ----------
  akpm: {
    // В2: виправлення обмежень, знайдених у тезі 3 (надлишкове попереднє завантаження, нестабільний LCP)
    v2: {
      prefetchShare: 0.5,     // попереднє завантаження — не більше половини оцінки пропускної здатності
      prefetchT: 0.3,         // наперед — лише елементи з T > 0,3 (В: 0,05)
      prefetchDistVh: 1,      // без прогнозу — лише в межах 1 екрана (В: 1,5)
      jumpGuard: true,        // стрибок прокручування не вважається швидкістю
      throughput: 'aggregate',// оцінка мережі за сумарними байтами за час зайнятості каналу
      // Строгий шлюз банера вимкнено: у димовій перевірці (24.11.2026) банер з'являвся швидше, але LCP-елементом
      // на мобільному була видима картка під банером — і LCP запізнювався на ≈ 0,5 с. Лишено для окремої перевірки.
      heroGateStrict: false,
      upgradeMinGain: 1.5,    // покращувати якість, лише якщо ширина зросте щонайменше в 1,5 раза
    },
    // Абляційний аналіз (вимикається один компонент версії В)
    ablations: {
      'c-no-pred':  ['prediction'],
      'c-no-qual':  ['quality'],
      'c-no-abort': ['abort'],
      'c-no-fb':    ['feedback'],
    },
  },

  // ---------- Сервер ----------
  server: { port: 8080 },

  // ---------- Бенчмарк ----------
  bench: {
    configs: ['a', 'b', 'b2', 'c'],  // b2 = Б′: Б + capLevelToPlayerSize для hls.js
    runs: 20,                       // прогонів на кожну комбінацію
    // Мережеві профілі. Slow 4G = профіль Lighthouse mobileSlow4G (150 мс RTT, 1.6 Мбіт/с).
    networks: {
      fast4g: { latency: 40, downloadKbps: 9000, uploadKbps: 1500 },
      slow4g: { latency: 150, downloadKbps: 1638.4, uploadKbps: 675 },
      '3g':   { latency: 300, downloadKbps: 700, uploadKbps: 700 },
      // Змінна мережа: умови змінюються за трасою (atMs — від початку навігації)
      var4g: { trace: [            // погіршення: Fast 4G → Slow 4G → середня
        { atMs: 0,     latency: 40,  downloadKbps: 9000,   uploadKbps: 1500 },
        { atMs: 12000, latency: 150, downloadKbps: 1638.4, uploadKbps: 675 },
        { atMs: 24000, latency: 80,  downloadKbps: 4000,   uploadKbps: 1000 },
      ] },
      dropout: { trace: [          // «тунель»: 8 с майже без зв'язку посеред прокручування
        { atMs: 0,     latency: 40,  downloadKbps: 9000, uploadKbps: 1500 },
        { atMs: 10000, latency: 600, downloadKbps: 250,  uploadKbps: 100 },
        { atMs: 18000, latency: 40,  downloadKbps: 9000, uploadKbps: 1500 },
      ] },
    },
    devices: {
      desktop: { width: 1366, height: 768, deviceScaleFactor: 1, isMobile: false, hasTouch: false, cpuSlowdown: 1 },
      mobile:  { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, cpuSlowdown: 4 },
    },
    scenario: {
      settleAfterLoadMs: 2000,   // пауза після load перед прокручуванням
      scrollDistancePx: 9000,    // загальна відстань прокручування
      scrollSpeedPxPerSec: 900,  // фіксована швидкість
      pauseEveryPx: 1800,        // «читання»: пауза кожні N px
      pauseMs: 1200,
      clicks: 3,                 // скільки кліків «лайк» (для INP)
      videoDwellMs: 4000,        // зупинка на кожному відео, що видно на ≥ 60% (перегляд)
      finalWaitMs: 3000,
      navigationTimeoutMs: 180000,
    },

    // Сценарії поведінки. «steady» — сценарій тези 3 (будується з параметрів scenario вище).
    // Фази: { scroll: px (від'ємне — вгору), speed: px/с, pauseEveryPx?, pauseMs? } | { jumpTo: частка висоти } | { wait: мс }
    // videoDwellMs у сценарії перекриває загальне значення.
    scenarios: {
      slow: { phases: [{ scroll: 4500, speed: 300, pauseEveryPx: 1800, pauseMs: 1200 }] },
      fast: { videoDwellMs: 0, phases: [{ scroll: 12000, speed: 2500, pauseEveryPx: 4000, pauseMs: 800 }] },
      jump: { phases: [                      // перехід за якорем у середину сторінки
        { scroll: 2700, speed: 900, pauseEveryPx: 1800, pauseMs: 1200 },
        { jumpTo: 0.6 }, { wait: 1500 },
        { scroll: 2700, speed: 900, pauseEveryPx: 1800, pauseMs: 1200 },
      ] },
      back: { phases: [                      // повернення назад до вже переглянутого
        { scroll: 6000, speed: 900, pauseEveryPx: 1800, pauseMs: 1200 },
        { scroll: -3600, speed: 900 },
        { scroll: 3600, speed: 900 },
      ] },
      idle: { phases: [{ wait: 12000 }, { scroll: 2700, speed: 900, pauseEveryPx: 1800, pauseMs: 1200 }] },
    },

    // Пресети серій: node bench/run.mjs --plan factorial   (аргументи командного рядка мають пріоритет).
    // combos — пари «мережа, пристрій»; якщо їх немає — усі поєднання networks × devices.
    plans: {
      thesis:    { configs: ['a', 'b', 'b2', 'c'], combos: [['slow4g', 'mobile'], ['fast4g', 'desktop']], runs: 20 },
      factorial: { configs: ['b', 'b2', 'c', 'c2'], networks: ['slow4g', 'fast4g'], devices: ['mobile', 'desktop'], runs: 20 },
      ablation:  { configs: ['b2', 'c', 'c-no-pred', 'c-no-qual', 'c-no-abort', 'c-no-fb'], combos: [['slow4g', 'mobile'], ['fast4g', 'desktop']], runs: 20 },
      scenarios: { configs: ['b2', 'c', 'c2'], scenarios: ['slow', 'fast', 'jump', 'back', 'idle'], combos: [['slow4g', 'mobile']], runs: 15 },
      varnet:    { configs: ['b2', 'c', 'c2'], networks: ['var4g', 'dropout'], devices: ['mobile'], runs: 15 },
      layouts:   { configs: ['b2', 'c', 'c2'], layouts: ['gallery', 'infinite', 'video'], combos: [['slow4g', 'mobile'], ['fast4g', 'desktop']], runs: 15 },
      smoke:     { configs: ['b2', 'c', 'c2'], layouts: ['feed', 'gallery', 'infinite', 'video'], combos: [['fast4g', 'desktop']], runs: 1 },
    },
  },
};
