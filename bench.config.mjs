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
  },
};
