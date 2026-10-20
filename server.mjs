import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSignalingMiddleware } from './remote-assist/signaling.js';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const distDir = resolve(rootDir, 'dist');
const signal = createSignalingMiddleware();
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.woff2', 'font/woff2'],
]);

if (!existsSync(resolve(distDir, 'remote-assist/index.html'))) {
  process.stderr.write('Build the app first with `npm run build`.\n');
  process.exit(1);
}

const server = createServer(async (request, response) => {
  if ((request.url || '').startsWith('/api/')) {
    await signal(request, response, () => {});
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  let requestPath;
  try { requestPath = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname); }
  catch { response.writeHead(400).end('Invalid path.'); return; }
  if (requestPath === '/') {
    response.writeHead(302, { Location: '/remote-assist/' }).end();
    return;
  }

  let filePath = resolve(distDir, `.${requestPath}`);
  const relativePath = filePath.slice(distDir.length);
  if (relativePath.startsWith(sep + '..') || relativePath === '..') {
    response.writeHead(403).end('Forbidden.');
    return;
  }
  try { if (statSync(filePath).isDirectory()) filePath = resolve(filePath, 'index.html'); }
  catch { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found.'); return; }

  try {
    const contentType = mimeTypes.get(extname(filePath).toLowerCase()) || 'application/octet-stream';
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': extname(filePath).includes('.') && !filePath.endsWith('.html') ? 'public, max-age=3600' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(filePath).on('error', () => {
      if (!response.headersSent) response.writeHead(404).end('Not found.');
      else response.destroy();
    }).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found.');
  }
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => process.stdout.write(`سند is listening on http://${host}:${port}\n`));
