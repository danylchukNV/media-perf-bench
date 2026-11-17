// Статичний сервер стенду. За замовчуванням Cache-Control: no-store, щоб кожен прогін був «холодним».
// Запуск: node server.mjs [--port 8080] [--cache]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './bench.config.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || config.server.port;
const allowCache = args.includes('--cache');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.css': 'text/css', '.map': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.avif': 'image/avif', '.mp4': 'video/mp4', '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
};

const ALIASES = {
  '/': 'pages/index.html', '/a': 'pages/a.html', '/b': 'pages/b.html', '/c': 'pages/c.html',
  '/vendor/hls.min.js': '../node_modules/hls.js/dist/hls.min.js',
  '/vendor/web-vitals.iife.js': '../node_modules/web-vitals/dist/web-vitals.iife.js',
};

export function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const rel = ALIASES[url.pathname] ?? decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(PUB, rel);
    if (!file.startsWith(PUB + path.sep) && !file.startsWith(path.join(ROOT, 'node_modules') + path.sep)) { res.writeHead(403).end(); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
      const headers = {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': allowCache ? 'public, max-age=3600' : 'no-store',
        'Accept-Ranges': 'bytes',
        'Timing-Allow-Origin': '*',
      };
      const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
        if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end(); return; }
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'server.mjs')) {
  createServer().listen(port, () => console.log(`Стенд: http://localhost:${port}  (A: /a, B: /b, C: /c)${allowCache ? '' : '  [no-store]'}`));
}
