// Starter app for the homelab dashboard's "Install app → git" path.
// Node's standard library only, so the install needs no setup commands at all.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const started = Date.now();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// Constant-time, and length-safe: timingSafeEqual throws on unequal lengths.
function tokenMatches(given, wanted) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(wanted)).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createApp({ token = '' } = {}) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // The dashboard probes this from the node itself. It stays outside the
    // token check, so it must never say more than "alive, for this long".
    if (url.pathname === '/api/health') {
      return send(res, 200, { ok: true, uptime: Math.round((Date.now() - started) / 1000) });
    }

    // Optional: set TOKEN in the install dialog's environment box and the
    // dashboard's Link button can carry it as ?token=.
    if (token) {
      const given = url.searchParams.get('token') || req.headers['x-token'] || '';
      if (!given || !tokenMatches(given, token)) {
        return send(res, 401, { error: 'missing or wrong token — open the app from the dashboard link, or add ?token=' });
      }
    }

    if (url.pathname === '/api/info') {
      return send(res, 200, { name: process.env.APP_NAME || 'template', node: process.version });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'GET only' });

    // Resolve first, compare after: a ../ in the URL must not leave public/.
    const wanted = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = path.resolve(PUBLIC, `.${wanted}`);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, { error: 'not found' });

    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: 'not found' });
      send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8090);
  const host = process.env.HOST || '0.0.0.0';
  const server = createApp({ token: process.env.TOKEN || '' });
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `port ${port} is already taken — set PORT to a free one` : e.message);
    process.exit(1);
  });
  server.listen(port, host, () => console.log(`listening on http://${host}:${port}`));
  // systemd sends SIGTERM on Stop; close cleanly so Restart does not race the port.
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
