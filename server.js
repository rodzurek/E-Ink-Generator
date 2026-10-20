// E-ink image generator: proxies prompts to the OpenAI image API so the key
// stays on the server. The page does the 240x240 downscale and palette dither.
// Node's standard library only, so the install needs no setup commands at all.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AccessUnavailable, createVerifier, identify, loadConfig, parseConfig } from './access.js';

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
const STAMP = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}`;
const SAVED_NAME = new RegExp(`^${STAMP}$`);
// The only files /api/images hands out: a generation's original or its 240x240 copy.
const IMAGE_PATH = new RegExp(`^/api/images/(${STAMP}(?:-240)?\\.png)$`);
const HISTORY_LIMIT = 50;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// The panel's own frame: 240x240 pixels at 4 bits, two per byte.
const PANEL_SIZE = 240;
const FRAME_BYTES = (PANEL_SIZE * PANEL_SIZE) / 2;
// The six Spectra 6 ink codes (see packFrame in public/panel.js); anything
// else in a frame means it was packed from the wrong palette.
const INK_CODES = new Set([0x0, 0x1, 0x2, 0x3, 0x5, 0x6]);
// A base64 frame plus, for a converted image, its base64 240x240 PNG.
const MAX_SEND_BODY = 640 * 1024;
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

function newStamp() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
}

// Runs fn after every earlier fn for the same key, so a send and an
// acknowledge for one inbox cannot overwrite each other's change.
const locks = new Map();
function withLock(key, fn) {
  const run = (locks.get(key) || Promise.resolve()).then(fn, fn);
  const settled = run.catch(() => {});
  locks.set(key, settled);
  settled.then(() => { if (locks.get(key) === settled) locks.delete(key); });
  return run;
}

// A device's inbox entry, or null when nothing was ever sent to it.
async function readInbox(file) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Written beside and then renamed over, so a display reading the file never
// sees half of it.
async function writeAtomic(file, data) {
  const temp = `${file}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  await fs.promises.writeFile(temp, data);
  await fs.promises.rename(temp, file);
}

