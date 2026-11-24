// Генерує сторінки з однаковим вмістом і різними стратегіями завантаження.
//
// Конфігурації: A — базова (без оптимізації), B — стандартні практики, B′ (b2) — B + обмеження відео
// за розміром плеєра, C — метод АКПМ (версія тези 3), C2 — версія В2, c-no-* — абляції В.
//
// Макети:
//   feed     — стрічка тези 3:            /a, /b, /b2, /c, /c2, /c-no-pred …
//   gallery  — сітка-мозаїка зображень:    /gallery/<конфігурація>
//   infinite — нескінченна стрічка:       /infinite/<конфігурація>
//   video    — відеосторінка:              /video/<конфігурація>
//
// Запуск: node scripts/build-pages.mjs [--cv]   (--cv: увімкнути content-visibility у варіантах АКПМ)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../bench.config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'pages');
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'public', 'media', 'manifest.json'), 'utf8'));
const useCV = process.argv.includes('--cv');

const imgIds = Object.keys(manifest.images);
const vidIds = Object.keys(manifest.videos);
const heroId = imgIds[0];
const feedIds = imgIds.slice(1);

const HERO_SIZES = '(min-width: 1240px) 1200px, 100vw';
const CARD_SIZES = '(min-width: 1240px) 390px, (min-width: 900px) 31vw, 100vw';
const TILE_SIZES = '(min-width: 1240px) 236px, (min-width: 900px) 19vw, 50vw';
const VCARD_SIZES = '(min-width: 1240px) 590px, (min-width: 900px) 48vw, 100vw';

const captions = [
  'Вечірнє місто з висоти пташиного польоту',
  'Ранковий туман над рікою',
  'Архітектурні деталі старого кварталу',
  'Світлові інсталяції фестивалю',
  'Гірський перевал після дощу',
  'Вулична фотографія: ритм міста',
  'Мінімалізм у природних формах',
  'Нічне небо за містом',
];

// ---------- Копії медіа: «img-007~1» — той самий файл під окремим URL (сервер прибирає «~N») ----------

const baseId = (id) => id.split('~')[0];
const img = (id) => manifest.images[baseId(id)];
const vid = (id) => {
  const v = manifest.videos[baseId(id)];
  if (id === baseId(id)) return v;
  const from = `/media/video/${baseId(id)}/`, to = `/media/video/${id}/`;
  return { ...v, master: v.master.replace(from, to), mp4: v.mp4.replace(from, to), poster: v.poster.replace(from, to) };
};
/** n ідентифікаторів по колу; повтори отримують суфікс ~1, ~2, … */
const cycle = (ids, n) => Array.from({ length: n }, (_, i) => {
  const k = Math.floor(i / ids.length);
  return k ? `${ids[i % ids.length]}~${k}` : ids[i % ids.length];
});

const media = (id, w, ext) => `/media/img/${id}/${w}.${ext}`;
const srcset = (id, fmt, ext) =>
  Object.keys(img(id).variants[fmt]).map((w) => `${media(id, w, ext)} ${w}w`).join(', ');

// ---------- Розмітка медіа для кожної конфігурації ----------

const A = {
  hero: (id) => `<img class="hero-img" src="/media/img/${id}/orig.jpg" elementtiming="hero" alt="Головне зображення">`,
  img: (id) => `<img src="/media/img/${id}/orig.jpg" alt="">`,
  video: (id) => {
    const v = vid(id);
    return `<video src="${v.mp4}" autoplay muted loop playsinline preload="auto"></video>`;
  },
  head: '',
  tail: '',
};

const picture = (id, sizes, extra) => {
  const e = img(id);
  return `<picture>
      <source type="image/avif" srcset="${srcset(id, 'avif', 'avif')}" sizes="${sizes}">
      <source type="image/webp" srcset="${srcset(id, 'webp', 'webp')}" sizes="${sizes}">
      <img srcset="${srcset(id, 'jpeg', 'jpg')}" sizes="${sizes}" src="${media(id, 960, 'jpg')}" width="${e.w}" height="${e.h}" ${extra} alt="">
    </picture>`;
};

