// WebCpuGL static file server.
// Usage: node server.js [port]   (default 8080)
// Serves:
//   /                       -> public/index.html
//   /webcpugl/*             -> public/webcpugl/*
//   /examples/<name>/*      -> examples/<name>/*   (user-written entry + .sd shaders)
//
// The browser bootstrap reads ?example=<name> (default "triangle") and
// dynamically imports /examples/<name>/main.js.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  // .sd is ES-module shader source served as JS so direct imports also work
  '.sd':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.txt':  'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

// URL path -> on-disk directory. Order matters.
const ROUTES = [
  { prefix: '/webcpugl/',  dir: path.join(__dirname, 'public', 'webcpugl') },
  { prefix: '/examples/',  dir: path.join(__dirname, 'examples') },
  { prefix: '/',            dir: path.join(__dirname, 'public') },
];

function resolvePath(urlPath) {
  for (const r of ROUTES) {
    if (urlPath.startsWith(r.prefix)) {
      const sub = urlPath.slice(r.prefix.length);
      const abs = path.normalize(path.join(r.dir, sub));
      // prevent path traversal
      if (!abs.startsWith(r.dir)) return null;
      return abs;
    }
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

    let filePath = resolvePath(urlPath);
    if (!filePath) { res.writeHead(403); res.end('Forbidden'); return; }

    // directory -> index.html
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!existsSync(filePath)) { res.writeHead(404); res.end('Not Found: ' + urlPath); return; }

    const ext = path.extname(filePath).toLowerCase();
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch (e) {
    res.writeHead(500); res.end('Server error: ' + e.message);
  }
});

const port = Number(process.argv[2] || process.env.PORT || 8080);
server.listen(port, () => {
  console.log(`WebCpuGL dev server running at http://localhost:${port}/`);
  console.log(`Try:  http://localhost:${port}/?example=triangle`);
});
