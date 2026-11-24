// Розділи розширеного експерименту для results/summary.md:
//   1) В2 відносно В і Б′ (вдосконалена версія методу);
//   2) абляційний аналіз (внесок кожного компонента В);
//   3) факторний аналіз «мережа × пристрій» (2×2): чи залежить ефект методу від мережі та пристрою;
//   4) діагностика банера: що конкурувало з головним зображенням за канал і як це пов'язано з LCP.
// А також runs.csv — по рядку на прогін, для графіків (box-plot тощо).

import { quantile, mannWhitney, fmt, fmtP, cliffsDelta, cliffLabel, bootstrapChangeCI, holm, spearman } from './stats.mjs';

const ALPHA = 0.05;

// Показники для нових розділів. get — як дістати значення з рядка прогону.
export const XM = {
  lcp: { label: 'LCP, с', get: (r) => r.lcp, f: (v) => v / 1000, d: 2 },
  hero: { label: 'Час відображення головного зображення, с', get: (r) => r.hero, f: (v) => v / 1000, d: 2 },
  inp: { label: 'INP, мс', get: (r) => r.inp, f: (v) => v, d: 0 },
  cls: { label: 'CLS', get: (r) => r.cls, f: (v) => v, d: 3 },
  tbt: { label: 'TBT, мс', get: (r) => r.tbt, f: (v) => v, d: 0 },
  bytes: { label: 'Обсяг даних, МБ', get: (r) => r.bytes, f: (v) => v / 1e6, d: 2 },
  requests: { label: 'Запити', get: (r) => r.requests, f: (v) => v, d: 0 },
  videoTtp: { label: 'Старт відео, с', get: (r) => r.videoTtp, f: (v) => v / 1000, d: 2 },
  videoStalls: { label: 'Зупинки відео', get: (r) => r.videoStalls, f: (v) => v, d: 1 },
  aborts: { label: 'Скасовані запити (АКПМ)', get: (r) => r.akpm?.aborts, f: (v) => v, d: 0 },
  misses: { label: 'Промахи (АКПМ)', get: (r) => r.akpm?.misses, f: (v) => v, d: 0 },
  wastes: { label: 'Марні завантаження (АКПМ)', get: (r) => r.akpm?.wastes, f: (v) => v, d: 0 },
  upgrades: { label: 'Покращення якості (АКПМ)', get: (r) => r.akpm?.upgrades, f: (v) => v, d: 0 },
  heroReqStart: { label: 'Запит банера, мс від старту', get: (r) => r.heroReqStart, f: (v) => v, d: 0 },
  heroReqEnd: { label: 'Банер завантажено, мс від старту', get: (r) => r.heroReqEnd, f: (v) => v, d: 0 },
  heroCompetingBytes: { label: 'Конкуруючі байти під час банера, КБ', get: (r) => r.heroCompetingBytes, f: (v) => v / 1000, d: 0 },
  heroCompetingReqs: { label: 'Конкуруючі запити під час банера', get: (r) => r.heroCompetingReqs, f: (v) => v, d: 0 },
};

const vals = (rows, key) => rows.map((r) => XM[key].get(r)).filter((v) => v != null && isFinite(v)).map(XM[key].f);
const med = (v) => quantile([...v].sort((a, b) => a - b), 0.5);
const sign = (x) => (x > 0 ? '+' : '');
const pct = (x) => (x == null || !isFinite(x) ? '—' : sign(x) + fmt(x, 1));
const where = (layout, scenario) => `${layout === 'feed' ? '' : layout + ' · '}${scenario === 'steady' ? '' : scenario + ' · '}`;

/** rows → Map("layout|scenario|net|dev" → Map(config → rows[])) */
function groupRows(rows) {
  const g = new Map();
  for (const r of rows) {
    const k = `${r.layout}|${r.scenario}|${r.network}|${r.device}`;
    if (!g.has(k)) g.set(k, new Map());
    const m = g.get(k);
    if (!m.has(r.config)) m.set(r.config, []);
    m.get(r.config).push(r);
  }
  return new Map([...g.entries()].sort());
}