// Б і Б′ відрізняються лише налаштуваннями hls.js: Б — за замовчуванням,
// Б′ — з capLevelToPlayerSize (рівень не вище за розмір плеєра), тобто суворіша базова лінія.
const makeB = (hlsConfig = {}) => ({
  hero: (id) => picture(id, HERO_SIZES, 'class="hero-img" elementtiming="hero" fetchpriority="high" decoding="async"'),
  img: (id, sizes = CARD_SIZES) => picture(id, sizes, 'loading="lazy" decoding="async"'),
  video: (id) => {
    const v = vid(id);
    return `<video class="lazy-video" data-src="${v.master}" poster="${v.poster}" preload="none" muted loop playsinline width="${v.w}" height="${v.h}"></video>`;
  },
  head: '',
  // dynamic — сторінка додає відео після завантаження (нескінченна стрічка): спостерігаємо і за новими
  tail: (ctx) => `<script src="/vendor/hls.min.js" defer></script>
<script>
// Стандартна практика: hls.js з defer, HLS (ABR hls.js за замовчуванням) підключається і відтворюється,
// коли відео видно на 50%
function attach(v) {
  if (window.Hls && Hls.isSupported()) { const h = new Hls(${JSON.stringify(hlsConfig)}); h.loadSource(v.dataset.src); h.attachMedia(v); }
  else if (v.canPlayType('application/vnd.apple.mpegurl')) v.src = v.dataset.src;
  else return false;
  return true;
}
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const v = e.target;
    if (e.isIntersecting) {
      v._want = true;
      if (!v._attached) v._attached = attach(v);
      if (v._attached) v.play().catch(() => {});
    } else { v._want = false; v.pause(); }
  }
}, { threshold: 0.5 });
document.querySelectorAll('video.lazy-video').forEach((v) => io.observe(v));
window.addEventListener('DOMContentLoaded', () => document.querySelectorAll('video.lazy-video').forEach((v) => {
  if (v._want && !v._attached) { v._attached = attach(v); if (v._attached) v.play().catch(() => {}); }
}));${ctx?.dynamic ? `
new MutationObserver(() => document.querySelectorAll('video.lazy-video:not([data-io])').forEach((v) => { v.dataset.io = '1'; io.observe(v); }))
  .observe(document.body, { childList: true, subtree: true });
document.querySelectorAll('video.lazy-video').forEach((v) => { v.dataset.io = '1'; });` : ''}
</script>`,
});
const B = makeB();
const B2 = makeB({ capLevelToPlayerSize: true });

/** Варіант методу АКПМ. initExtra — додаткові параметри AKPM.init (В2, абляції). */
const makeC = (initExtra = null) => ({
  hero: (id) => picture(id, HERO_SIZES, 'class="hero-img" elementtiming="hero" data-akpm-hero fetchpriority="high" decoding="async"'),
  img: (id) => {
    const e = img(id);
    return `<img class="akpm" data-akpm-id="${id}" data-akpm-importance="0" width="${e.w}" height="${e.h}" src="${e.lqip}" alt="">`;
  },
  video: (id) => {
    const v = vid(id);
    return `<video data-akpm-video="${id}" muted loop playsinline width="${v.w}" height="${v.h}"></video>`;
  },
  head: `<style>
  img.akpm { filter: blur(14px); transform: scale(1.02); transition: filter .25s ease; }
  img.akpm.akpm-loaded { filter: none; transform: none; }
  ${useCV ? '.card { content-visibility: auto; contain-intrinsic-size: auto 520px; }' : ''}
</style>`,
  tail: (ctx) => {
    // У маніфест сторінки потрапляє лише потрібне (без LQIP — вони вже в розмітці)
    const slim = {
      widths: manifest.widths,
      probe: manifest.probe,
      images: Object.fromEntries(ctx.imageIds.map((id) => {
        const { lqip, ...rest } = img(id);
        return [id, { ...rest, lqip: '' }];
      })),
      videos: Object.fromEntries(ctx.videoIds.map((id) => [id, vid(id)])),
    };
    const extra = initExtra ? `, ...${JSON.stringify(initExtra)}` : '';
    return `<script src="/akpm.js"></script>
<script id="akpm-manifest" type="application/json">${JSON.stringify(slim)}</script>
<script>
  AKPM.init({ manifest: JSON.parse(document.getElementById('akpm-manifest').textContent), persist: true${extra} });
</script>`;
  },
});
const C = makeC();

