// Генерація тестових медіаресурсів і маніфесту.
//
// Зображення: якщо в media-source/images/ є власні фото (jpg/png/webp) — беруться вони,
// інакше генеруються синтетичні. Для кожного зображення створюються варіанти
// AVIF / WebP / JPEG для кожної ширини з конфігурації, «оригінал» orig.jpg (для конфігурації А)
// і LQIP-заповнювач (для конфігурації В).
//
// Відео: якщо в media-source/videos/ є mp4 — беруться вони, інакше ffmpeg генерує синтетичні.
// Для кожного відео: HLS з кількома рівнями якості, full.mp4 (для конфігурації А), постер.
//
// Результат: public/media/... та public/media/manifest.json

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import sharp from 'sharp';
import config from '../bench.config.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_IMG = path.join(ROOT, 'media-source', 'images');
const SRC_VID = path.join(ROOT, 'media-source', 'videos');
const OUT = path.join(ROOT, 'public', 'media');
const M = config.media;

const pad = (n) => String(n).padStart(3, '0');

async function listFiles(dir, exts) {
  if (!existsSync(dir)) return [];
  const all = await fs.readdir(dir);
  return all.filter((f) => exts.includes(path.extname(f).toLowerCase())).sort().map((f) => path.join(dir, f));
}

// Детермінований генератор псевдовипадкових чисел, щоб синтетичні медіа були однаковими між запусками
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Синтетичне «фото»: плавний градієнт + фігури + дрібний шум (щоб стиснення поводилось схоже на реальні фото)
async function synthImage(i) {
  const W = M.sourceWidth, H = M.sourceHeight;
  const r = rng(1000 + i);
  // 1) градієнт: маленька випадкова картинка, розтягнута з інтерполяцією
  const gw = 8, gh = 6;
  const g = Buffer.alloc(gw * gh * 3);
  for (let k = 0; k < g.length; k++) g[k] = Math.floor(40 + r() * 190);
  const base = await sharp(g, { raw: { width: gw, height: gh, channels: 3 } })
    .resize(W, H, { kernel: 'cubic' }).png().toBuffer();
  // 2) фігури
  let shapes = '';
  for (let k = 0; k < 14; k++) {
    const cx = Math.floor(r() * W), cy = Math.floor(r() * H), rad = Math.floor(60 + r() * 380);
    const col = `rgb(${Math.floor(r() * 255)},${Math.floor(r() * 255)},${Math.floor(r() * 255)})`;
    shapes += r() > 0.5
      ? `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="${col}" fill-opacity="${(0.25 + r() * 0.5).toFixed(2)}"/>`
      : `<rect x="${cx}" y="${cy}" width="${rad * 1.6}" height="${rad}" fill="${col}" fill-opacity="${(0.25 + r() * 0.5).toFixed(2)}" transform="rotate(${Math.floor(r() * 90)} ${cx} ${cy})"/>`;
  }
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${shapes}
    <text x="80" y="${H - 100}" font-size="140" font-family="sans-serif" fill="white" fill-opacity="0.85">#${pad(i)}</text></svg>`);
  // 3) текстура середньої частоти (як листя, тканина, асфальт) + дрібне зерно.
  //    Параметри підібрані так, щоб розміри після стиснення були близькими до реальних фото
  //    (1920 px: JPEG q80 ≈ 400 КБ, AVIF q50 ≈ 200 КБ).
  const mw = Math.floor(W / 8), mh = Math.floor(H / 8);
  const mid = await sharp(crypto.randomBytes(mw * mh * 3), { raw: { width: mw, height: mh, channels: 3 } })
    .resize(W, H, { kernel: 'cubic' }).png().toBuffer();
  const grainRaw = crypto.randomBytes(W * H);
  for (let k = 0; k < grainRaw.length; k++) grainRaw[k] = 98 + (grainRaw[k] % 60);
  const grain = await sharp(grainRaw, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
  return sharp(base)
    .composite([{ input: mid, blend: 'soft-light' }, { input: svg }, { input: grain, blend: 'soft-light' }])
    .jpeg({ quality: 95 }).toBuffer();
}

async function processImage(input, id) {
  const dir = path.join(OUT, 'img', id);
  await fs.mkdir(dir, { recursive: true });
  // metadata() повертає розміри до EXIF-повороту (autoOrient є лише в sharp ≥ 0.34),
  // тож для орієнтацій 5–8 (поворот на 90°) ширину й висоту міняємо місцями.
  const meta = await sharp(input).metadata();
  const swap = (meta.orientation ?? 1) >= 5;
  const w = meta.autoOrient?.width ?? (swap ? meta.height : meta.width);
  const h = meta.autoOrient?.height ?? (swap ? meta.width : meta.height);

  const variants = { avif: {}, webp: {}, jpeg: {} };
  const widths = M.widths.filter((x) => x <= w);
  if (widths.length === 0) widths.push(w);
  for (const width of widths) {
    const resized = sharp(input).rotate().resize({ width });
    const jobs = [
      ['avif', 'avif', (s) => s.avif({ quality: M.quality.avif, effort: M.avifEffort })],
      ['webp', 'webp', (s) => s.webp({ quality: M.quality.webp })],
      ['jpeg', 'jpg', (s) => s.jpeg({ quality: M.quality.jpeg, mozjpeg: true, progressive: true })],
    ];
    for (const [fmt, ext, enc] of jobs) {
      const file = path.join(dir, `${width}.${ext}`);
      const info = await enc(resized.clone()).toFile(file);
      variants[fmt][width] = info.size;
    }
  }
  // «Оригінал» для базової конфігурації А
  const orig = await sharp(input).rotate().resize({ width: Math.min(w, M.sourceWidth) })
    .jpeg({ quality: M.quality.origJpeg }).toFile(path.join(dir, 'orig.jpg'));
  // LQIP і домінантний колір
  const lqipBuf = await sharp(input).rotate().resize({ width: 24 }).webp({ quality: 30 }).toBuffer();
  const { dominant } = await sharp(input).stats();
  const color = '#' + [dominant.r, dominant.g, dominant.b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return {
    w, h, color,
    lqip: 'data:image/webp;base64,' + lqipBuf.toString('base64'),
    origBytes: orig.size,
    variants,
  };
}

async function ffmpeg(args) {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 });
}