/** Порівняння test із base за набором показників: медіани, зміна, ДІ, p, p з поправкою Холма, δ Кліффа. */
function compare(byCfg, test, base, keys) {
  const out = keys.map((k) => {
    const x = vals(byCfg.get(base), k), y = vals(byCfg.get(test), k);
    if (!x.length && !y.length) return null;
    const mx = med(x), my = med(y);
    const mw = mannWhitney(x, y);
    return {
      k, mx, my,
      change: mx && my != null ? ((my - mx) / mx) * 100 : null,
      ci: mx ? bootstrapChangeCI(x, y) : null,
      p: mw?.p ?? null,
      delta: cliffsDelta(x, y),
    };
  }).filter(Boolean);
  const adj = holm(out.map((o) => o.p));
  out.forEach((o, i) => { o.pHolm = adj[i]; });
  return out;
}

function pairSection(groups, test, base, short) {
  const md = [];
  for (const [g, byCfg] of groups) {
    if (!byCfg.has(test) || !byCfg.has(base)) continue;
    const [layout, scenario, net, dev] = g.split('|');
    const keys = ['lcp', 'hero', 'inp', 'cls', 'tbt', 'bytes', 'requests', 'videoTtp', 'videoStalls', 'aborts', 'misses', 'wastes', 'upgrades'];
    const res = compare(byCfg, test, base, keys);
    md.push(`### ${where(layout, scenario)}${net} · ${dev}: ${short(test)} відносно ${short(base)}\n`);
    md.push(`Прогонів: ${short(base)} = ${byCfg.get(base).length}, ${short(test)} = ${byCfg.get(test).length}.\n`);
    md.push(`| Показник | ${short(base)} | ${short(test)} | Зміна, % | 95% ДІ зміни, % | p | p (Холм) | δ Кліффа |`);
    md.push('|---|---|---|---|---|---|---|---|');
    for (const o of res) {
      const m = XM[o.k];
      const ci = o.ci ? `[${pct(o.ci[0])}; ${pct(o.ci[1])}]` : '—';
      const sig = o.pHolm != null && o.pHolm < ALPHA ? ' *' : '';
      const d = o.delta == null ? '—' : `${fmt(o.delta, 2)} (${cliffLabel(o.delta)})`;
      md.push(`| ${m.label} | ${fmt(o.mx, m.d)} | ${fmt(o.my, m.d)} | ${pct(o.change)} | ${ci} | ${fmtP(o.p)} | ${fmtP(o.pHolm)}${sig} | ${d} |`);
    }
    md.push('');
  }
  return md;
}

function ablationSection(groups, short) {
  const md = [];
  const KEYS = ['lcp', 'hero', 'bytes', 'requests', 'videoTtp', 'inp', 'aborts', 'misses', 'wastes', 'upgrades'];
  for (const [g, byCfg] of groups) {
    const ORDER = ['c-no-pred', 'c-no-qual', 'c-no-abort', 'c-no-fb'];
    const abl = [...byCfg.keys()].filter((c) => /^c-no-/.test(c))
      .sort((x, y) => (ORDER.indexOf(x) + 1 || 99) - (ORDER.indexOf(y) + 1 || 99) || x.localeCompare(y));
    if (!byCfg.has('c') || !abl.length) continue;
    const [layout, scenario, net, dev] = g.split('|');
    // Одне сімейство порівнянь на таблицю: поправка Холма — по всіх клітинках разом
    const cells = abl.map((c) => compare(byCfg, c, 'c', KEYS));
    const adj = holm(cells.flat().map((o) => o.p));
    let i = 0;
    for (const res of cells) for (const o of res) o.pHolm = adj[i++];
    md.push(`### ${where(layout, scenario)}${net} · ${dev}\n`);
    md.push(`Медіана; у дужках — зміна відносно повного методу В, %. * — значуще після поправки Холма для всієї таблиці (p < ${String(ALPHA).replace('.', ',')}).\n`);
    md.push(`| Варіант | n | ${KEYS.map((k) => XM[k].label).join(' | ')} |`);
    md.push(`|${'---|'.repeat(KEYS.length + 2)}`);
    md.push(`| В (повний) | ${byCfg.get('c').length} | ${KEYS.map((k) => fmt(med(vals(byCfg.get('c'), k)), XM[k].d)).join(' | ')} |`);
    abl.forEach((c, j) => {
      const by = Object.fromEntries(cells[j].map((o) => [o.k, o]));
      const row = KEYS.map((k) => {
        const o = by[k];
        if (!o) return '—';
        return `${fmt(o.my, XM[k].d)} (${pct(o.change)})${o.pHolm != null && o.pHolm < ALPHA ? ' *' : ''}`;
      });
      md.push(`| ${c} | ${byCfg.get(c).length} | ${row.join(' | ')} |`);
    });
    if (byCfg.has('b2')) {
      md.push(`| Б′ (довідково) | ${byCfg.get('b2').length} | ${KEYS.map((k) => fmt(med(vals(byCfg.get('b2'), k)), XM[k].d)).join(' | ')} |`);
    }
    md.push('');
  }
  if (md.length) {
    md.unshift('Варіанти: c-no-pred — без прогнозу за прокручуванням; c-no-qual — без вибору якості (завжди ідеальна роздільність); c-no-abort — без скасування запитів; c-no-fb — без зворотного зв\'язку. Якщо вимкнення компонента погіршує показник, саме цей компонент дає виграш; якщо покращує обсяг або запити — компонент і є джерелом надлишкового трафіку.\n');
  }
  return md;
}