// ---------- Перелік конфігурацій ----------

const CONFIGS = {
  a: { title: 'A — базова', s: A },
  b: { title: 'B — стандартні практики', s: B },
  b2: { title: 'B′ — стандартні практики + обмеження відео за розміром плеєра', s: B2 },
  c: { title: 'C — метод АКПМ', s: C },
  c2: { title: 'C2 — метод АКПМ, версія В2', s: makeC({ variant: 'c2', ...config.akpm.v2 }) },
};
for (const [name, disable] of Object.entries(config.akpm.ablations)) {
  CONFIGS[name] = { title: `${name} — абляція В (вимкнено: ${disable.join(', ')})`, s: makeC({ variant: name, disable }) };
}

// ---------- Спільний шаблон ----------

const css = `
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #1d1d1f; background: #f4f4f6; }
  header { position: sticky; top: 0; z-index: 10; background: #fff; border-bottom: 1px solid #e3e3e8; padding: 12px 20px; font-weight: 600; }
  main { max-width: 1200px; margin: 0 auto; padding: 16px; }
  .hero img, .hero picture { display: block; width: 100%; height: auto; border-radius: 12px; }
  .hero h1 { font-size: 28px; margin: 16px 0 8px; }
  .feed { display: grid; grid-template-columns: 1fr; gap: 16px; margin-top: 24px; }
  @media (min-width: 900px) { .feed { grid-template-columns: repeat(3, 1fr); } }
  .card { background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
  .card img, .card picture, .card video { display: block; width: 100%; height: auto; background: #dcdce2; }
  .card video { aspect-ratio: 16 / 9; }
  .card .meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; }
  .card p { margin: 0; font-size: 14px; }
  .like { border: 1px solid #d0d0d8; background: #fff; border-radius: 999px; padding: 4px 10px; cursor: pointer; font-size: 14px; }
  .like[aria-pressed="true"] { background: #ffe8ec; border-color: #ff8fa3; }
  footer { text-align: center; color: #777; padding: 40px 0; }
`;

// Додаткові стилі нових макетів (у стрічку не потрапляють — її розмітка лишається як у тезі 3)
const layoutCss = {
  gallery: `
  .gallery { display: grid; grid-template-columns: repeat(2, 1fr); grid-auto-rows: 8px; gap: 6px; margin-top: 24px; }
  @media (min-width: 900px) { .gallery { grid-template-columns: repeat(5, 1fr); } }
  .tile { position: relative; margin: 0; border-radius: 8px; overflow: hidden; background: #dcdce2; }
  .tile img, .tile picture { display: block; width: 100%; height: 100%; object-fit: cover; }
  .tile .like { position: absolute; right: 6px; bottom: 6px; padding: 2px 8px; font-size: 12px; }`,
  infinite: `
  #sentinel { height: 1px; }
  .loading { text-align: center; color: #777; padding: 16px; }`,
  video: `
  .vgrid { display: grid; grid-template-columns: 1fr; gap: 16px; margin-top: 24px; }
  @media (min-width: 900px) { .vgrid { grid-template-columns: repeat(2, 1fr); } }`,
};

const likeScript = `<script>
document.addEventListener('click', (e) => {
  const b = e.target.closest('.like');
  if (!b) return;
  const on = b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', String(on));
  const n = b.querySelector('span');
  n.textContent = String(Number(n.textContent) + (on ? 1 : -1));
});
</script>`;

// ---------- Вміст макетів ----------

