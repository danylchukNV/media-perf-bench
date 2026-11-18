// Аналіз результатів: медіана, 75-й процентиль, зміна В відносно Б, U-критерій Манна — Уїтні.
// Будує таблицю у форматі «Таблиці 1» з тез для кожної комбінації мережа × пристрій.
//
//   node bench/analyze.mjs                       # останній results/raw-*.jsonl
//   node bench/analyze.mjs results/raw-a.jsonl results/raw-b.jsonl   # об'єднати кілька файлів
//   node bench/analyze.mjs --compare b,b2,c      # останній — що перевіряємо, решта — з чим порівнюємо
//                                                # (за замовчуванням В відносно Б і Б′, які є в даних)

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
const CFG_LABEL = { a: 'А (базова)', b: 'Б (стандартні практики)', b2: 'Б′ (Б + обмеження відео за розміром плеєра)', c: 'В (метод АКПМ)' };
const CFG_SHORT = { a: 'А', b: 'Б', b2: 'Б′', c: 'В' };
const CFG_ORDER = ['a', 'b', 'b2', 'c'];
const short = (c) => CFG_SHORT[c] ?? c.toUpperCase();

// ---------- статистика ----------
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function erf(x) { // Абрамовіц — Стіган 7.1.26
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

/** Двосторонній U-критерій Манна — Уїтні (нормальне наближення з поправками на зв'язки та неперервність). */
function mannWhitney(x, y) {
  const n1 = x.length, n2 = y.length;
  if (n1 < 3 || n2 < 3) return null;
  const all = [...x.map((v) => [v, 0]), ...y.map((v) => [v, 1])].sort((a, b) => a[0] - b[0]);
  const ranks = new Array(all.length);
  let tieSum = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
    const r = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[k] = r;
    const t = j - i + 1;
    tieSum += t ** 3 - t;
    i = j + 1;
  }
  let r1 = 0;
  all.forEach((e, i) => { if (e[1] === 0) r1 += ranks[i]; });
  const U1 = r1 - (n1 * (n1 + 1)) / 2;
  const U = Math.min(U1, n1 * n2 - U1);
  const N = n1 + n2;
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (N + 1 - tieSum / (N * (N - 1))));
  if (sigma === 0) return { U, z: 0, p: 1, r: 0 };
  const z = (Math.abs(U - mu) - 0.5) / sigma;
  const p = Math.min(1, 2 * (1 - normCdf(z)));
  return { U, z, p, r: z / Math.sqrt(N) };
}

const fmt = (v, d) => (v == null || !isFinite(v) ? '—' : v.toFixed(d).replace('.', ','));
const fmtP = (p) => (p == null ? '—' : p < 0.001 ? '< 0,001' : p.toFixed(3).replace('.', ','));

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
      rows.push(r);
    }
  }
  const groups = new Map(); // "net|dev" → cfg → metric → values[]
  for (const r of rows) {
    const g = `${r.network}|${r.device}`;
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
  const csv = ['network,device,metric,config,n,median,p75,change_pct_vs_base,mw_U,mw_p'];

  for (const [g, byCfg] of [...groups.entries()].sort()) {
    const [net, dev] = g.split('|');
    const cfgs = CFG_ORDER.filter((c) => byCfg.has(c)).concat([...byCfg.keys()].filter((c) => !CFG_ORDER.includes(c)));
    const bases = BASES.filter((b) => byCfg.has(b) && b !== TEST);
    const n = Object.fromEntries(cfgs.map((c) => [c, byCfg.get(c)._n]));
    md.push(`## ${net} · ${dev}\n`);
    md.push(`Таблиця — Показники продуктивності тестового застосунку (${net}, ${dev}, медіана; у дужках — 75-й процентиль). Прогонів: ${cfgs.map((c) => `${short(c)} = ${n[c]}`).join(', ')}.\n`);
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
        csv.push([net, dev, m.key, c, vals.length, med[c] ?? '', p75 ?? ''].join(',') + ',,,');
      }
      if (cells.every((c) => c === '—')) continue;
      const y = byCfg.get(TEST)?.[m.key] ?? [];
      for (const b of bases) {
        const x = byCfg.get(b)?.[m.key] ?? [];
        const change = med[b] && med[TEST] != null ? ((med[TEST] - med[b]) / med[b]) * 100 : null;
        const mw = mannWhitney(x, y);
        const sig = mw && mw.p < ALPHA ? ' *' : '';
        cells.push(change == null ? '—' : (change > 0 ? '+' : '') + fmt(change, 1), `${fmtP(mw?.p)}${sig}`);
        csv.push([net, dev, m.key, `${TEST}_vs_${b}`, '', '', '', change ?? '', mw?.U ?? '', mw?.p ?? ''].join(','));
      }
      md.push(`| ${m.label} | ${cells.join(' | ')} |`);
    }
    const blank = ' |'.repeat(bases.length * 2);
    md.push(`| Головне зображення відобразилось за сесію, прогонів | ${cfgs.map((c) => `${byCfg.get(c)._hero} з ${byCfg.get(c)._n}`).join(' | ')} |${blank}`);
    md.push(`| LCP-елемент — зображення, прогонів | ${cfgs.map((c) => `${byCfg.get(c)._lcpImg} з ${byCfg.get(c)._n}`).join(' | ')} |${blank}`);
    md.push('');
    md.push(`\\* — різниця статистично значуща (p < ${String(ALPHA).replace('.', ',')}).\n`);
  }

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
  console.log(md.join('\n'));
  console.log(`\n→ results/summary.md, results/summary.csv`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
