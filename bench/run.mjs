// Раннер експерименту: для кожної комбінації «конфігурація × макет × сценарій × мережа × пристрій»
// виконує N прогонів сценарію (завантаження → пауза → фази прокручування + кліки) і зберігає метрики.
//
// Приклади:
//   node bench/run.mjs                                   # усе з bench.config.mjs (стрічка, сценарій тези 3)
//   node bench/run.mjs --runs 5 --networks slow4g --devices mobile
//   node bench/run.mjs --configs b,c --runs 30
//   node bench/run.mjs --plan factorial                  # пресет із bench.config.mjs → bench.plans
//   node bench/run.mjs --plan layouts --runs 3           # пресет, але 3 прогони
//   node bench/run.mjs --layouts gallery,video --scenarios steady,jump --configs b2,c2
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

const planName = arg('plan');
const plan = planName ? B.plans?.[planName] : {};
if (!plan) throw new Error(`Немає пресету «${planName}». Є: ${Object.keys(B.plans ?? {}).join(', ')}`);

const sc = B.scenario;
// Сценарій тези 3 — з параметрів scenario; решта — з bench.scenarios
const SCENARIOS = {
  steady: { phases: [{ scroll: sc.scrollDistancePx, speed: sc.scrollSpeedPxPerSec, pauseEveryPx: sc.pauseEveryPx, pauseMs: sc.pauseMs }] },
  ...B.scenarios,
};
const LAYOUTS = ['feed', ...Object.keys(config.layouts ?? {})];

const runs = Number(arg('runs', plan.runs ?? B.runs));
const configs = list(arg('configs'), plan.configs ?? B.configs);
const layouts = list(arg('layouts'), plan.layouts ?? ['feed']);
const scenarios = list(arg('scenarios'), plan.scenarios ?? ['steady']);
const staticNets = Object.keys(B.networks).filter((n) => !B.networks[n].trace);
const cliNets = list(arg('networks'));
const cliDevs = list(arg('devices'));
// combos — явні пари «мережа, пристрій» (як у тезі 3); інакше — усі поєднання
const combos = !cliNets && !cliDevs && plan.combos
  ? plan.combos
  : (cliNets ?? plan.networks ?? staticNets).flatMap((n) => (cliDevs ?? plan.devices ?? Object.keys(B.devices)).map((d) => [n, d]));
const outDir = path.resolve(ROOT, arg('out', 'results'));
const maxLoadWaitMs = Number(arg('max-load-wait', 20000));

