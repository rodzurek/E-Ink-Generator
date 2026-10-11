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
// The models the page offers. A request naming anything else is refused, so
// the page cannot be used to bill a model that is not listed here.
const MODELS = [
  'gpt-image-1-mini',
  'gpt-image-1',
  'gpt-image-1.5',
  'gpt-image-2',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
];
const MAX_BODY = 16 * 1024;
const MAX_PROMPT = 4000;
// A dithered 240x240 PNG is tens of kilobytes; base64 and JSON add a third.
const MAX_DITHERED_BODY = 512 * 1024;
// What saveImage names a generation: an ISO timestamp with - for : and . plus six hex digits.
const SAVED_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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

function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
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

// Writes <stamp>.png (the 1024x1024 original) and <stamp>.json (the prompt and
// settings) side by side. Returns the base name, or null when saving is off or
// failed: a generation that was paid for is still returned to the page.
async function saveImage(imagesDir, image, meta) {
  if (!imagesDir) return null;
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    await fs.promises.mkdir(imagesDir, { recursive: true });
    await fs.promises.writeFile(path.join(imagesDir, `${name}.png`), Buffer.from(image, 'base64'));
    await fs.promises.writeFile(path.join(imagesDir, `${name}.json`), JSON.stringify(meta, null, 2) + '\n');
    return name;
  } catch (e) {
    console.error(`could not save image to ${imagesDir}: ${e.message}`);
    return null;
  }
}

// The page dithers, so it sends the 240x240 result back to sit next to the
// original as <stamp>-240.png. The name must be one saveImage produced and
// still be on disk, so this can only add a file beside an existing generation.
async function saveDithered(req, res, { imagesDir }) {
  if (!imagesDir) return send(res, 404, { error: 'image storage is off' });

  let body;
  try {
    body = await readJson(req, MAX_DITHERED_BODY);
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
  const name = typeof body.name === 'string' ? body.name : '';
  if (!SAVED_NAME.test(name)) return send(res, 400, { error: 'name is not a stored image' });
  const png = Buffer.from(typeof body.image === 'string' ? body.image : '', 'base64');
  if (!png.subarray(0, 8).equals(PNG_MAGIC)) return send(res, 400, { error: 'image must be a base64 PNG' });

  try {
    await fs.promises.access(path.join(imagesDir, `${name}.png`));
  } catch {
    return send(res, 404, { error: 'name is not a stored image' });
  }
  try {
    await fs.promises.writeFile(path.join(imagesDir, `${name}-240.png`), png);
    return send(res, 200, { saved: `${name}-240.png` });
  } catch (e) {
    console.error(`could not save image to ${imagesDir}: ${e.message}`);
    return send(res, 500, { error: 'could not write the image' });
  }
}

async function generate(req, res, { apiKey, models, model: defaultModel, quality, imagesDir, fetchImpl }) {
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
  const model = body.model === undefined ? defaultModel : body.model;
  if (!models.includes(model)) return send(res, 400, { error: `model must be one of: ${models.join(', ')}` });

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
    const subject = typeof body.subject === 'string' ? body.subject.trim().slice(0, MAX_PROMPT) : '';
    // Token counts as OpenAI reports them; null from a model that reports none.
    const usage = data.usage && typeof data.usage === 'object' ? data.usage : null;
    const style = typeof body.style === 'string' ? body.style.trim().slice(0, 100) : '';
    const saved = await saveImage(imagesDir, image, { created: new Date().toISOString(), subject, style, prompt, model, quality, usage });
    return send(res, 200, { image, saved, usage });
  } catch (e) {
    return send(res, 502, { error: e.name === 'TimeoutError' ? 'OpenAI took too long to answer' : e.message });
  }
}

export function createApp({ token = '', apiKey = '', model = 'gpt-image-1', quality = 'low', imagesDir = '', fetchImpl = fetch } = {}) {
  // OPENAI_IMAGE_MODEL may name a model that is not in the list; offer it too.
  const models = MODELS.includes(model) ? MODELS : [model, ...MODELS];

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
      return send(res, 200, { name: process.env.APP_NAME || 'e-ink-generator', node: process.version, model, models, ready: Boolean(apiKey) });
    }

    // Built here, not a file in public/: Android fetches the icons and opens
    // start_url on its own, so with TOKEN set each of those URLs must carry it.
    if (url.pathname === '/manifest.webmanifest') {
      const carry = token ? `?token=${encodeURIComponent(token)}` : '';
      return send(res, 200, {
        name: 'E-Ink Generator',
        short_name: 'E-Ink',
        description: 'Generate and convert images for a 240x240 colored e-ink display',
        start_url: `/${carry}`,
        scope: '/',
        display: 'standalone',
        background_color: '#11151c',
        theme_color: '#11151c',
        icons: [
          { src: `/icon-192.png${carry}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: `/icon-512.png${carry}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: `/icon-512.png${carry}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      }, 'application/manifest+json; charset=utf-8');
    }

    if (url.pathname === '/api/generate') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      return generate(req, res, { apiKey, models, model, quality, imagesDir, fetchImpl });
    }

    if (url.pathname === '/api/dithered') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      return saveDithered(req, res, { imagesDir });
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
    imagesDir: path.resolve(HERE, process.env.IMAGES_DIR || 'images'),
  });
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `port ${port} is already taken — set PORT to a free one` : e.message);
    process.exit(1);
  });
  server.listen(port, host, () => console.log(`listening on http://${host}:${port}`));
  // systemd sends SIGTERM on Stop; close cleanly so Restart does not race the port.
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