/** Картки стрічки: зображення, після кожних videoEvery — відео. Повертає розмітку і використані id. */
function feedCards(s, ids, vids, offset = 0) {
  const cards = [];
  const usedVids = [];
  let v = 0;
  ids.forEach((id, j) => {
    const i = j + offset;
    cards.push(`<article class="card">${s.img(id)}
    <div class="meta"><p>${captions[i % captions.length]}</p><button class="like" aria-pressed="false">♡ <span>${(i * 7) % 50 + 3}</span></button></div></article>`);
    if ((j + 1) % config.media.videoEvery === 0 && v < vids.length) {
      const vidId = vids[v++];
      usedVids.push(vidId);
      cards.push(`<article class="card video-card">${s.video(vidId)}
    <div class="meta"><p>Відео ${v}</p><button class="like" aria-pressed="false">♡ <span>${v * 11}</span></button></div></article>`);
    }
  });
  return { cards, usedVids };
}

const heroSection = (s) => `<section class="hero">${s.hero(heroId)}
    <h1>Галерея тижня</h1>
    <p>Тестовий застосунок для дослідження продуктивності вебзастосунків із високоінтенсивним мультимедійним контентом.</p>
  </section>`;

function feedLayout(s) {
  const { cards, usedVids } = feedCards(s, feedIds, vidIds);
  return {
    body: `<section class="feed">
  ${cards.join('\n  ')}
  </section>`,
    imageIds: feedIds, videoIds: vidIds, usedVids,
  };
}

function galleryLayout(s) {
  const ids = cycle(feedIds, config.layouts.gallery.items);
  // Мозаїка без JS: висота плитки (кількість рядків по 8 px + 6 px проміжку) — за пропорціями фото
  const tiles = ids.map((id, i) => {
    const e = img(id);
    const span = Math.max(8, Math.round((220 * (e.h / e.w) + 6) / 14));
    const like = i % 6 === 2 ? `<button class="like" aria-pressed="false">♡ <span>${(i * 7) % 50 + 3}</span></button>` : '';
    return `<figure class="tile" style="grid-row: span ${span}">${s.img(id, TILE_SIZES)}${like}</figure>`;
  });
  return {
    body: `<section class="gallery">
  ${tiles.join('\n  ')}
  </section>`,
    imageIds: ids, videoIds: [], usedVids: [],
  };
}

/** Нескінченна стрічка: перші картки в HTML, решта — фрагментами /pages/infinite/<cfg>/<n>.html */
function infiniteLayout(s, name) {
  const L = config.layouts.infinite;
  const ids = cycle(feedIds, feedIds.length * L.laps);
  const vids = cycle(vidIds, vidIds.length * L.laps);
  const { cards, usedVids } = feedCards(s, ids, vids);
  const first = cards.slice(0, L.initialCards);
  const parts = [];
  for (let i = L.initialCards; i < cards.length; i += L.batch) parts.push(cards.slice(i, i + L.batch).join('\n  '));
  const script = `<script>
// Довантаження наступної порції, коли до кінця лишається менше одного екрана (як запит до API)
(() => {
  const feed = document.querySelector('.feed'), sentinel = document.getElementById('sentinel');
  const total = ${parts.length};
  let next = 1, busy = false;
  const io = new IntersectionObserver(async (entries) => {
    if (busy || next > total || !entries.some((e) => e.isIntersecting)) return;
    busy = true;
    try {
      const r = await fetch('/pages/infinite/${name}/' + next + '.html');
      feed.insertAdjacentHTML('beforeend', await r.text());
      next++;
    } finally { busy = false; }
    io.unobserve(sentinel);
    if (next > total) { sentinel.remove(); return; }
    io.observe(sentinel); // повторна перевірка: якщо маркер досі видно, вантажимо ще
  }, { rootMargin: '0px 0px 100% 0px' });
  io.observe(sentinel);
})();
</script>`;
  return {
    body: `<section class="feed">
  ${first.join('\n  ')}
  </section>
  <div id="sentinel"></div>`,
    imageIds: ids, videoIds: vids, usedVids, parts, script, dynamic: true,
  };
}