async function synthVideo(i, file) {
  // testsrc2 + рухомий шум: відео з реалістичним для кодека навантаженням
  const hue = (i * 70) % 360;
  await ffmpeg([
    '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30:duration=${M.videoSeconds}`,
    '-vf', `hue=h=${hue},noise=alls=18:allf=t+u`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', file,
  ]);
}

async function probeVideo(input) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:stream_side_data=rotation', '-of', 'json', input]);
  const s = JSON.parse(stdout).streams?.[0] ?? {};
  const rot = Math.abs(Number(s.side_data_list?.find((d) => 'rotation' in d)?.rotation ?? 0));
  return rot === 90 || rot === 270 ? { w: s.height, h: s.width } : { w: s.width, h: s.height };
}

async function processVideo(input, id) {
  const dir = path.join(OUT, 'video', id);
  await fs.mkdir(dir, { recursive: true });
  const seg = String(M.hlsSegmentSeconds);
  // Ключові кадри за часом, а не за кількістю кадрів: сегменти однакові за будь-якої частоти кадрів
  const keyframes = ['-force_key_frames', `expr:gte(t,n_forced*${seg})`, '-sc_threshold', '0'];
  // Рівні вище за роздільність джерела не створюємо: розтягнуте відео дає зайві байти без якості
  const src = await probeVideo(input);
  const ladder = M.videoLevels.filter((L) => L.height <= src.h);
  if (ladder.length === 0) ladder.push(M.videoLevels[0]);
  if (ladder.length < M.videoLevels.length) {
    console.warn(`  ${id}: джерело ${src.w}×${src.h}, рівні вище ${ladder.at(-1).height}p пропущено`);
  }
  const levels = [];
  for (const L of ladder) {
    const ldir = path.join(dir, `${L.height}p`);
    await fs.mkdir(ldir, { recursive: true });
    await ffmpeg([
      '-i', input, '-an',
      '-vf', `scale=-2:${L.height}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main',
      '-b:v', `${L.bitrate}k`, '-maxrate', `${Math.round(L.bitrate * 1.1)}k`, '-bufsize', `${L.bitrate * 2}k`,
      ...keyframes, '-pix_fmt', 'yuv420p',
      '-hls_time', seg, '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(ldir, 'seg_%03d.ts'),
      path.join(ldir, 'index.m3u8'),
    ]);
    const width = Math.round((L.height * src.w) / src.h / 2) * 2;
    levels.push({ height: L.height, width, bitrate: L.bitrate * 1000, uri: `${L.height}p/index.m3u8` });
  }
  const master = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const l of levels) {
    master.push(`#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(l.bitrate * 1.1)},RESOLUTION=${l.width}x${l.height},CODECS="avc1.4d401f"`);
    master.push(l.uri);
  }
  await fs.writeFile(path.join(dir, 'master.m3u8'), master.join('\n') + '\n');
  // Повне mp4 (для конфігурації А) — найвищий рівень
  const top = ladder[ladder.length - 1];
  await ffmpeg(['-i', input, '-an', '-vf', `scale=-2:${top.height}`, '-c:v', 'libx264', '-preset', 'veryfast',
    '-b:v', `${top.bitrate}k`, '-maxrate', `${Math.round(top.bitrate * 1.1)}k`, '-bufsize', `${top.bitrate * 2}k`,
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(dir, 'full.mp4')]);
  // Постер
  const posterPng = path.join(dir, 'poster-src.png');
  await ffmpeg(['-ss', '1', '-i', input, '-frames:v', '1', posterPng]);
  const poster = await sharp(posterPng).resize({ width: 960 }).jpeg({ quality: 70, mozjpeg: true }).toFile(path.join(dir, 'poster.jpg'));
  await fs.rm(posterPng);
  const fullStat = await fs.stat(path.join(dir, 'full.mp4'));
  return {
    w: levels.at(-1).width, h: top.height,
    master: `/media/video/${id}/master.m3u8`,
    mp4: `/media/video/${id}/full.mp4`,
    poster: `/media/video/${id}/poster.jpg`,
    posterBytes: poster.size,
    mp4Bytes: fullStat.size,
    levels: levels.map(({ height, width, bitrate }) => ({ height, width, bitrate })),
  };
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

async function main() {
  const t0 = Date.now();
  // --skip-video: перегенерувати лише зображення, відео й їхній опис у маніфесті залишити
  const skipVideo = process.argv.includes('--skip-video');
  let oldVideos = {};
  if (skipVideo && existsSync(path.join(OUT, 'manifest.json'))) {
    oldVideos = JSON.parse(await fs.readFile(path.join(OUT, 'manifest.json'), 'utf8')).videos ?? {};
  }
  if (skipVideo) await fs.rm(path.join(OUT, 'img'), { recursive: true, force: true });
  else await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  const manifest = { generatedAt: new Date().toISOString(), widths: M.widths, images: {}, videos: {}, probe: {} };
  // Крихітні зразки для визначення підтримки форматів у браузері
  const px = sharp({ create: { width: 2, height: 2, channels: 3, background: '#808080' } });
  manifest.probe.avif = 'data:image/avif;base64,' + (await px.clone().avif({ quality: 50 }).toBuffer()).toString('base64');
  manifest.probe.webp = 'data:image/webp;base64,' + (await px.clone().webp({ quality: 50 }).toBuffer()).toString('base64');

  // ----- Зображення -----
  const own = await listFiles(SRC_IMG, ['.jpg', '.jpeg', '.png', '.webp']);
  const count = own.length || M.imageCount;
  console.log(own.length ? `Зображення: ${own.length} власних файлів` : `Зображення: генерую ${count} синтетичних`);
  const ids = Array.from({ length: count }, (_, i) => `img-${pad(i + 1)}`);
  const concurrency = Math.max(1, Math.min(4, os.cpus().length));
  sharp.concurrency(1);
  let done = 0;
  const imgs = await pool(ids, concurrency, async (id, i) => {
    const input = own.length ? own[i] : await synthImage(i + 1);
    const res = await processImage(input, id);
    done++;
    if (done % 5 === 0 || done === count) process.stdout.write(`  ${done}/${count}\r`);
    return res;
  });
  ids.forEach((id, i) => (manifest.images[id] = imgs[i]));
  console.log('');

  // ----- Відео -----
  let haveFfmpeg = true;
  try { await run('ffmpeg', ['-version']); } catch { haveFfmpeg = false; }
  if (skipVideo) {
    manifest.videos = oldVideos;
    console.log(`Відео: пропущено (--skip-video), залишено ${Object.keys(oldVideos).length}`);
  } else if (!haveFfmpeg) {
    console.warn('ffmpeg не знайдено — відео пропущено (сторінки будуть без відео).');
  } else {
    const ownV = await listFiles(SRC_VID, ['.mp4', '.mov', '.mkv', '.webm']);
    const vcount = ownV.length || M.videoCount;
    console.log(ownV.length ? `Відео: ${ownV.length} власних файлів` : `Відео: генерую ${vcount} синтетичних`);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mpb-'));
    for (let i = 0; i < vcount; i++) {
      const id = `vid-${pad(i + 1)}`;
      let input = ownV[i];
      if (!input) { input = path.join(tmp, `${id}.mp4`); await synthVideo(i + 1, input); }
      manifest.videos[id] = await processVideo(input, id);
      console.log(`  ${id} готово`);
    }
    await fs.rm(tmp, { recursive: true, force: true });
  }

  await fs.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest));
  console.log(`Готово за ${((Date.now() - t0) / 1000).toFixed(0)} с → public/media/manifest.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
