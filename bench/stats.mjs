// Статистичні функції стенда: квантилі, U-критерій Манна — Уїтні, δ Кліффа, bootstrap-інтервали,
// поправка Холма, ранговий коефіцієнт Спірмена.

export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function erf(x) { // Абрамовіц — Стіган 7.1.26
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
export const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

/** Двосторонній U-критерій Манна — Уїтні (нормальне наближення з поправками на зв'язки та неперервність). */
export function mannWhitney(x, y) {
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

export const fmt = (v, d) => (v == null || !isFinite(v) ? '—' : v.toFixed(d).replace('.', ','));
export const fmtP = (p) => (p == null ? '—' : p < 0.001 ? '< 0,001' : p.toFixed(3).replace('.', ','));

/** δ Кліффа: P(y > x) − P(y < x); |δ| < 0,147 — дуже малий, < 0,33 — малий, < 0,474 — середній, інакше великий ефект. */
export function cliffsDelta(x, y) {
  if (!x.length || !y.length) return null;
  let gt = 0, lt = 0;
  for (const b of y) for (const a of x) { if (b > a) gt++; else if (b < a) lt++; }
  return (gt - lt) / (x.length * y.length);
}
export const cliffLabel = (d) => d == null ? '' : Math.abs(d) < 0.147 ? 'дуже малий' : Math.abs(d) < 0.33 ? 'малий' : Math.abs(d) < 0.474 ? 'середній' : 'великий';

/** Детермінований генератор (mulberry32), щоб інтервали відтворювалися від запуску до запуску. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const median = (v) => quantile([...v].sort((a, b) => a - b), 0.5);

/**
 * 95% bootstrap-інтервал (перцентильний) для зміни медіани y відносно x, %.
 * Повертає [нижня, верхня] або null, якщо даних замало.
 */
export function bootstrapChangeCI(x, y, iters = 2000, seed = 12345) {
  if (x.length < 3 || y.length < 3) return null;
  const r = rng(seed);
  const pick = (v) => Array.from({ length: v.length }, () => v[Math.floor(r() * v.length)]);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const mx = median(pick(x));
    if (!mx) continue;
    out.push(((median(pick(y)) - mx) / mx) * 100);
  }
  if (out.length < iters / 2) return null;
  out.sort((a, b) => a - b);
  return [quantile(out, 0.025), quantile(out, 0.975)];
}

/** Поправка Холма — Бонферроні для сімейства p-значень (null пропускаються). */
export function holm(ps) {
  const idx = ps.map((p, i) => [p, i]).filter(([p]) => p != null).sort((a, b) => a[0] - b[0]);
  const m = idx.length;
  const adj = new Array(ps.length).fill(null);
  let prev = 0;
  idx.forEach(([p, i], k) => {
    prev = Math.max(prev, Math.min(1, (m - k) * p));
    adj[i] = prev;
  });
  return adj;
}

/** Ранговий коефіцієнт кореляції Спірмена (з усередненими рангами для зв'язків). */
export function spearman(x, y) {
  const n = x.length;
  if (n < 5) return null;
  const rank = (v) => {
    const o = v.map((a, i) => [a, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n);
    for (let i = 0; i < n;) {
      let j = i;
      while (j + 1 < n && o[j + 1][0] === o[i][0]) j++;
      for (let k = i; k <= j; k++) r[o[k][1]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(x), ry = rank(y);
  const mx = (n + 1) / 2;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - mx); dx += (rx[i] - mx) ** 2; dy += (ry[i] - mx) ** 2; }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}
