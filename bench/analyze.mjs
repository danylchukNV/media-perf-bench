// Аналіз результатів: медіана, 75-й процентиль, зміна В відносно Б, U-критерій Манна — Уїтні.
// Будує таблицю у форматі «Таблиці 1» з тез для кожної комбінації мережа × пристрій.
//
//   node bench/analyze.mjs                       # останній results/raw-*.jsonl
//   node bench/analyze.mjs results/raw-a.jsonl results/raw-b.jsonl   # об'єднати кілька файлів
//   node bench/analyze.mjs --compare b,b2,c      # останній — що перевіряємо, решта — з чим порівнюємо
//                                                # (за замовчуванням В відносно Б і Б′, які є в даних)
//
// Крім основних таблиць (формат тези 3), у summary.md додаються розділи розширеного експерименту
// (bench/extra.mjs): В2 відносно В, абляція, факторний аналіз 2×2, діагностика банера.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RES = path.join(ROOT, 'results');
const ci = process.argv.indexOf('--compare');
const compareList = ci > 0 ? process.argv[ci + 1].split(',') : ['b', 'b2', 'c'];
const TEST = compareList.at(-1);
const BASES = compareList.slice(0, -1);
const ALPHA = 0.05;

const METRICS = [
  { key: 'lcp', label: 'LCP, с', f: (v) => v / 1000, d: 2 },
  { key: 'hero', label: 'Час відображення головного зображення, с', f: (v) => v / 1000, d: 2 },
  { key: 'inp', label: 'INP, мс', f: (v) => v, d: 0 },
  { key: 'cls', label: 'CLS', f: (v) => v, d: 3 },
  { key: 'tbt', label: 'TBT, мс', f: (v) => v, d: 0 },
  { key: 'bytes', label: 'Обсяг переданих даних, МБ', f: (v) => v / 1e6, d: 2 },
  { key: 'requests', label: 'Кількість запитів', f: (v) => v, d: 0 },
  { key: 'videoTtp', label: 'Час до початку відтворення відео, с', f: (v) => v / 1000, d: 2 },
  { key: 'videoStalls', label: 'Зупинки відтворення відео', f: (v) => v, d: 1 },
  // Скільки відео почало відтворюватися за сесію: без цього порівняння обсягу даних неповне
  { key: 'videosPlayed', label: 'Відтворено відео за сесію', f: (v) => v, d: 1 },
];
const CFG_LABEL = { a: 'А (базова)', b: 'Б (стандартні практики)', b2: 'Б′ (Б + обмеження відео за розміром плеєра)', c: 'В (метод АКПМ)', c2: 'В2 (метод АКПМ, версія 2)' };
const CFG_SHORT = { a: 'А', b: 'Б', b2: 'Б′', c: 'В', c2: 'В2' };
const CFG_ORDER = ['a', 'b', 'b2', 'c', 'c2'];
const short = (c) => CFG_SHORT[c] ?? c.toUpperCase();

import { quantile, mannWhitney, fmt, fmtP } from './stats.mjs';
import { extraSections, runsCsv } from './extra.mjs';

