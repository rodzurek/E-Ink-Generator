// E-ink image generator: proxies prompts to the OpenAI image API so the key
// stays on the server. The page does the 240x240 downscale and palette dither.
// Node's standard library only, so the install needs no setup commands at all.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const started = Date.now();

const OPENAI_URL = 'https://api.openai.com/v1/images/generations';
const MAX_BODY = 16 * 1024;
const MAX_PROMPT = 4000;
// Image generation is slow; give up before a proxy in front of us does.
const UPSTREAM_TIMEOUT_MS = 180_000;

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

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function generate(req, res, { apiKey, model, quality, fetchImpl }) {
  if (!apiKey) return send(res, 503, { error: 'OPENAI_API_KEY is not set on the server' });

  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return send(res, 400, { error: 'prompt is required' });
  if (prompt.length > MAX_PROMPT) return send(res, 400, { error: `prompt is longer than ${MAX_PROMPT} characters` });

  try {
    // The API has no 240x240 size; the smallest square is requested and the
    // page scales it down.
    const upstream = await fetchImpl(OPENAI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, prompt, size: '1024x1024', quality, n: 1 }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return send(res, 502, { error: data?.error?.message || `OpenAI answered ${upstream.status}` });
    }
    const image = data?.data?.[0]?.b64_json;
    if (!image) return send(res, 502, { error: 'OpenAI returned no image' });
    return send(res, 200, { image });
  } catch (e) {
    return send(res, 502, { error: e.name === 'TimeoutError' ? 'OpenAI took too long to answer' : e.message });
  }
}

export function createApp({ token = '', apiKey = '', model = 'gpt-image-1', quality = 'low', fetchImpl = fetch } = {}) {
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
      return send(res, 200, { name: process.env.APP_NAME || 'e-ink-generator', node: process.version, model, ready: Boolean(apiKey) });
    }

    if (url.pathname === '/api/generate') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      return generate(req, res, { apiKey, model, quality, fetchImpl });
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
  // Local runs: pick up .env next to this file however the server was started.
  // Variables already in the environment win, and a missing file (the homelab
  // install) or a Node older than 20.12 is fine.
  try {
    process.loadEnvFile?.(path.join(HERE, '.env'));
  } catch {}
  const port = Number(process.env.PORT || 8090);
  const host = process.env.HOST || '0.0.0.0';
  const server = createApp({
    token: process.env.TOKEN || '',
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
    quality: process.env.OPENAI_IMAGE_QUALITY || 'low',
  });
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `port ${port} is already taken — set PORT to a free one` : e.message);
    process.exit(1);
  });
  server.listen(port, host, () => console.log(`listening on http://${host}:${port}`));
  // systemd sends SIGTERM on Stop; close cleanly so Restart does not race the port.
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
