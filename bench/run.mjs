// Раннер експерименту: для кожної комбінації «конфігурація × мережа × пристрій» виконує N прогонів
// сценарію (завантаження → пауза → прокручування з фіксованою швидкістю + кліки) і зберігає метрики.
//
// Приклади:
//   node bench/run.mjs                                   # усе з bench.config.mjs
//   node bench/run.mjs --runs 5 --networks slow4g --devices mobile
//   node bench/run.mjs --configs b,c --runs 30
// Chrome: за замовчуванням той, що завантажив Puppeteer; інший — через PUPPETEER_EXECUTABLE_PATH.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import config from '../bench.config.mjs';
import { createServer } from '../server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = config.bench;

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : def;
}
const list = (v, def) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def);

const runs = Number(arg('runs', B.runs));
const configs = list(arg('configs'), B.configs);
const networks = list(arg('networks'), Object.keys(B.networks));
const devices = list(arg('devices'), Object.keys(B.devices));
const outDir = path.resolve(ROOT, arg('out', 'results'));
const sc = B.scenario;
const maxLoadWaitMs = Number(arg('max-load-wait', 20000));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_STEP_PX = 200; // ≈ 4 номінальні кроки по 50 мс при 900 пікс./с

// Детерміноване перемішування порядку конфігурацій у кожному раунді (зменшує систематичний зсув)
function shuffled(arr, seed) {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function measure(browser, baseUrl, cfg, netName, devName) {
  const ctx = await browser.createBrowserContext();
  // Контекст закривається і при помилці: інакше сторінка вантажила б медіа далі й заважала наступному прогону
  try {
    return await measureIn(ctx, baseUrl, cfg, netName, devName);
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function measureIn(ctx, baseUrl, cfg, netName, devName) {
  const net = B.networks[netName];
  const dev = B.devices[devName];
  const page = await ctx.newPage();
  const cdp = await page.createCDPSession();

  // ---- облік трафіку через DevTools Protocol (враховує і скасовані запити) ----
  const reqs = new Map();
  cdp.on('Network.requestWillBeSent', (e) => {
    if (/^(data|blob):/.test(e.request.url)) return;
    if (!reqs.has(e.requestId)) reqs.set(e.requestId, { partial: 0, final: null, url: e.request.url });
  });
  cdp.on('Network.dataReceived', (e) => { const r = reqs.get(e.requestId); if (r) r.partial += e.encodedDataLength; });
  cdp.on('Network.loadingFinished', (e) => { const r = reqs.get(e.requestId); if (r) r.final = e.encodedDataLength; });

  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: net.latency,
    downloadThroughput: (net.downloadKbps * 1000) / 8,
    uploadThroughput: (net.uploadKbps * 1000) / 8,
    connectionType: netName === '3g' ? 'cellular3g' : 'cellular4g',
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: dev.cpuSlowdown });
  await page.setViewport({
    width: dev.width, height: dev.height, deviceScaleFactor: dev.deviceScaleFactor,
    isMobile: dev.isMobile, hasTouch: dev.hasTouch,
  });

  const wvSrc = await fs.readFile(path.join(ROOT, 'node_modules/web-vitals/dist/web-vitals.iife.js'), 'utf8');
  const probeSrc = await fs.readFile(path.join(ROOT, 'bench/probe.js'), 'utf8');
  await page.evaluateOnNewDocument(wvSrc + '\n;' + probeSrc);

  const t0 = Date.now();
  const loaded = page.waitForNavigation({ waitUntil: 'load', timeout: 0 }).catch(() => {});
  await page.goto(`${baseUrl}/${cfg}`, { waitUntil: 'domcontentloaded', timeout: sc.navigationTimeoutMs });
  await Promise.race([loaded, sleep(maxLoadWaitMs)]);
  const loadMs = Date.now() - t0;
  await sleep(sc.settleAfterLoadMs);

  // ---- сценарій: прокручування з фіксованою швидкістю, паузи «читання», кліки «лайк» ----
  await page.mouse.move(dev.width / 2, dev.height / 2);
  let scrolled = 0;
  let nextPause = sc.pauseEveryPx;
  const clickAt = Array.from({ length: sc.clicks }, (_, i) => Math.round((sc.scrollDistancePx * (i + 1)) / (sc.clicks + 1)));
  let last = Date.now();
  while (scrolled < sc.scrollDistancePx) {
    await sleep(50);
    const now = Date.now();
    // Крок обмежено: якщо ітерація зависла (сторінка зайнята), прокручування сповільнюється,
    // а не перестрибує через контент — інакше відео могло б не потрапити у вікно взагалі
    const dy = Math.min(MAX_STEP_PX, Math.max(1, Math.round((sc.scrollSpeedPxPerSec * (now - last)) / 1000)));
    last = now;
    await page.mouse.wheel({ deltaY: dy });
    scrolled += dy;
    if (clickAt.length && scrolled >= clickAt[0]) {
      clickAt.shift();
      const pt = await page.evaluate(() => {
        for (const b of document.querySelectorAll('.like')) {
          const r = b.getBoundingClientRect();
          if (r.top > 60 && r.bottom < innerHeight - 10) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
        return null;
      });
      if (pt) { await page.mouse.click(pt.x, pt.y); await page.mouse.move(dev.width / 2, dev.height / 2); }
      last = Date.now();
    }
    if (scrolled >= nextPause) {
      nextPause += sc.pauseEveryPx;
      await sleep(sc.pauseMs);
      last = Date.now();
    }
    const st = await page.evaluate(() => {
      const atEnd = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
      let video = -1;
      document.querySelectorAll('video').forEach((v, i) => {
        if (video >= 0 || v.__dwelled) return;
        const r = v.getBoundingClientRect();
        const vis = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) / (r.height || 1);
        if (vis >= 0.6) { v.__dwelled = true; video = i; }
      });
      return { atEnd, video };
    });
    if (st.video >= 0 && sc.videoDwellMs) {
      await sleep(sc.videoDwellMs);
      last = Date.now();
    }
    if (st.atEnd) break;
  }
  await sleep(sc.finalWaitMs);

  const m = await page.evaluate(() => window.__benchCollect());
  let bytes = 0;
  for (const r of reqs.values()) bytes += r.final ?? r.partial;
  return {
    ...m,
    bytes,
    requests: reqs.size,
    loadMs,
    sessionMs: Date.now() - t0,
  };
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonl = path.join(outDir, `raw-${stamp}.jsonl`);

  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const args = ['--autoplay-policy=no-user-gesture-required'];
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
  // Chrome може впасти посеред серії (траплялося на Windows). Тоді браузер перезапускається,
  // а невдалий прогін повторюється один раз; інакше всі наступні прогони падали б із «Connection closed».
  let browser = null;
  let crashes = 0;
  const launch = async () => {
    const b = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args,
    });
    b.on('disconnected', () => { if (b === browser) { crashes++; console.error(`  ! Chrome від'єднався (${new Date().toLocaleTimeString()}), буде перезапущено`); } });
    return b;
  };
  // На Windows видалення тимчасового профілю іноді дає EBUSY — це не має зупиняти серію
  // Після «від'єднання» процес Chrome може лишатися живим і не давати Node завершитися, тому його вбиваємо явно
  const safeClose = async (b) => {
    try { await b?.close(); } catch {}
    try { b?.process()?.kill('SIGKILL'); } catch {}
  };
  browser = await launch();
  const chromeVersion = await browser.version();
  console.log(`Chrome ${chromeVersion} · ${runs} прогонів × ${configs.length} конф. × ${networks.length} мереж × ${devices.length} пристр.`);

  const MAX_ATTEMPTS = 2;
  const total = runs * configs.length * networks.length * devices.length;
  let n = 0;
  for (let run = 1; run <= runs; run++) {
    for (const netName of networks) {
      for (const devName of devices) {
        for (const cfg of shuffled(configs, run * 31 + netName.length * 7 + devName.length)) {
          n++;
          const tag = `[${n}/${total}] ${cfg} ${netName} ${devName} #${run}`;
          for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (!browser.connected) {
              const dead = browser;
              browser = null; // щоб 'disconnected' старого екземпляра не рахувався двічі
              await safeClose(dead);
              browser = await launch();
            }
            const t = Date.now();
            try {
              const m = await measure(browser, baseUrl, cfg, netName, devName);
              const row = { config: cfg, network: netName, device: devName, run, attempt, ...m, chrome: chromeVersion };
              await fs.appendFile(jsonl, JSON.stringify(row) + '\n');
              console.log(`${tag}: LCP ${Math.round(m.lcp ?? -1)} мс, CLS ${(m.cls ?? 0).toFixed(3)}, INP ${m.inp ?? '-'} мс, ${(m.bytes / 1e6).toFixed(2)} МБ (${((Date.now() - t) / 1000).toFixed(0)} с)${attempt > 1 ? ' — повторна спроба' : ''}`);
              break;
            } catch (e) {
              if (attempt < MAX_ATTEMPTS) {
                console.error(`${tag}: ПОМИЛКА ${e.message} — повторюю`);
              } else {
                console.error(`${tag}: ПОМИЛКА ${e.message}`);
                await fs.appendFile(jsonl, JSON.stringify({ config: cfg, network: netName, device: devName, run, attempt, error: e.message }) + '\n');
              }
            }
          }
        }
      }
    }
  }
  const last = browser;
  browser = null;
  await safeClose(last);
  server.close();
  if (crashes) console.log(`\nПерезапусків Chrome за серію: ${crashes}`);
  console.log(`\nСирі дані: ${path.relative(ROOT, jsonl)}\nДалі: npm run analyze`);
  process.exit(0); // не чекати на завислі дочірні процеси
}

main().catch((e) => { console.error(e); process.exit(1); });