// ---------- завантаження ----------
async function inputs() {
  const files = process.argv.slice(2).filter((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--compare');
  if (files.length) return files.map((f) => path.resolve(f));
  const all = (await fs.readdir(RES)).filter((f) => /^raw-.*\.jsonl$/.test(f)).sort();
  if (!all.length) throw new Error('Немає results/raw-*.jsonl — спершу запустіть npm run bench');
  return [path.join(RES, all[all.length - 1])];
}

async function main() {
  const files = await inputs();
  const rows = [];
  let errors = 0;
  for (const f of files) {
    for (const line of (await fs.readFile(f, 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.error) { errors++; continue; }
      r.layout ??= 'feed';      // дані тези 3 — без цих полів
      r.scenario ??= 'steady';
      rows.push(r);
    }
  }
  const groups = new Map(); // "layout|scenario|net|dev" → cfg → metric → values[]
  for (const r of rows) {
    if (!CFG_ORDER.includes(r.config)) continue; // абляції — в окремому розділі
    const g = `${r.layout}|${r.scenario}|${r.network}|${r.device}`;
    if (!groups.has(g)) groups.set(g, new Map());
    const byCfg = groups.get(g);
    if (!byCfg.has(r.config)) byCfg.set(r.config, Object.fromEntries(METRICS.map((m) => [m.key, []])));
    const bucket = byCfg.get(r.config);
    bucket._n = (bucket._n ?? 0) + 1;
    bucket._hero = (bucket._hero ?? 0) + (r.hero != null ? 1 : 0);
    bucket._lcpImg = (bucket._lcpImg ?? 0) + (r.lcpEl && /^IMG/.test(r.lcpEl) ? 1 : 0);
    for (const m of METRICS) if (r[m.key] != null && isFinite(r[m.key])) bucket[m.key].push(m.f(r[m.key]));
  }

  const md = [`# Результати експерименту\n`,
    `Джерела: ${files.map((f) => path.relative(ROOT, f)).join(', ')}. Успішних прогонів: ${rows.length}${errors ? `, з помилкою: ${errors}` : ''}.`,
    `Порівняння: ${CFG_LABEL[TEST] ?? TEST} відносно ${BASES.map((b) => CFG_LABEL[b] ?? b).join(' і ')} (якщо є в даних); U-критерій Манна — Уїтні, двосторонній, α = ${String(ALPHA).replace('.', ',')}.`,
    `Chrome: ${[...new Set(rows.map((r) => r.chrome))].join(', ')}\n`];
  const csv = ['layout,scenario,network,device,metric,config,n,median,p75,change_pct_vs_base,mw_U,mw_p'];

  for (const [g, byCfg] of [...groups.entries()].sort()) {
    const [layout, scenario, net, dev] = g.split('|');
    const where = `${layout === 'feed' ? '' : layout + ' · '}${scenario === 'steady' ? '' : scenario + ' · '}`;
    const cfgs = CFG_ORDER.filter((c) => byCfg.has(c)).concat([...byCfg.keys()].filter((c) => !CFG_ORDER.includes(c)));
    const bases = BASES.filter((b) => byCfg.has(b) && b !== TEST);
    const n = Object.fromEntries(cfgs.map((c) => [c, byCfg.get(c)._n]));
    md.push(`## ${where}${net} · ${dev}\n`);
    md.push(`Таблиця — Показники продуктивності тестового застосунку (${where}${net}, ${dev}, медіана; у дужках — 75-й процентиль). Прогонів: ${cfgs.map((c) => `${short(c)} = ${n[c]}`).join(', ')}.\n`);
    const cmpHead = bases.map((b) => `Зміна ${short(TEST)} відносно ${short(b)}, % | p (${short(b)})`).join(' | ');
    md.push(`| Показник | ${cfgs.map((c) => CFG_LABEL[c] ?? c).join(' | ')}${bases.length ? ' | ' + cmpHead : ''} |`);
    md.push(`|${'---|'.repeat(cfgs.length + 1 + bases.length * 2)}`);
    for (const m of METRICS) {
      const cells = [];
      const med = {};
      for (const c of cfgs) {
        const vals = [...byCfg.get(c)[m.key]].sort((a, b) => a - b);
        med[c] = quantile(vals, 0.5);
        const p75 = quantile(vals, 0.75);
        cells.push(vals.length ? `${fmt(med[c], m.d)} (${fmt(p75, m.d)})` : '—');
        csv.push([layout, scenario, net, dev, m.key, c, vals.length, med[c] ?? '', p75 ?? ''].join(',') + ',,,');
      }
      if (cells.every((c) => c === '—')) continue;
      const y = byCfg.get(TEST)?.[m.key] ?? [];
      for (const b of bases) {
        const x = byCfg.get(b)?.[m.key] ?? [];
        const change = med[b] && med[TEST] != null ? ((med[TEST] - med[b]) / med[b]) * 100 : null;
        const mw = mannWhitney(x, y);
        const sig = mw && mw.p < ALPHA ? ' *' : '';
        cells.push(change == null ? '—' : (change > 0 ? '+' : '') + fmt(change, 1), `${fmtP(mw?.p)}${sig}`);
        csv.push([layout, scenario, net, dev, m.key, `${TEST}_vs_${b}`, '', '', '', change ?? '', mw?.U ?? '', mw?.p ?? ''].join(','));
      }
      md.push(`| ${m.label} | ${cells.join(' | ')} |`);
    }
    const blank = ' |'.repeat(bases.length * 2);
    md.push(`| Головне зображення відобразилось за сесію, прогонів | ${cfgs.map((c) => `${byCfg.get(c)._hero} з ${byCfg.get(c)._n}`).join(' | ')} |${blank}`);
    md.push(`| LCP-елемент — зображення, прогонів | ${cfgs.map((c) => `${byCfg.get(c)._lcpImg} з ${byCfg.get(c)._n}`).join(' | ')} |${blank}`);
    md.push('');
    md.push(`\\* — різниця статистично значуща (p < ${String(ALPHA).replace('.', ',')}).\n`);
  }

  md.push(...extraSections(rows, { label: CFG_LABEL, short }));

  md.push(`## Примітки до методики вимірювань\n`,
    `- LCP фіксується до першої взаємодії (прокручування). Якщо головне зображення не встигло відобразитися, LCP-елементом стає текст і LCP виглядає «кращим» — дивіться рядки «Головне зображення відобразилось» і «LCP-елемент».`,
    `- Якщо в стовпці LCP стоїть «—», Chrome не створив жодного запису LCP до першої взаємодії. Так буває в А на повільній мережі: текст відмальований (є FCP), але, доки великий банер у видимій зоні ще вантажиться, браузер запис LCP не створює, а банер приходить уже після початку прокручування. Для такої конфігурації показовий рядок «Час відображення головного зображення».`,
    `- Час відображення головного зображення — Element Timing API (атрибут elementtiming="hero"); рахується лише в прогонах, де зображення відобразилось.`,
    `- LCP, CLS, INP — бібліотека web-vitals (reportAllChanges); TBT — сума (тривалість − 50 мс) довгих задач після FCP за всю сесію (включно з прокручуванням).`,
    `- Обсяг даних і кількість запитів — за подіями DevTools Protocol, включно зі скасованими запитами; data:/blob: не враховуються.`,
    `- Час до початку відтворення — від моменту, коли відео видно на ≥ 50%, до першої події playing (медіана по відео в прогоні); якщо відео стартувало раніше, ніж стало видимим, береться 0.`);

  await fs.mkdir(RES, { recursive: true });
  await fs.writeFile(path.join(RES, 'summary.md'), md.join('\n'));
  await fs.writeFile(path.join(RES, 'summary.csv'), csv.join('\n'));
  await fs.writeFile(path.join(RES, 'runs.csv'), runsCsv(rows));
  console.log(md.join('\n'));
  console.log(`\n→ results/summary.md, results/summary.csv, results/runs.csv (по рядку на прогін — для графіків)`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