function factorialSection(rows, short) {
  const md = [];
  const KEYS = ['lcp', 'hero', 'bytes', 'requests', 'inp', 'tbt', 'videoTtp'];
  const byLS = new Map();
  for (const r of rows) {
    const k = `${r.layout}|${r.scenario}`;
    if (!byLS.has(k)) byLS.set(k, []);
    byLS.get(k).push(r);
  }
  for (const [ls, rs] of [...byLS.entries()].sort()) {
    const nets = [...new Set(rs.map((r) => r.network))].sort();
    const devs = [...new Set(rs.map((r) => r.device))].sort();
    if (nets.length < 2 || devs.length < 2) continue;
    // повний факторний план: кожна клітинка має містити і базову, і перевірювану конфігурацію
    const cells = nets.flatMap((n) => devs.map((d) => [n, d]));
    const cfgs = ['b', 'b2', 'c', 'c2'].filter((c) => cells.every(([n, d]) => rs.some((r) => r.config === c && r.network === n && r.device === d)));
    if (cfgs.length < 2) continue;
    const [layout, scenario] = ls.split('|');
    const pick = (c, n, d) => rs.filter((r) => r.config === c && r.network === n && r.device === d);
    md.push(`### ${where(layout, scenario) || 'стрічка · '}мережа × пристрій\n`);
    for (const k of KEYS) {
      const m = XM[k];
      if (!cfgs.some((c) => cells.some(([n, d]) => vals(pick(c, n, d), k).length))) continue;
      md.push(`**${m.label}** — медіани\n`);
      md.push(`| Конфігурація | ${cells.map(([n, d]) => `${n} × ${d}`).join(' | ')} |`);
      md.push(`|${'---|'.repeat(cells.length + 1)}`);
      for (const c of cfgs) md.push(`| ${short(c)} | ${cells.map(([n, d]) => fmt(med(vals(pick(c, n, d), k)), m.d)).join(' | ')} |`);
      md.push('');
    }
    // Ефект методу по клітинках: якщо зміна однакова в усіх клітинках — ефект не залежить від мережі/пристрою
    // Як у тезі 3: метод порівнюється і з Б, і з Б′ (якщо вони є в плані)
    const bases = ['b', 'b2'].filter((c) => cfgs.includes(c));
    const pairs = bases.flatMap((base) => cfgs.filter((c) => c === 'c' || c === 'c2').map((test) => [test, base]));
    for (const [test, base] of pairs) {
      md.push(`**Ефект ${short(test)} відносно ${short(base)} по клітинках** (зміна медіани, %; p — U-критерій, поправка Холма за всією таблицею)\n`);
      md.push(`| Показник | ${cells.map(([n, d]) => `${n} × ${d}`).join(' | ')} |`);
      md.push(`|${'---|'.repeat(cells.length + 1)}`);
      const fam = [];
      const table = KEYS.map((k) => cells.map(([n, d]) => {
        const x = vals(pick(base, n, d), k), y = vals(pick(test, n, d), k);
        const mx = med(x), my = med(y);
        const p = mannWhitney(x, y)?.p ?? null;
        fam.push(p);
        return { change: mx && my != null ? ((my - mx) / mx) * 100 : null, p };
      }));
      const adj = holm(fam);
      let i = 0;
      KEYS.forEach((k, ki) => {
        const row = table[ki].map((c) => {
          const pa = adj[i++];
          return c.change == null ? '—' : `${pct(c.change)}${pa != null && pa < ALPHA ? ' *' : ''} (p = ${fmtP(pa)})`;
        });
        if (row.every((x) => x === '—')) return;
        md.push(`| ${XM[k].label} | ${row.join(' | ')} |`);
      });
      md.push('');
    }
  }
  if (md.length) {
    md.unshift('Порівняння по клітинках відокремлює вплив мережі від впливу пристрою (у тезі 3 вони змінювалися одночасно). Читати так: у рядку однієї мережі різниця між пристроями — ефект пристрою; у стовпці одного пристрою різниця між мережами — ефект мережі.\n');
  }
  return md;
}