function videoLayout(s) {
  const L = config.layouts.video;
  const vids = cycle(vidIds, L.videos);
  const imgs = cycle(feedIds, Math.ceil(L.videos / L.imageEvery));
  const cards = [];
  vids.forEach((id, i) => {
    cards.push(`<article class="card video-card">${s.video(id)}
    <div class="meta"><p>Відео ${i + 1}</p><button class="like" aria-pressed="false">♡ <span>${(i + 1) * 11}</span></button></div></article>`);
    if ((i + 1) % L.imageEvery === 0) {
      const id = imgs[(i + 1) / L.imageEvery - 1];
      cards.push(`<article class="card">${s.img(id, VCARD_SIZES)}
    <div class="meta"><p>${captions[i % captions.length]}</p><button class="like" aria-pressed="false">♡ <span>${(i * 7) % 50 + 3}</span></button></div></article>`);
    }
  });
  return {
    body: `<section class="vgrid">
  ${cards.join('\n  ')}
  </section>`,
    imageIds: imgs, videoIds: vids, usedVids: vids,
  };
}

const LAYOUTS = { feed: feedLayout, gallery: galleryLayout, infinite: infiniteLayout, video: videoLayout };
const LAYOUT_TITLE = { feed: 'Медіастрічка', gallery: 'Галерея', infinite: 'Нескінченна стрічка', video: 'Відео' };

function page(layout, name, title, s) {
  const L = LAYOUTS[layout](s, name);
  const tail = typeof s.tail === 'function' ? s.tail(L) : s.tail;
  const extraCss = layoutCss[layout] ?? '';
  return {
    html: `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${css}${extraCss}</style>
${s.head}
</head>
<body data-config="${name}"${layout === 'feed' ? '' : ` data-layout="${layout}"`}>
<header>${LAYOUT_TITLE[layout]} · конфігурація ${name.toUpperCase()}</header>
<main>
  ${heroSection(s)}
  ${L.body}
</main>
<footer>Кінець стрічки</footer>
${likeScript}
${L.script ?? ''}${tail}
</body>
</html>
`,
    parts: L.parts ?? [],
    stats: { images: L.imageIds.length + 1, videos: L.usedVids.length },
  };
}

// ---------- Запис ----------

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });
const links = {};
const summary = {};
for (const layout of Object.keys(LAYOUTS)) {
  links[layout] = [];
  for (const [name, { title, s }] of Object.entries(CONFIGS)) {
    const p = page(layout, name, layout === 'feed' ? title : `${LAYOUT_TITLE[layout]} · ${title}`, s);
    // Стрічка — у корені (/a, /b, …), як у тезі 3; інші макети — у підпапках (/gallery/c)
    const file = layout === 'feed' ? path.join(OUT, `${name}.html`) : path.join(OUT, layout, `${name}.html`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, p.html);
    if (p.parts.length) {
      const dir = path.join(OUT, layout, name);
      await fs.mkdir(dir, { recursive: true });
      for (const [i, part] of p.parts.entries()) await fs.writeFile(path.join(dir, `${i + 1}.html`), part);
    }
    links[layout].push(`<li><a href="${layout === 'feed' ? '' : '/' + layout}/${name}">${title}</a></li>`);
    summary[layout] = p.stats;
  }
}
await fs.writeFile(path.join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Стенд</title>
<h1>Тестовий стенд</h1>
${Object.entries(links).map(([l, li]) => `<h2>${LAYOUT_TITLE[l]}</h2><ul>${li.join('')}</ul>`).join('\n')}`);

console.log(`Сторінки згенеровано: ${Object.keys(CONFIGS).length} конфігурацій × ${Object.keys(LAYOUTS).length} макети${useCV ? ', content-visibility увімкнено' : ''}`);
for (const [l, st] of Object.entries(summary)) console.log(`  ${l.padEnd(9)} ${st.images} зображень, ${st.videos} відео`);