for (const l of layouts) if (!LAYOUTS.includes(l)) throw new Error(`Невідомий макет «${l}». Є: ${LAYOUTS.join(', ')}`);
for (const s of scenarios) if (!SCENARIOS[s]) throw new Error(`Невідомий сценарій «${s}». Є: ${Object.keys(SCENARIOS).join(', ')}`);
for (const [n, d] of combos) {
  if (!B.networks[n]) throw new Error(`Невідома мережа «${n}»`);
  if (!B.devices[d]) throw new Error(`Невідомий пристрій «${d}»`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Крок обмежено ≈ 4 номінальними кроками по 50 мс при 900 пікс./с; для швидших сценаріїв — пропорційно
const maxStep = (speed) => Math.max(200, Math.round(Math.abs(speed) * 0.1));

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

async function measure(browser, baseUrl, job) {
  const ctx = await browser.createBrowserContext();
  // Контекст закривається і при помилці: інакше сторінка вантажила б медіа далі й заважала наступному прогону
  const timers = [];
  try {
    return await measureIn(ctx, baseUrl, job, timers);
  } finally {
    timers.forEach(clearTimeout);
    await ctx.close().catch(() => {});
  }
}

const netConditions = (n, netName) => ({
  offline: false,
  latency: n.latency,
  downloadThroughput: (n.downloadKbps * 1000) / 8,
  uploadThroughput: (n.uploadKbps * 1000) / 8,
  connectionType: netName === '3g' ? 'cellular3g' : 'cellular4g',
});

async function measureIn(ctx, baseUrl, { cfg, layout, scenario, network: netName, device: devName }, timers) {
  const net = B.networks[netName];
  const dev = B.devices[devName];
  const scen = SCENARIOS[scenario];
  const dwellMs = scen.videoDwellMs ?? sc.videoDwellMs;
  const page = await ctx.newPage();
  const cdp = await page.createCDPSession();

  // ---- облік трафіку через DevTools Protocol (враховує і скасовані запити) ----
  // Часові мітки (с, монотонний час DevTools) — для діагностики конкуренції за канал під час завантаження банера
  const reqs = new Map();
  const chunks = []; // [час, requestId, байти]
  cdp.on('Network.requestWillBeSent', (e) => {
    if (/^(data|blob):/.test(e.request.url)) return;
    if (!reqs.has(e.requestId)) reqs.set(e.requestId, { partial: 0, final: null, url: e.request.url, start: e.timestamp, end: null });
  });
  cdp.on('Network.dataReceived', (e) => {
    const r = reqs.get(e.requestId);
    if (r) { r.partial += e.encodedDataLength; chunks.push([e.timestamp, e.requestId, e.encodedDataLength]); }
  });
  cdp.on('Network.loadingFinished', (e) => { const r = reqs.get(e.requestId); if (r) { r.final = e.encodedDataLength; r.end = e.timestamp; } });
  cdp.on('Network.loadingFailed', (e) => { const r = reqs.get(e.requestId); if (r) r.end = e.timestamp; });

  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  // Змінна мережа: перший крок траси — одразу, наступні — за таймерами від початку навігації
  const trace = net.trace ?? [{ atMs: 0, ...net }];
  await cdp.send('Network.emulateNetworkConditions', netConditions(trace[0], netName));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: dev.cpuSlowdown });
  await page.setViewport({
    width: dev.width, height: dev.height, deviceScaleFactor: dev.deviceScaleFactor,
    isMobile: dev.isMobile, hasTouch: dev.hasTouch,
  });

  const wvSrc = await fs.readFile(path.join(ROOT, 'node_modules/web-vitals/dist/web-vitals.iife.js'), 'utf8');
  const probeSrc = await fs.readFile(path.join(ROOT, 'bench/probe.js'), 'utf8');
  await page.evaluateOnNewDocument(wvSrc + '\n;' + probeSrc);

  const t0 = Date.now();
  for (const step of trace.slice(1)) {
    timers.push(setTimeout(() => { cdp.send('Network.emulateNetworkConditions', netConditions(step, netName)).catch(() => {}); }, step.atMs));
  }
  const loaded = page.waitForNavigation({ waitUntil: 'load', timeout: 0 }).catch(() => {});
  const urlPath = layout === 'feed' ? `/${cfg}` : `/${layout}/${cfg}`;
  await page.goto(`${baseUrl}${urlPath}`, { waitUntil: 'domcontentloaded', timeout: sc.navigationTimeoutMs });
  await Promise.race([loaded, sleep(maxLoadWaitMs)]);
  const loadMs = Date.now() - t0;
  await sleep(sc.settleAfterLoadMs);

  // ---- сценарій: фази прокручування, паузи «читання», стрибки, очікування, кліки «лайк» ----
  await page.mouse.move(dev.width / 2, dev.height / 2);
  // Кліки рівномірно за сумарною відстанню прокручування всіх фаз (для «steady» — як у тезі 3)
  const totalScroll = scen.phases.reduce((a, ph) => a + Math.abs(ph.scroll ?? 0), 0);
  const clickAt = Array.from({ length: sc.clicks }, (_, i) => Math.round((totalScroll * (i + 1)) / (sc.clicks + 1)));
  let scrolledTotal = 0;
  for (const ph of scen.phases) {
    if (ph.wait) { await sleep(ph.wait); continue; }
    if (ph.jumpTo != null) {
      await page.evaluate((f) => window.scrollTo({ top: Math.round(f * (document.documentElement.scrollHeight - innerHeight)), behavior: 'instant' }), ph.jumpTo);
      continue;
    }
    const sign = Math.sign(ph.scroll);
    const dist = Math.abs(ph.scroll);
    const speed = ph.speed ?? sc.scrollSpeedPxPerSec;
    let scrolled = 0;
    let nextPause = ph.pauseEveryPx ?? Infinity;
    let last = Date.now();
    while (scrolled < dist) {
      await sleep(50);
      const now = Date.now();
      // Крок обмежено: якщо ітерація зависла (сторінка зайнята), прокручування сповільнюється,
      // а не перестрибує через контент — інакше відео могло б не потрапити у вікно взагалі
      const dy = Math.min(maxStep(speed), Math.max(1, Math.round((speed * (now - last)) / 1000)));
      last = now;
      await page.mouse.wheel({ deltaY: sign * dy });
      scrolled += dy;
      scrolledTotal += dy;
      if (clickAt.length && scrolledTotal >= clickAt[0]) {
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
        nextPause += ph.pauseEveryPx;
        await sleep(ph.pauseMs ?? sc.pauseMs);
        last = Date.now();
      }
      const st = await page.evaluate((up) => {
        // Нескінченна стрічка: кінець — лише коли довантажувати вже нічого (маркер #sentinel прибрано)
        const atEnd = up ? scrollY <= 0
          : innerHeight + scrollY >= document.documentElement.scrollHeight - 2 && !document.getElementById('sentinel');
        let video = -1;
        document.querySelectorAll('video').forEach((v, i) => {
          if (video >= 0 || v.__dwelled) return;
          const r = v.getBoundingClientRect();
          const vis = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) / (r.height || 1);
          if (vis >= 0.6) { v.__dwelled = true; video = i; }
        });
        return { atEnd, video };
      }, sign < 0);
      if (st.video >= 0 && dwellMs) {
        await sleep(dwellMs);
        last = Date.now();
      }
      if (st.atEnd) break;
    }
  }
  await sleep(sc.finalWaitMs);

  const m = await page.evaluate(() => window.__benchCollect());
  let bytes = 0;
  for (const r of reqs.values()) bytes += r.final ?? r.partial;
  return {
    ...m,
    ...heroDiagnostics(reqs, chunks, m.heroUrl),
    bytes,
    requests: reqs.size,
    loadMs,
    sessionMs: Date.now() - t0,
  };
}