function heroSection(groups, short) {
  const md = [];
  const KEYS = ['hero', 'heroReqStart', 'heroReqEnd', 'heroCompetingBytes', 'heroCompetingReqs'];
  for (const [g, byCfg] of groups) {
    const cfgs = [...byCfg.keys()].filter((c) => byCfg.get(c).some((r) => r.heroCompetingBytes != null));
    if (!cfgs.length) continue;
    const order = ['a', 'b', 'b2', 'c', 'c2'];
    cfgs.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
    const [layout, scenario, net, dev] = g.split('|');
    md.push(`### ${where(layout, scenario)}${net} · ${dev}\n`);
    md.push(`| Конфігурація | ${KEYS.map((k) => XM[k].label).join(' | ')} | ρ Спірмена (LCP ↔ конкуруючі байти) |`);
    md.push(`|${'---|'.repeat(KEYS.length + 2)}`);
    for (const c of cfgs) {
      const rs = byCfg.get(c);
      const pairs = rs.filter((r) => r.lcp != null && r.heroCompetingBytes != null);
      const rho = spearman(pairs.map((r) => r.lcp), pairs.map((r) => r.heroCompetingBytes));
      md.push(`| ${short(c)} | ${KEYS.map((k) => fmt(med(vals(rs, k)), XM[k].d)).join(' | ')} | ${rho == null ? '—' : fmt(rho, 2)} |`);
    }
    md.push('');
  }
  if (md.length) {
    md.unshift('Медіани. Конкуруючі байти — скільки даних інших запитів надійшло, поки завантажувався банер. Додатний ρ означає: що більше паралельного трафіку, то пізніше LCP. Це перевірка гіпотези про причину нестабільного LCP у В.\n');
  }
  return md;
}

/** Нові розділи summary.md (порожній масив, якщо в даних немає відповідних конфігурацій). */
export function extraSections(rows, { short }) {
  const groups = groupRows(rows);
  const md = [];
  const add = (title, body) => { if (body.length) md.push(`## ${title}\n`, ...body); };
  add('Версія В2 відносно В', pairSection(groups, 'c2', 'c', short));
  add('Версія В2 відносно Б′', pairSection(groups, 'c2', 'b2', short));
  add('Абляційний аналіз методу В', ablationSection(groups, short));
  add('Факторний аналіз: мережа × пристрій', factorialSection(rows, short));
  add('Діагностика: конкуренція за канал під час завантаження банера', heroSection(groups, short));
  if (md.length) {
    md.push('Позначення: ДІ — 95% перцентильний bootstrap-інтервал для зміни медіани (2000 повторних вибірок); p (Холм) — з поправкою Холма — Бонферроні в межах таблиці; * — значуще після поправки. δ Кліффа: |δ| < 0,147 — дуже малий ефект, < 0,33 — малий, < 0,474 — середній, інакше великий.\n');
  }
  return md;
}

/** По рядку на прогін — для графіків (Python/Excel). */
export function runsCsv(rows) {
  const cols = ['layout', 'scenario', 'network', 'device', 'config', 'run', 'lcp', 'hero', 'fcp', 'ttfb', 'inp', 'cls', 'tbt',
    'bytes', 'requests', 'videoTtp', 'videosPlayed', 'videoStalls', 'loadMs', 'sessionMs',
    'heroReqStart', 'heroReqEnd', 'heroCompetingBytes', 'heroCompetingReqs',
    'akpm_loads', 'akpm_upgrades', 'akpm_aborts', 'akpm_misses', 'akpm_wastes', 'akpm_prefetchSkips', 'akpm_jumps', 'akpm_horizonMs', 'akpm_kbps', 'lcpEl'];
  const val = (r, c) => {
    const v = c.startsWith('akpm_') ? r.akpm?.[c.slice(5)] : r[c];
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => val(r, c)).join(','))].join('\n') + '\n';
}
