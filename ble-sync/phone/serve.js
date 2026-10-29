// Tiny static file server for local testing (Web Bluetooth works on http://localhost).
// Usage: node serve.js [port]   (default 8080; binds to 127.0.0.1 only)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

export function startServer(port = 8080, host = '127.0.0.1') {
  const server = createServer(async (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = normalize(join(ROOT, pathname));
    const type = TYPES[extname(file)];
    if (!file.startsWith(ROOT) || !type || file.includes(`${sep}node_modules${sep}`) || file.includes(`${sep}test${sep}`)) {
      res.writeHead(404).end('not found');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 8080);
  const server = await startServer(port);
  console.log(`Field Sync at http://127.0.0.1:${server.address().port}/  (Ctrl-C to stop)`);
}
