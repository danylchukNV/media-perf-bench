// Генерує три сторінки з однаковим вмістом і різними стратегіями завантаження:
//   A — базова (без оптимізації), B — стандартні практики, C — метод АКПМ.
// Запуск: node scripts/build-pages.mjs [--cv]   (--cv: увімкнути content-visibility у конфігурації C)

import fs from 'node:fs/promises';
import path from 'node:path';
import config from '../bench.config.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'public', 'pages');
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'public', 'media', 'manifest.json'), 'utf8'));
const useCV = process.argv.includes('--cv');

const imgIds = Object.keys(manifest.images);
const vidIds = Object.keys(manifest.videos);
const heroId = imgIds[0];
const feedIds = imgIds.slice(1);

const HERO_SIZES = '(min-width: 1240px) 1200px, 100vw';
const CARD_SIZES = '(min-width: 1240px) 390px, (min-width: 900px) 31vw, 100vw';

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

const media = (id, w, ext) => `/media/img/${id}/${w}.${ext}`;
const srcset = (id, fmt, ext) =>
  Object.keys(manifest.images[id].variants[fmt]).map((w) => `${media(id, w, ext)} ${w}w`).join(', ');

// ---------- Розмітка медіа для кожної конфігурації ----------

const A = {
  hero: (id) => `<img class="hero-img" src="/media/img/${id}/orig.jpg" elementtiming="hero" alt="Головне зображення">`,
  img: (id) => `<img src="/media/img/${id}/orig.jpg" alt="">`,
  video: (id) => {
    const v = manifest.videos[id];
    return `<video src="${v.mp4}" autoplay muted loop playsinline preload="auto"></video>`;
  },
  head: '',
  tail: '',
};

const picture = (id, sizes, extra) => {
  const e = manifest.images[id];
  return `<picture>
      <source type="image/avif" srcset="${srcset(id, 'avif', 'avif')}" sizes="${sizes}">
      <source type="image/webp" srcset="${srcset(id, 'webp', 'webp')}" sizes="${sizes}">
      <img srcset="${srcset(id, 'jpeg', 'jpg')}" sizes="${sizes}" src="${media(id, 960, 'jpg')}" width="${e.w}" height="${e.h}" ${extra} alt="">
    </picture>`;
};

const B = {
  hero: (id) => picture(id, HERO_SIZES, 'class="hero-img" elementtiming="hero" fetchpriority="high" decoding="async"'),
  img: (id) => picture(id, CARD_SIZES, 'loading="lazy" decoding="async"'),
  video: (id) => {
    const v = manifest.videos[id];
    return `<video class="lazy-video" data-src="${v.master}" poster="${v.poster}" preload="none" muted loop playsinline width="${v.w}" height="${v.h}"></video>`;
  },
  head: '',
  tail: `<script src="/vendor/hls.min.js" defer></script>
<script>
// Стандартна практика: hls.js з defer, HLS (ABR hls.js за замовчуванням) підключається і відтворюється,
// коли відео видно на 50%
function attach(v) {
  if (window.Hls && Hls.isSupported()) { const h = new Hls(); h.loadSource(v.dataset.src); h.attachMedia(v); }
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
}));
</script>`,
};

const C = {
  hero: (id) => picture(id, HERO_SIZES, 'class="hero-img" elementtiming="hero" data-akpm-hero fetchpriority="high" decoding="async"'),
  img: (id) => {
    const e = manifest.images[id];
    return `<img class="akpm" data-akpm-id="${id}" data-akpm-importance="0" width="${e.w}" height="${e.h}" src="${e.lqip}" alt="">`;
  },
  video: (id) => {
    const v = manifest.videos[id];
    return `<video data-akpm-video="${id}" muted loop playsinline width="${v.w}" height="${v.h}"></video>`;
  },
  head: `<style>
  img.akpm { filter: blur(14px); transform: scale(1.02); transition: filter .25s ease; }
  img.akpm.akpm-loaded { filter: none; transform: none; }
  ${useCV ? '.card { content-visibility: auto; contain-intrinsic-size: auto 520px; }' : ''}
</style>`,
  tail: () => {
    // У маніфест сторінки потрапляє лише потрібне (без LQIP — вони вже в розмітці)
    const slim = {
      widths: manifest.widths,
      probe: manifest.probe,
      images: Object.fromEntries(feedIds.map((id) => {
        const { lqip, ...rest } = manifest.images[id];
        return [id, { ...rest, lqip: '' }];
      })),
      videos: manifest.videos,
    };
    return `<script src="/akpm.js"></script>
<script id="akpm-manifest" type="application/json">${JSON.stringify(slim)}</script>
<script>
  AKPM.init({ manifest: JSON.parse(document.getElementById('akpm-manifest').textContent), persist: true });
</script>`;
  },
};

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

function page(name, title, s) {
  const cards = [];
  let v = 0;
  feedIds.forEach((id, i) => {
    cards.push(`<article class="card">${s.img(id)}
    <div class="meta"><p>${captions[i % captions.length]}</p><button class="like" aria-pressed="false">♡ <span>${(i * 7) % 50 + 3}</span></button></div></article>`);
    if ((i + 1) % config.media.videoEvery === 0 && v < vidIds.length) {
      const vid = vidIds[v++];
      cards.push(`<article class="card video-card">${s.video(vid)}
    <div class="meta"><p>Відео ${v}</p><button class="like" aria-pressed="false">♡ <span>${v * 11}</span></button></div></article>`);
    }
  });
  const tail = typeof s.tail === 'function' ? s.tail() : s.tail;
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${css}</style>
${s.head}
</head>
<body data-config="${name}">
<header>Медіастрічка · конфігурація ${name.toUpperCase()}</header>
<main>
  <section class="hero">${s.hero(heroId)}
    <h1>Галерея тижня</h1>
    <p>Тестовий застосунок для дослідження продуктивності вебзастосунків із високоінтенсивним мультимедійним контентом.</p>
  </section>
  <section class="feed">
  ${cards.join('\n  ')}
  </section>
</main>
<footer>Кінець стрічки</footer>
${likeScript}
${tail}
</body>
</html>
`;
}

await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'a.html'), page('a', 'A — базова', A));
await fs.writeFile(path.join(OUT, 'b.html'), page('b', 'B — стандартні практики', B));
await fs.writeFile(path.join(OUT, 'c.html'), page('c', 'C — метод АКПМ', C));
await fs.writeFile(path.join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Стенд</title>
<h1>Тестовий стенд</h1><ul>
<li><a href="/a">A — базова</a></li><li><a href="/b">B — стандартні практики</a></li><li><a href="/c">C — метод АКПМ</a></li></ul>`);
console.log(`Сторінки згенеровано: ${feedIds.length + 1} зображень, ${Math.min(vidIds.length, Math.floor(feedIds.length / config.media.videoEvery))} відео${useCV ? ', content-visibility увімкнено' : ''}`);