// Writes <stamp>.png (the 1024x1024 original) and <stamp>.json (the prompt and
// settings) side by side. Returns the base name, or null when saving is off or
// failed: a generation that was paid for is still returned to the page.
async function saveImage(imagesDir, image, meta) {
  if (!imagesDir) return null;
  const name = newStamp();
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

// The newest generations, newest first. The names are timestamps, so sorting
// them sorts by time. A generation whose .json cannot be read is still listed.
async function listGenerations(res, { imagesDir }) {
  let files = [];
  try {
    if (imagesDir) files = await fs.promises.readdir(imagesDir);
  } catch {
    // No folder yet: nothing has been generated.
  }
  const have = new Set(files);
  const names = files
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .filter((name) => SAVED_NAME.test(name) && have.has(`${name}.png`))
    .sort()
    .reverse()
    .slice(0, HISTORY_LIMIT);
  const generations = await Promise.all(names.map(async (name) => {
    let meta = {};
    try {
      meta = JSON.parse(await fs.promises.readFile(path.join(imagesDir, `${name}.json`), 'utf8'));
    } catch {}
    return {
      name,
      created: meta.created ?? null,
      subject: meta.subject ?? '',
      style: meta.style ?? '',
      prompt: meta.prompt ?? '',
      model: meta.model ?? '',
      usage: meta.usage ?? null,
      dithered: have.has(`${name}-240.png`),
    };
  }));
  return send(res, 200, { generations });
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

// Deletes a stored generation: its original, its 240x240 copy, its .json and
// its frame. A frame that is still current in a display's inbox is kept, so
// that display can still fetch it; a newer send replaces it there.
async function deleteGeneration(req, res, { imagesDir, inboxDir }) {
  if (!imagesDir) return send(res, 404, { error: 'image storage is off' });

  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
  const name = typeof body.name === 'string' ? body.name : '';
  // The name ends up in paths, so it must be one newStamp made.
  if (!SAVED_NAME.test(name)) return send(res, 400, { error: 'name is not a stored image' });

  let showing = false;
  if (inboxDir) {
    let inboxes = [];
    try {
      inboxes = (await fs.promises.readdir(inboxDir)).filter((file) => file.endsWith('.json'));
    } catch {
      // No inbox folder yet: nothing was ever sent.
    }
    for (const file of inboxes) {
      const entry = await readInbox(path.join(inboxDir, file)).catch(() => null);
      if (entry?.frame === name) showing = true;
    }
  }

  const files = [`${name}.png`, `${name}-240.png`, `${name}.json`, ...(showing ? [] : [`${name}.bin`])];
  let removed = 0;
  try {
    for (const file of files) {
      try {
        await fs.promises.unlink(path.join(imagesDir, file));
        removed++;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
  } catch (e) {
    console.error(`could not delete ${name}: ${e.message}`);
    return send(res, 500, { error: 'could not delete the image' });
  }
  if (!removed) return send(res, 404, { error: 'name is not a stored image' });
  return send(res, 200, { deleted: name, frameKept: showing });
}

// Sends a packed frame to the partner's display. The frame comes with either
// the name of a stored generation or, for an image converted in the browser
// (which the server never saw), its 240x240 PNG, which then gets its own
// stored entry. The frame is stored as <stamp>.bin and becomes the current
// frame in each of the partner's device inboxes; a newer send replaces it.
async function sendFrame(req, res, { imagesDir, inboxDir, config, user }) {
  if (!user) return send(res, 403, { error: 'sending needs a signed-in user' });
  if (!imagesDir || !inboxDir) return send(res, 404, { error: 'image storage is off' });
  const partner = user.partner ? config.users.get(user.partner) : null;
  if (!partner) return send(res, 409, { error: 'you have no partner set in config.json' });
  const devices = [...config.devices.values()].filter((d) => d.owner === partner.email);
  if (!devices.length) return send(res, 409, { error: `${partner.name} has no display set in config.json` });

  let body;
  try {
    body = await readJson(req, MAX_SEND_BODY);
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
  const frame = Buffer.from(typeof body.frame === 'string' ? body.frame : '', 'base64');
  if (frame.length !== FRAME_BYTES) return send(res, 400, { error: `frame must be ${FRAME_BYTES} bytes` });
  if (!frame.every((b) => INK_CODES.has(b >> 4) && INK_CODES.has(b & 0xf))) {
    return send(res, 400, { error: 'frame holds a color the panel does not have' });
  }
  const hasName = body.name !== undefined;
  const hasImage = body.image !== undefined;
  if (hasName === hasImage) return send(res, 400, { error: 'send either the name of a stored image or an image' });

  let name;
  if (hasName) {
    name = typeof body.name === 'string' ? body.name : '';
    if (!SAVED_NAME.test(name)) return send(res, 400, { error: 'name is not a stored image' });
    try {
      await fs.promises.access(path.join(imagesDir, `${name}.png`));
    } catch {
      return send(res, 404, { error: 'name is not a stored image' });
    }
  } else {
    const png = Buffer.from(typeof body.image === 'string' ? body.image : '', 'base64');
    if (!png.subarray(0, 8).equals(PNG_MAGIC)) return send(res, 400, { error: 'image must be a base64 PNG' });
    // Width and height are the first fields of the IHDR chunk, right after the signature.
    if (png.length < 24 || png.readUInt32BE(16) !== PANEL_SIZE || png.readUInt32BE(20) !== PANEL_SIZE) {
      return send(res, 400, { error: `image must be ${PANEL_SIZE}x${PANEL_SIZE}` });
    }
    name = newStamp();
    try {
      await fs.promises.mkdir(imagesDir, { recursive: true });
      await fs.promises.writeFile(path.join(imagesDir, `${name}-240.png`), png);
      const meta = { created: new Date().toISOString(), createdBy: user.email, source: 'upload' };
      await fs.promises.writeFile(path.join(imagesDir, `${name}.json`), JSON.stringify(meta, null, 2) + '\n');
    } catch (e) {
      console.error(`could not save image to ${imagesDir}: ${e.message}`);
      return send(res, 500, { error: 'could not store the image' });
    }
  }

  const entry = { frame: name, sentBy: user.email, sentAt: new Date().toISOString(), deliveredAt: null };
  try {
    await fs.promises.writeFile(path.join(imagesDir, `${name}.bin`), frame);
    await fs.promises.mkdir(inboxDir, { recursive: true });
    for (const device of devices) {
      const file = path.join(inboxDir, `${device.id}.json`);
      await withLock(file, () => writeAtomic(file, JSON.stringify(entry, null, 2) + '\n'));
    }
  } catch (e) {
    console.error(`could not send ${name}: ${e.message}`);
    return send(res, 500, { error: 'could not store the frame' });
  }
  return send(res, 200, { sent: name, to: partner.name, devices: devices.map((d) => d.id) });
}

// The display's current frame, unless it already has it (?after=<frame id>)
// or nothing was sent to it: then 204. A device reads only its own inbox.
async function deviceFrame(res, url, { imagesDir, inboxDir, device }) {
  const entry = inboxDir ? await readInbox(path.join(inboxDir, `${device.id}.json`)) : null;
  if (!entry || entry.frame === url.searchParams.get('after')) {
    res.writeHead(204, { 'cache-control': 'no-store' });
    return res.end();
  }
  // The name ends up in a path, so it must be one newStamp made.
  if (!SAVED_NAME.test(String(entry.frame))) return send(res, 500, { error: 'inbox is damaged' });
  let frame;
  try {
    frame = await fs.promises.readFile(path.join(imagesDir, `${entry.frame}.bin`));
  } catch (e) {
    console.error(`frame ${entry.frame} for ${device.id} is missing: ${e.message}`);
    return send(res, 404, { error: 'the current frame is missing' });
  }
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': frame.length,
    'x-frame-id': entry.frame,
    'cache-control': 'no-store',
  });
  return res.end(frame);
}

// The display drew ?frame=<id>: record when, so the sender can see it arrived.
// Only the current frame can be acknowledged, and the first time is kept.
async function deviceAck(res, url, { inboxDir, device }) {
  const id = url.searchParams.get('frame') || '';
  if (!inboxDir) return send(res, 404, { error: 'nothing was sent to this display' });
  const file = path.join(inboxDir, `${device.id}.json`);
  return withLock(file, async () => {
    const entry = await readInbox(file);
    if (!entry) return send(res, 404, { error: 'nothing was sent to this display' });
    if (entry.frame !== id) return send(res, 409, { error: 'that is not the current frame', current: entry.frame });
    if (!entry.deliveredAt) {
      entry.deliveredAt = new Date().toISOString();
      await writeAtomic(file, JSON.stringify(entry, null, 2) + '\n');
    }
    return send(res, 200, { frame: entry.frame, deliveredAt: entry.deliveredAt });
  });
}

async function generate(req, res, { apiKey, models, model: defaultModel, quality, imagesDir, fetchImpl, user }) {
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
    const createdBy = user?.email ?? null;
    const saved = await saveImage(imagesDir, image, { created: new Date().toISOString(), createdBy, subject, style, prompt, model, quality, usage });
    return send(res, 200, { image, saved, usage });
  } catch (e) {
    return send(res, 502, { error: e.name === 'TimeoutError' ? 'OpenAI took too long to answer' : e.message });
  }
}

// Who is calling, as { kind: 'user', user } or { kind: 'device', device }, or
// null when nobody is known (no Access and no stand-in: the open local setup).
// Answers the request itself and returns undefined when the caller is refused.
async function whoIs(req, res, { verify, config, standIn }) {
  if (!verify) return standIn;
  const jwt = req.headers['cf-access-jwt-assertion'];
  if (!jwt) return void send(res, 401, { error: 'no Cloudflare Access token: open the app through its public address' });
  let claims;
  try {
    claims = await verify(String(jwt));
  } catch (e) {
    if (e instanceof AccessUnavailable) return void send(res, 503, { error: e.message });
    return void send(res, 401, { error: `Cloudflare Access token refused: ${e.message}` });
  }
  const identity = identify(claims, config);
  if (!identity) return void send(res, 403, { error: 'not a known user or device' });
  return identity;
}

// access: { teamDomain, audience } turns on Cloudflare Access; config is what
// parseConfig returns. devUser / devDevice stand in for a signed-in user and a
// device when Access is off, for local runs.
export function createApp({
  token = '', apiKey = '', model = 'gpt-image-1', quality = 'low', imagesDir = '', inboxDir = '', fetchImpl = fetch,
  access = null, config = parseConfig(), devUser = '', devDevice = '',
} = {}) {
  // OPENAI_IMAGE_MODEL may name a model that is not in the list; offer it too.
  const models = MODELS.includes(model) ? MODELS : [model, ...MODELS];
  const verify = access ? createVerifier({ ...access, fetchImpl }) : null;
  // Access replaces TOKEN, and nothing stands in for a real identity behind it.
  if (access) token = devUser = devDevice = '';

  const standInUser = devUser ? config.users.get(devUser.trim().toLowerCase()) : null;
  if (devUser && !standInUser) throw new Error(`DEV_USER ${devUser} is not a user in config.json`);
  const standInDevice = devDevice ? [...config.devices.values()].find((d) => d.id === devDevice) : null;
  if (devDevice && !standInDevice) throw new Error(`DEV_DEVICE ${devDevice} is not a device id in config.json`);

  return http.createServer((req, res) => {
    route(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    });
  });

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');

    // The dashboard probes this from the node itself. It stays outside every
    // check, so it must never say more than "alive, for this long".
    if (url.pathname === '/api/health') {
      return send(res, 200, { ok: true, uptime: Math.round((Date.now() - started) / 1000) });
    }

    const deviceRoute = url.pathname.startsWith('/api/device/');
    const standIn = deviceRoute
      ? standInDevice && { kind: 'device', device: standInDevice }
      : standInUser && { kind: 'user', user: standInUser };
    const identity = await whoIs(req, res, { verify, config, standIn: standIn || null });
    if (identity === undefined) return;

    // A display's service token opens only /api/device/*, and a partner's
    // login only the website.
    if (deviceRoute) {
      if (identity?.kind !== 'device') return send(res, 403, { error: 'only a display can use /api/device/' });
      const { device } = identity;
      if (url.pathname === '/api/device/frame') {
        if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
        return deviceFrame(res, url, { imagesDir, inboxDir, device });
      }
      if (url.pathname === '/api/device/ack') {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
        return deviceAck(res, url, { inboxDir, device });
      }
      return send(res, 404, { error: 'not found' });
    }
    if (identity && identity.kind !== 'user') return send(res, 403, { error: 'a display cannot use the website' });
    const user = identity?.user ?? null;

    // Optional when Access is off: set TOKEN in the install dialog's
    // environment box and the dashboard's Link button can carry it as ?token=.
    if (token) {
      const given = url.searchParams.get('token') || req.headers['x-token'] || '';
      if (!given || !tokenMatches(given, token)) {
        return send(res, 401, { error: 'missing or wrong token — open the app from the dashboard link, or add ?token=' });
      }
    }

    if (url.pathname === '/api/info') {
      const partner = user?.partner ? config.users.get(user.partner) : null;
      const person = (u) => (u ? { email: u.email, name: u.name } : null);
      return send(res, 200, {
        name: process.env.APP_NAME || 'e-ink-generator', node: process.version, model, models, ready: Boolean(apiKey),
        user: person(user), partner: person(partner),
      });
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
      return generate(req, res, { apiKey, models, model, quality, imagesDir, fetchImpl, user });
    }

    if (url.pathname === '/api/send') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      return sendFrame(req, res, { imagesDir, inboxDir, config, user });
    }

    if (url.pathname === '/api/delete') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      return deleteGeneration(req, res, { imagesDir, inboxDir });
    }

    if (url.pathname === '/api/dithered') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      return saveDithered(req, res, { imagesDir });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'GET only' });

    if (url.pathname === '/api/generations') return listGenerations(res, { imagesDir });

    // IMAGE_PATH admits only names saveImage produces, so nothing else in or
    // outside the folder can be read through here.
    const image = IMAGE_PATH.exec(url.pathname);
    if (image) {
      if (!imagesDir) return send(res, 404, { error: 'not found' });
      return fs.readFile(path.join(imagesDir, image[1]), (err, data) => {
        if (err) return send(res, 404, { error: 'not found' });
        send(res, 200, data, 'image/png');
      });
    }

    // Resolve first, compare after: a ../ in the URL must not leave public/.
    const wanted = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = path.resolve(PUBLIC, `.${wanted}`);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, { error: 'not found' });

    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: 'not found' });
      send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Local runs: pick up .env next to this file however the server was started.
  // Variables already in the environment win, and a missing file (the homelab
  // install) or a Node older than 20.12 is fine.
  try {
    process.loadEnvFile?.(path.join(HERE, '.env'));
  } catch {}
  const port = Number(process.env.PORT || 8090);
  // 127.0.0.1 when cloudflared runs on this node, so the app is reachable only through the tunnel.
  const host = process.env.HOST || '0.0.0.0';
  const teamDomain = process.env.ACCESS_TEAM_DOMAIN || '';
  const audience = process.env.ACCESS_AUD || '';
  if (Boolean(teamDomain) !== Boolean(audience)) {
    console.error('set both ACCESS_TEAM_DOMAIN and ACCESS_AUD, or neither');
    process.exit(1);
  }
  const devUser = process.env.DEV_USER || '';
  const devDevice = process.env.DEV_DEVICE || '';
  // config.json is needed once there are people or devices to recognise.
  const configFile = path.resolve(HERE, process.env.CONFIG_FILE || 'config.json');
  let server;
  try {
    const needed = teamDomain || devUser || devDevice;
    const config = needed || fs.existsSync(configFile) ? loadConfig(configFile) : parseConfig();
    if (teamDomain && (devUser || devDevice)) console.error('DEV_USER and DEV_DEVICE are ignored while Access is configured');
    if (teamDomain && process.env.TOKEN) console.error('TOKEN is ignored while Access is configured');
    server = createApp({
      token: process.env.TOKEN || '',
      apiKey: process.env.OPENAI_API_KEY || '',
      model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
      quality: process.env.OPENAI_IMAGE_QUALITY || 'low',
      imagesDir: path.resolve(HERE, process.env.IMAGES_DIR || 'images'),
      inboxDir: path.resolve(HERE, process.env.INBOX_DIR || 'inbox'),
      access: teamDomain ? { teamDomain, audience } : null,
      config,
      devUser,
      devDevice,
    });
  } catch (e) {
    console.error(e.code === 'ENOENT' ? `${configFile} is missing — copy config.example.json and fill it in` : e.message);
    process.exit(1);
  }
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `port ${port} is already taken — set PORT to a free one` : e.message);
    process.exit(1);
  });
  server.listen(port, host, () => console.log(`listening on http://${host}:${port}`));
  // systemd sends SIGTERM on Stop; close cleanly so Restart does not race the port.
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