/**
 * Діагностика нестабільного LCP: що ще йшло каналом, поки завантажувалося головне зображення.
 * heroReqStart/heroReqEnd — мс від першого запиту (документа); heroCompetingBytes — байти інших
 * відповідей, отримані за цей час; heroCompetingReqs — скільки інших запитів перетиналося з ним у часі.
 */
function heroDiagnostics(reqs, chunks, heroUrl) {
  if (!heroUrl) return {};
  const all = [...reqs.entries()];
  const t0 = Math.min(...all.map(([, r]) => r.start));
  const hero = all.find(([, r]) => r.url === heroUrl);
  if (!hero) return {};
  const [heroId, h] = hero;
  const end = h.end ?? Infinity;
  let competingBytes = 0;
  for (const [ts, id, len] of chunks) if (id !== heroId && ts >= h.start && ts <= end) competingBytes += len;
  const competingReqs = all.filter(([id, r]) => id !== heroId && r.start < end && (r.end ?? Infinity) > h.start).length;
  return {
    heroReqStart: (h.start - t0) * 1000,
    heroReqEnd: h.end != null ? (h.end - t0) * 1000 : null,
    heroCompetingBytes: competingBytes,
    heroCompetingReqs: competingReqs,
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
  const total = runs * configs.length * combos.length * layouts.length * scenarios.length;
  console.log(`Chrome ${chromeVersion}${planName ? ` · пресет «${planName}»` : ''} · ${runs} прогонів × ${configs.length} конф. × ${combos.length} (мережа, пристрій) × ${layouts.length} макет. × ${scenarios.length} сцен. = ${total} прогонів, орієнтовно ${(total * 45 / 3600).toFixed(1)} год`);
  console.log(`  конфігурації: ${configs.join(', ')}; макети: ${layouts.join(', ')}; сценарії: ${scenarios.join(', ')}; ${combos.map((c) => c.join('×')).join(', ')}`);

  const MAX_ATTEMPTS = 2;
  let n = 0;
  for (let run = 1; run <= runs; run++) {
    for (const [netName, devName] of combos) {
      for (const layout of layouts) {
       for (const scenario of scenarios) {
        // Для серії тези 3 (стрічка, steady) зерно перемішування те саме, що й раніше
        const seed = run * 31 + netName.length * 7 + devName.length
          + (layout === 'feed' ? 0 : layout.length * 13) + (scenario === 'steady' ? 0 : scenario.length * 17);
        for (const cfg of shuffled(configs, seed)) {
          n++;
          const job = { cfg, layout, scenario, network: netName, device: devName };
          const where = `${layout === 'feed' ? '' : layout + ' '}${scenario === 'steady' ? '' : scenario + ' '}`;
          const tag = `[${n}/${total}] ${cfg} ${where}${netName} ${devName} #${run}`;
          for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (!browser.connected) {
              const dead = browser;
              browser = null; // щоб 'disconnected' старого екземпляра не рахувався двічі
              await safeClose(dead);
              browser = await launch();
            }
            const t = Date.now();
            try {
              const m = await measure(browser, baseUrl, job);
              const row = { config: cfg, layout, scenario, network: netName, device: devName, run, attempt, ...m, chrome: chromeVersion };
              await fs.appendFile(jsonl, JSON.stringify(row) + '\n');
              console.log(`${tag}: LCP ${Math.round(m.lcp ?? -1)} мс, CLS ${(m.cls ?? 0).toFixed(3)}, INP ${m.inp ?? '-'} мс, ${(m.bytes / 1e6).toFixed(2)} МБ (${((Date.now() - t) / 1000).toFixed(0)} с)${attempt > 1 ? ' — повторна спроба' : ''}`);
              break;
            } catch (e) {
              if (attempt < MAX_ATTEMPTS) {
                console.error(`${tag}: ПОМИЛКА ${e.message} — повторюю`);
              } else {
                console.error(`${tag}: ПОМИЛКА ${e.message}`);
                await fs.appendFile(jsonl, JSON.stringify({ config: cfg, layout, scenario, network: netName, device: devName, run, attempt, error: e.message }) + '\n');
              }
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
