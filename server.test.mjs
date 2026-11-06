import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from './server.js';
import { parseConfig } from './access.js';

async function withServer(options, fn) {
  const server = createApp(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test('health answers without a token and says nothing else', async () => {
  await withServer({ token: 'secret' }, async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(await res.json()).sort(), ['ok', 'uptime']);
  });
});

test('everything else needs the token when one is set', async () => {
  await withServer({ token: 'secret' }, async (base) => {
    assert.equal((await fetch(`${base}/`)).status, 401);
    assert.equal((await fetch(`${base}/?token=wrong`)).status, 401);
    assert.equal((await fetch(`${base}/?token=secret`)).status, 200);
  });
});

test('no token configured means open', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/`)).status, 200);
  });
});

function generate(base, body) {
  return fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('generate refuses without an API key or a prompt', async () => {
  await withServer({}, async (base) => {
    assert.equal((await generate(base, { prompt: 'a fox' })).status, 503);
  });
  await withServer({ apiKey: 'sk-test' }, async (base) => {
    assert.equal((await generate(base, { prompt: '  ' })).status, 400);
    assert.equal((await fetch(`${base}/api/generate`)).status, 405);
  });
});

test('generate sends the prompt upstream and returns the image', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, auth: init.headers.authorization, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 });
  };
  await withServer({ apiKey: 'sk-test', model: 'gpt-image-1', fetchImpl }, async (base) => {
    const res = await generate(base, { prompt: 'a fox' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { image: 'aGVsbG8=', saved: null, usage: null });
    assert.equal(sent.auth, 'Bearer sk-test');
    assert.equal(sent.body.prompt, 'a fox');
    assert.equal(sent.body.model, 'gpt-image-1');
  });
});

test('generate uses the model the page picked, and only a listed one', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body).model);
    return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 });
  };
  await withServer({ apiKey: 'sk-test', fetchImpl }, async (base) => {
    const info = await (await fetch(`${base}/api/info`)).json();
    assert.equal(info.model, 'gpt-image-1');
    assert.ok(info.models.includes('gpt-image-2'));

    assert.equal((await generate(base, { prompt: 'a fox', model: 'gpt-image-2' })).status, 200);
    assert.equal((await generate(base, { prompt: 'a fox', model: 'dall-e-3' })).status, 400);
    assert.deepEqual(sent, ['gpt-image-2']);
  });
});

test('generate stores the image and its prompt when given a folder', async () => {
  const imagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eink-'));
  const reported = { total_tokens: 1372, input_tokens: 100, output_tokens: 1272 };
  const fetchImpl = async () => new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }], usage: reported }), { status: 200 });
  try {
    await withServer({ apiKey: 'sk-test', imagesDir, fetchImpl }, async (base) => {
      const { saved, usage } = await (await generate(base, { prompt: 'Create a fox', subject: 'a fox', style: 'Anime' })).json();
      assert.deepEqual(usage, reported);
      assert.deepEqual((await fs.readdir(imagesDir)).sort(), [`${saved}.json`, `${saved}.png`]);
      assert.equal(await fs.readFile(path.join(imagesDir, `${saved}.png`), 'utf8'), 'hello');
      const meta = JSON.parse(await fs.readFile(path.join(imagesDir, `${saved}.json`), 'utf8'));
      assert.equal(meta.prompt, 'Create a fox');
      assert.equal(meta.subject, 'a fox');
      assert.equal(meta.style, 'Anime');
      assert.deepEqual(meta.usage, reported);
    });
  } finally {
    await fs.rm(imagesDir, { recursive: true, force: true });
  }
});

test('dithered copy is stored beside its original and nowhere else', async () => {
  const imagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eink-'));
  const fetchImpl = async () => new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 });
  const png = fakePng();
  const dithered = (base, body) => fetch(`${base}/api/dithered`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    await withServer({ apiKey: 'sk-test', imagesDir, fetchImpl }, async (base) => {
      const { saved } = await (await generate(base, { prompt: 'a fox' })).json();
      const image = png.toString('base64');

      const res = await dithered(base, { name: saved, image });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { saved: `${saved}-240.png` });
      assert.deepEqual(await fs.readFile(path.join(imagesDir, `${saved}-240.png`)), png);

      assert.equal((await dithered(base, { name: '../server', image })).status, 400);
      assert.equal((await dithered(base, { name: saved, image: 'aGVsbG8=' })).status, 400);
      assert.equal((await dithered(base, { name: '2000-01-01T00-00-00-000Z-abcdef', image })).status, 404);
      assert.equal((await fs.readdir(imagesDir)).length, 3);
    });
  } finally {
    await fs.rm(imagesDir, { recursive: true, force: true });
  }
});

test('history lists stored generations newest first and serves only their images', async () => {
  const imagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eink-'));
  const fetchImpl = async () => new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 });
  try {
    await withServer({ apiKey: 'sk-test', imagesDir, fetchImpl }, async (base) => {
      assert.deepEqual(await (await fetch(`${base}/api/generations`)).json(), { generations: [] });

      const first = (await (await generate(base, { prompt: 'p1', subject: 'a fox', style: 'Anime' })).json()).saved;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = (await (await generate(base, { prompt: 'p2', subject: 'a cat' })).json()).saved;
      await fs.writeFile(path.join(imagesDir, 'notes.json'), '{}');

      const { generations } = await (await fetch(`${base}/api/generations`)).json();
      assert.deepEqual(generations.map((g) => g.name), [second, first]);
      assert.equal(generations[1].subject, 'a fox');
      assert.equal(generations[1].style, 'Anime');
      assert.equal(generations[1].copy, null);

      const png = await fetch(`${base}/api/images/${first}.png`);
      assert.equal(png.headers.get('content-type'), 'image/png');
      assert.equal(await png.text(), 'hello');
      assert.equal((await fetch(`${base}/api/images/${first}-240.png`)).status, 404);
      assert.equal((await fetch(`${base}/api/images/${first}.json`)).status, 404);
      assert.equal((await fetch(`${base}/api/images/..%2fserver.js`)).status, 404);
    });
  } finally {
    await fs.rm(imagesDir, { recursive: true, force: true });
  }
});

test('generate passes an upstream error message through as 502', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'billing limit' } }), { status: 400 });
  await withServer({ apiKey: 'sk-test', fetchImpl }, async (base) => {
    const res = await generate(base, { prompt: 'a fox' });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'billing limit');
  });
});

test('manifest carries the token so the installed app opens signed in', async () => {
  await withServer({ token: 'secret' }, async (base) => {
    assert.equal((await fetch(`${base}/manifest.webmanifest`)).status, 401);
    const res = await fetch(`${base}/manifest.webmanifest?token=secret`);
    assert.match(res.headers.get('content-type'), /^application\/manifest\+json/);
    const manifest = await res.json();
    assert.equal(manifest.start_url, '/?token=secret');
    for (const icon of manifest.icons) {
      const png = await fetch(base + icon.src);
      assert.equal(png.status, 200);
      assert.equal(png.headers.get('content-type'), 'image/png');
    }
  });
  await withServer({}, async (base) => {
    assert.equal((await (await fetch(`${base}/manifest.webmanifest`)).json()).start_url, '/');
  });
});

test('paths cannot climb out of public/', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 404);
  });
});

// Cloudflare Access: a key pair stands in for the team's signing key, and
// fetchImpl serves its public half where the app looks for the certs.
const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-tag';
const signer = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const accessConfig = parseConfig({
  users: [
    { email: 'rod@example.com', name: 'Rod', partner: 'ampy@example.com' },
    { email: 'ampy@example.com', name: 'Ampy', partner: 'rod@example.com' },
  ],
  devices: [{ id: 'rod-display', clientId: 'rod.access', owner: 'rod@example.com' }],
});

function accessFetch(upstream) {
  return async (url, init) => {
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) {
      const jwk = { ...signer.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }
    return upstream(url, init);
  };
}

function accessToken(claims, { key = signer.privateKey, kid = 'k1' } = {}) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${part({ alg: 'RS256', kid })}.${part({ aud: [AUD], iss: `https://${TEAM}`, iat: now, exp: now + 600, ...claims })}`;
  return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}

const asUser = (email = 'rod@example.com', extra) => ({ 'cf-access-jwt-assertion': accessToken({ email, ...extra }) });
const asDevice = (clientId = 'rod.access') => ({ 'cf-access-jwt-assertion': accessToken({ common_name: clientId, email: '' }) });

function withAccess(options, fn) {
  const upstream = options.fetchImpl || (async () => new Response('{}', { status: 500 }));
  return withServer({ access: { teamDomain: TEAM, audience: AUD }, config: accessConfig, ...options, fetchImpl: accessFetch(upstream) }, fn);
}

test('access: a known user is let in and sees who they and their partner are', async () => {
  await withAccess({}, async (base) => {
    assert.equal((await fetch(`${base}/`, { headers: asUser() })).status, 200);
    const info = await (await fetch(`${base}/api/info`, { headers: asUser('ROD@example.com') })).json();
    assert.deepEqual(info.user, { email: 'rod@example.com', name: 'Rod' });
    assert.deepEqual(info.partner, { email: 'ampy@example.com', name: 'Ampy' });
  });
});

test('access: a known device reaches /api/device/ and nothing else', async () => {
  await withAccess({}, async (base) => {
    // Past the check with nothing sent to it yet: nothing new.
    assert.equal((await fetch(`${base}/api/device/frame`, { headers: asDevice() })).status, 204);
    assert.equal((await fetch(`${base}/`, { headers: asDevice() })).status, 403);
    assert.equal((await fetch(`${base}/api/info`, { headers: asDevice() })).status, 403);
    assert.equal((await fetch(`${base}/api/device/frame`, { headers: asUser() })).status, 403);
  });
});

test('access: unknown people and devices are refused', async () => {
  await withAccess({}, async (base) => {
    assert.equal((await fetch(`${base}/`, { headers: asUser('someone@example.com') })).status, 403);
    assert.equal((await fetch(`${base}/api/device/frame`, { headers: asDevice('other.access') })).status, 403);
    assert.equal((await fetch(`${base}/`, { headers: { 'cf-access-jwt-assertion': accessToken({}) } })).status, 403);
  });
});

test('access: bad, expired, foreign and missing tokens are refused', async () => {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const [h, p, sig] = accessToken({ email: 'ampy@example.com' }).split('.');
  const altered = [h, b64({ ...JSON.parse(Buffer.from(p, 'base64url')), email: 'rod@example.com' }), sig].join('.');
  const unsigned = [b64({ alg: 'none' }), b64({ email: 'rod@example.com', aud: [AUD], iss: `https://${TEAM}`, exp: now + 600 }), ''].join('.');
  const refused = {
    'no token': {},
    'not a token': { 'cf-access-jwt-assertion': 'nonsense' },
    'bad signature': { 'cf-access-jwt-assertion': accessToken({ email: 'rod@example.com' }, { key: stranger.privateKey }) },
    'unknown key': { 'cf-access-jwt-assertion': accessToken({ email: 'rod@example.com' }, { kid: 'k2' }) },
    'altered claims': { 'cf-access-jwt-assertion': altered },
    'alg none': { 'cf-access-jwt-assertion': unsigned },
    'expired': asUser('rod@example.com', { exp: now - 3600 }),
    'wrong audience': asUser('rod@example.com', { aud: ['other-app'] }),
    'wrong team': asUser('rod@example.com', { iss: 'https://other.cloudflareaccess.com' }),
  };
  await withAccess({}, async (base) => {
    for (const [why, headers] of Object.entries(refused)) {
      assert.equal((await fetch(`${base}/`, { headers })).status, 401, why);
    }
  });
});

test('access: health still answers with no credentials, and TOKEN is not needed', async () => {
  await withAccess({ token: 'secret' }, async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(await res.json()).sort(), ['ok', 'uptime']);
    assert.equal((await fetch(`${base}/`, { headers: asUser() })).status, 200);
    const manifest = await (await fetch(`${base}/manifest.webmanifest`, { headers: asUser() })).json();
    assert.equal(manifest.start_url, '/');
  });
});

test('access: a new generation records who made it', async () => {
  const imagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eink-'));
  const fetchImpl = async () => new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 });
  try {
    await withAccess({ apiKey: 'sk-test', imagesDir, fetchImpl }, async (base) => {
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...asUser('ampy@example.com') },
        body: JSON.stringify({ prompt: 'a fox' }),
      });
      const { saved } = await res.json();
      const meta = JSON.parse(await fs.readFile(path.join(imagesDir, `${saved}.json`), 'utf8'));
      assert.equal(meta.createdBy, 'ampy@example.com');
    });
  } finally {
    await fs.rm(imagesDir, { recursive: true, force: true });
  }
});

test('access: the signing keys are fetched once, not per request', async () => {
  let fetched = 0;
  const serve = accessFetch(async () => new Response('{}', { status: 500 }));
  const fetchImpl = async (url, init) => {
    if (url.includes('/cdn-cgi/access/certs')) fetched += 1;
    return serve(url, init);
  };
  await withServer({ access: { teamDomain: `https://${TEAM}/`, audience: AUD }, config: accessConfig, fetchImpl }, async (base) => {
    for (let i = 0; i < 3; i += 1) assert.equal((await fetch(`${base}/`, { headers: asUser() })).status, 200);
    assert.equal(fetched, 1);
  });
});

test('access: unreachable signing keys mean 503, not a way in', async () => {
  const fetchImpl = async () => new Response('down', { status: 502 });
  const quiet = console.error;
  console.error = () => {};
  try {
    await withServer({ access: { teamDomain: TEAM, audience: AUD }, config: accessConfig, fetchImpl }, async (base) => {
      assert.equal((await fetch(`${base}/`, { headers: asUser() })).status, 503);
    });
  } finally {
    console.error = quiet;
  }
});

test('local stand-ins act as a user on the website and as a device on /api/device/', async () => {
  await withServer({ config: accessConfig, devUser: 'ampy@example.com', devDevice: 'rod-display' }, async (base) => {
    assert.deepEqual((await (await fetch(`${base}/api/info`)).json()).user, { email: 'ampy@example.com', name: 'Ampy' });
    assert.equal((await fetch(`${base}/api/device/frame`)).status, 204);
  });
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/api/device/frame`)).status, 403);
    assert.equal((await (await fetch(`${base}/api/info`)).json()).user, null);
  });
  assert.throws(() => createApp({ config: accessConfig, devUser: 'nobody@example.com' }), /DEV_USER/);
});

test('config.json mistakes stop the server instead of locking someone out', () => {
  assert.throws(() => parseConfig({ users: [{ email: 'a@x', partner: 'b@x' }] }), /partner/);
  assert.throws(() => parseConfig({ users: [{ email: 'a@x' }, { email: 'A@x' }] }), /twice/);
  assert.throws(() => parseConfig({ users: [{ email: 'a@x' }], devices: [{ id: 'd', clientId: 'c', owner: 'b@x' }] }), /owner/);
  assert.throws(() => parseConfig({ users: [{ email: 'a@x' }], devices: [{ id: '../d', clientId: 'c', owner: 'a@x' }] }), /device id/);
  assert.throws(() => parseConfig({ users: [{ email: 'a@x' }], devices: [{ id: 'd', owner: 'a@x' }] }), /clientId/);
});

// Sending: the stand-in user is Rod, whose partner Ampy owns ampy-display.
const sendConfig = parseConfig({
  users: [
    { email: 'rod@example.com', name: 'Rod', partner: 'ampy@example.com' },
    { email: 'ampy@example.com', name: 'Ampy', partner: 'rod@example.com' },
    { email: 'solo@example.com', name: 'Solo' },
  ],
  devices: [
    { id: 'rod-display', clientId: 'rod.access', owner: 'rod@example.com' },
    { id: 'ampy-display', clientId: 'ampy.access', owner: 'ampy@example.com' },
  ],
});
// All white (code 1 in both nibbles), the right size for the panel.
const whiteFrame = Buffer.alloc(28_800, 0x11);
// Only what the server reads of a PNG: the signature and the IHDR width and height.
function fakePng(width = 240, height = 240) {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

async function withSendServer(options, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eink-'));
  const imagesDir = path.join(dir, 'images');
  const inboxDir = path.join(dir, 'inbox');
  const fetchImpl = async () => new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 });
  try {
    await withServer({ apiKey: 'sk-test', imagesDir, inboxDir, fetchImpl, config: sendConfig, devUser: 'rod@example.com', ...options }, (base) => fn(base, { imagesDir, inboxDir }));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function sendImage(base, body) {
  return fetch(`${base}/api/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

test('send: a stored generation goes to the partner\'s display', async () => {
  await withSendServer({}, async (base, { imagesDir, inboxDir }) => {
    const { saved } = await (await generate(base, { prompt: 'a fox' })).json();
    const res = await sendImage(base, { name: saved, frame: whiteFrame.toString('base64') });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { sent: saved, to: 'Ampy', panel: '1.54', orientation: 'landscape', devices: ['ampy-display'] });
    assert.deepEqual(await fs.readFile(path.join(imagesDir, `${saved}-240.bin`)), whiteFrame);

    const inbox = JSON.parse(await fs.readFile(path.join(inboxDir, 'ampy-display.json'), 'utf8'));
    assert.equal(inbox.frame, saved);
    assert.equal(inbox.sentBy, 'rod@example.com');
    assert.ok(Date.parse(inbox.sentAt));
    assert.equal(inbox.deliveredAt, null);
    assert.deepEqual(await fs.readdir(inboxDir), ['ampy-display.json']);
  });
});

test('send: a converted image gets its own stored entry, and a newer send replaces the frame', async () => {
  await withSendServer({}, async (base, { imagesDir, inboxDir }) => {
    const first = await (await sendImage(base, { image: fakePng().toString('base64'), frame: whiteFrame.toString('base64') })).json();
    assert.match(first.sent, /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{6}$/);
    assert.deepEqual((await fs.readdir(imagesDir)).sort(), [`${first.sent}-240.bin`, `${first.sent}-240.png`, `${first.sent}.json`]);
    assert.deepEqual(await fs.readFile(path.join(imagesDir, `${first.sent}-240.png`)), fakePng());
    const meta = JSON.parse(await fs.readFile(path.join(imagesDir, `${first.sent}.json`), 'utf8'));
    assert.equal(meta.source, 'upload');
    assert.equal(meta.createdBy, 'rod@example.com');

    await new Promise((resolve) => setTimeout(resolve, 5));
    const black = Buffer.alloc(28_800, 0x00).toString('base64');
    const second = await (await sendImage(base, { image: fakePng().toString('base64'), frame: black })).json();
    const inbox = JSON.parse(await fs.readFile(path.join(inboxDir, 'ampy-display.json'), 'utf8'));
    assert.equal(inbox.frame, second.sent);
    assert.notEqual(second.sent, first.sent);
  });
});

test('send: wrong frames, names and images are refused', async () => {
  await withSendServer({}, async (base, { inboxDir }) => {
    const { saved } = await (await generate(base, { prompt: 'a fox' })).json();
    const frame = whiteFrame.toString('base64');
    const image = fakePng().toString('base64');
    const refused = [
      [400, 'short frame', { name: saved, frame: Buffer.alloc(28_799, 0x11).toString('base64') }],
      [400, 'long frame', { name: saved, frame: Buffer.alloc(28_801, 0x11).toString('base64') }],
      [400, 'no frame', { name: saved }],
      [400, 'not an ink', { name: saved, frame: Buffer.alloc(28_800, 0x14).toString('base64') }],
      [400, 'name and image', { name: saved, image, frame }],
      [400, 'neither', { frame }],
      [400, 'bad name', { name: '../server', frame }],
      [404, 'unknown name', { name: '2000-01-01T00-00-00-000Z-abcdef', frame }],
      [400, 'not a PNG', { image: 'aGVsbG8=', frame }],
      [400, 'wrong size PNG', { image: fakePng(1024, 1024).toString('base64'), frame }],
    ];
    for (const [status, why, body] of refused) assert.equal((await sendImage(base, body)).status, status, why);
    assert.equal((await fetch(`${base}/api/send`)).status, 405);
    await assert.rejects(fs.readdir(inboxDir));
  });
});

test('send: needs a user with a partner who has a display', async () => {
  const body = { image: fakePng().toString('base64'), frame: whiteFrame.toString('base64') };
  await withSendServer({ devUser: '' }, async (base) => {
    assert.equal((await sendImage(base, body)).status, 403);
  });
  await withSendServer({ devUser: 'solo@example.com' }, async (base) => {
    assert.equal((await sendImage(base, body)).status, 409);
  });
  const noDisplay = parseConfig({ users: [{ email: 'a@x', partner: 'b@x' }, { email: 'b@x', partner: 'a@x' }] });
  await withSendServer({ config: noDisplay, devUser: 'a@x' }, async (base) => {
    assert.equal((await sendImage(base, body)).status, 409);
  });
});

test('send: broadcast goes to every display, the sender\'s own included', async () => {
  await withSendServer({}, async (base, { inboxDir }) => {
    const { saved } = await (await generate(base, { prompt: 'a fox' })).json();
    const res = await sendImage(base, { name: saved, frame: whiteFrame.toString('base64'), to: 'all' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { sent: saved, to: 'all', panel: '1.54', orientation: 'landscape', devices: ['rod-display', 'ampy-display'] });
    assert.deepEqual((await fs.readdir(inboxDir)).sort(), ['ampy-display.json', 'rod-display.json']);
    for (const file of ['ampy-display.json', 'rod-display.json']) {
      assert.equal(JSON.parse(await fs.readFile(path.join(inboxDir, file), 'utf8')).frame, saved, file);
    }
  });
});

test('send: broadcast needs no partner, and to is only "all"', async () => {
  const body = { image: fakePng().toString('base64'), frame: whiteFrame.toString('base64') };
  await withSendServer({ devUser: 'solo@example.com' }, async (base, { inboxDir }) => {
    const res = await sendImage(base, { ...body, to: 'all' });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).devices, ['rod-display', 'ampy-display']);
    assert.equal((await sendImage(base, { ...body, to: 'ampy-display' })).status, 400);
  });
  await withSendServer({ devUser: '' }, async (base) => {
    assert.equal((await sendImage(base, { ...body, to: 'all' })).status, 403);
  });
});

// Moves a preview's rollback time into the past, as if its minute were up.
async function expirePreview(file) {
  const entry = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...entry, revertAt: new Date(Date.now() - 1000).toISOString() }));
}

test('preview: on the sender\'s own display for two minutes, then its frame from before is back', async () => {
  await withSendServer({ devUser: 'rod@example.com', devDevice: 'rod-display' }, async (base, { inboxDir }) => {
    const send = (extra) => sendImage(base, { image: fakePng().toString('base64'), frame: whiteFrame.toString('base64'), ...extra }).then((r) => r.json());
    // Broadcast, so Rod's own display has a frame to go back to.
    const before = (await send({ to: 'all' })).sent;
    assert.equal((await ack(base, before)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const shown = await send({ preview: true });
    assert.equal(shown.preview, true);
    assert.equal(shown.to, 'Rod');
    assert.deepEqual(shown.devices, ['rod-display']);
    assert.ok(Math.abs(Date.parse(shown.revertAt) - Date.now() - 120_000) < 5000);
    // The partner's display is left alone.
    assert.equal(JSON.parse(await fs.readFile(path.join(inboxDir, 'ampy-display.json'), 'utf8')).frame, before);
    const file = path.join(inboxDir, 'rod-display.json');
    const res = await fetch(`${base}/api/device/frame?after=${before}`);
    assert.equal(res.headers.get('x-frame-id'), shown.sent);

    // A second preview still goes back to the frame from before both.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await send({ preview: true });
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).previous.frame, before);

    await expirePreview(file);
    const back = await fetch(`${base}/api/device/frame?after=${again.sent}`);
    assert.equal(back.status, 200);
    assert.equal(back.headers.get('x-frame-id'), before);
    const restored = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(restored.frame, before);
    assert.equal(restored.deliveredAt, null);
    assert.equal(restored.preview, undefined);
  });
});

test('preview: a broadcast ends it; preview is a boolean, not with to, and needs a display of your own', async () => {
  const body = { image: fakePng().toString('base64'), frame: whiteFrame.toString('base64') };
  await withSendServer({ devUser: 'rod@example.com', devDevice: 'rod-display' }, async (base, { inboxDir }) => {
    await sendImage(base, { ...body, preview: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const kept = (await (await sendImage(base, { ...body, to: 'all' })).json()).sent;
    await expirePreview(path.join(inboxDir, 'rod-display.json'));
    assert.equal((await fetch(`${base}/api/device/frame`)).headers.get('x-frame-id'), kept);
    assert.equal((await sendImage(base, { ...body, preview: 'yes' })).status, 400);
    assert.equal((await sendImage(base, { ...body, preview: true, to: 'all' })).status, 400);
  });
  await withSendServer({ devUser: 'solo@example.com' }, async (base) => {
    assert.equal((await sendImage(base, { ...body, preview: true })).status, 409);
  });
});

test('preview: deleting the frame a preview goes back to keeps it', async () => {
  await withSendServer({}, async (base, { imagesDir }) => {
    const { saved } = await (await generate(base, { prompt: 'a fox' })).json();
    await sendImage(base, { name: saved, frame: whiteFrame.toString('base64'), to: 'all' });
    await sendImage(base, { image: fakePng().toString('base64'), frame: whiteFrame.toString('base64'), preview: true });
    // Gone from Ampy's inbox by a newer send; only Rod's preview still goes back to it.
    await sendImage(base, { image: fakePng().toString('base64'), frame: whiteFrame.toString('base64') });
    const res = await fetch(`${base}/api/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: saved }) });
    assert.equal((await res.json()).frameKept, true);
    await fs.access(path.join(imagesDir, `${saved}-240.bin`));
  });
});

// Device endpoints: Rod (the stand-in user) sends, Ampy's display (the
// stand-in device) fetches and acknowledges.
const asAmpyDisplay = { devUser: 'rod@example.com', devDevice: 'ampy-display' };
const ack = (base, frame) => fetch(`${base}/api/device/ack?frame=${encodeURIComponent(frame)}`, { method: 'POST' });

test('device: nothing sent yet, or nothing newer, is 204', async () => {
  await withSendServer(asAmpyDisplay, async (base) => {
    const empty = await fetch(`${base}/api/device/frame`);
    assert.equal(empty.status, 204);
    assert.equal((await empty.arrayBuffer()).byteLength, 0);

    const { sent } = await (await sendImage(base, { image: fakePng().toString('base64'), frame: whiteFrame.toString('base64') })).json();
    assert.equal((await fetch(`${base}/api/device/frame?after=${sent}`)).status, 204);
  });
});

test('device: a new frame comes back raw with its id', async () => {
  await withSendServer(asAmpyDisplay, async (base) => {
    const { sent } = await (await sendImage(base, { image: fakePng().toString('base64'), frame: whiteFrame.toString('base64') })).json();
    for (const query of ['', '?after=', '?after=2000-01-01T00-00-00-000Z-abcdef']) {
      const res = await fetch(`${base}/api/device/frame${query}`);
      assert.equal(res.status, 200, query);
      assert.equal(res.headers.get('content-type'), 'application/octet-stream');
      assert.equal(res.headers.get('content-length'), '28800');
      assert.equal(res.headers.get('x-frame-id'), sent);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), whiteFrame);
    }
    assert.equal((await fetch(`${base}/api/device/frame`, { method: 'POST' })).status, 405);
  });
});

test('device: the acknowledge records when the current frame was delivered', async () => {
  await withSendServer(asAmpyDisplay, async (base, { inboxDir }) => {
    assert.equal((await ack(base, 'anything')).status, 404);

    const send = () => sendImage(base, { image: fakePng().toString('base64'), frame: whiteFrame.toString('base64') });
    const first = (await (await send()).json()).sent;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = (await (await send()).json()).sent;

    // Superseded while it was drawing: the newer frame stays undelivered.
    assert.equal((await ack(base, first)).status, 409);
    const res = await ack(base, second);
    assert.equal(res.status, 200);
    const { deliveredAt } = await res.json();
    const inbox = JSON.parse(await fs.readFile(path.join(inboxDir, 'ampy-display.json'), 'utf8'));
    assert.equal(inbox.frame, second);
    assert.equal(inbox.deliveredAt, deliveredAt);

    // Acknowledging again keeps the first time.
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await (await ack(base, second)).json()).deliveredAt, deliveredAt);
    assert.equal((await fetch(`${base}/api/device/ack?frame=${second}`)).status, 405);
  });
});

test('device: a send and an acknowledge at the same moment do not lose the new frame', async () => {
  await withSendServer(asAmpyDisplay, async (base, { inboxDir }) => {
    const send = () => sendImage(base, { image: fakePng().toString('base64'), frame: whiteFrame.toString('base64') });
    const first = (await (await send()).json()).sent;
    const [, newer] = await Promise.all([ack(base, first), send().then((r) => r.json())]);
    const inbox = JSON.parse(await fs.readFile(path.join(inboxDir, 'ampy-display.json'), 'utf8'));
    assert.equal(inbox.frame, newer.sent);
    assert.equal(inbox.deliveredAt, null);
  });
});

test('device: every call records when the display was last seen, shown in /api/info', async () => {
  await withSendServer(asAmpyDisplay, async (base, { inboxDir }) => {
    const before = (await (await fetch(`${base}/api/info`)).json()).displays;
    assert.deepEqual(before, [
      { id: 'rod-display', owner: 'Rod', panel: '1.54', orientation: 'landscape', lastSeen: null },
      { id: 'ampy-display', owner: 'Ampy', panel: '1.54', orientation: 'landscape', lastSeen: null },
    ]);

    assert.equal((await fetch(`${base}/api/device/frame`)).status, 204);
    const seen = await fs.readFile(path.join(inboxDir, 'ampy-display.seen'), 'utf8');
    assert.ok(Math.abs(Date.parse(seen) - Date.now()) < 5000);
    const after = (await (await fetch(`${base}/api/info`)).json()).displays;
    assert.deepEqual(after.map((d) => d.lastSeen), [null, seen]);
  });
});

test('device: only a known display, and only its own inbox', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eink-'));
  const imagesDir = path.join(dir, 'images');
  const inboxDir = path.join(dir, 'inbox');
  try {
    await withAccess({ imagesDir, inboxDir, config: sendConfig }, async (base) => {
      const rod = { 'cf-access-jwt-assertion': accessToken({ email: 'rod@example.com' }), 'content-type': 'application/json' };
      const display = (clientId) => ({ 'cf-access-jwt-assertion': accessToken({ common_name: clientId, email: '' }) });
      const body = JSON.stringify({ image: fakePng().toString('base64'), frame: whiteFrame.toString('base64') });
      const { sent } = await (await fetch(`${base}/api/send`, { method: 'POST', headers: rod, body })).json();

      assert.equal((await fetch(`${base}/api/device/frame`, { headers: display('ampy.access') })).status, 200);
      // Rod's own display has nothing: what Rod sends goes to Ampy's.
      assert.equal((await fetch(`${base}/api/device/frame`, { headers: display('rod.access') })).status, 204);
      assert.equal((await fetch(`${base}/api/device/ack?frame=${sent}`, { method: 'POST', headers: display('rod.access') })).status, 404);
      assert.equal((await fetch(`${base}/api/device/frame`, { headers: display('other.access') })).status, 403);
      assert.equal((await fetch(`${base}/api/device/frame`, { headers: rod })).status, 403);
      assert.equal((await fetch(`${base}/api/device/ack?frame=${sent}`, { method: 'POST', headers: rod })).status, 403);
      assert.equal((await fetch(`${base}/api/device/frame`)).status, 401);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function deleteImage(base, name) {
  return fetch(`${base}/api/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
}

test('delete removes a generation and drops it from history', async () => {
  await withSendServer({}, async (base, { imagesDir }) => {
    const { saved } = await (await generate(base, { prompt: 'a fox' })).json();
    await fs.writeFile(path.join(imagesDir, `${saved}-240.png`), fakePng());
    await fs.writeFile(path.join(imagesDir, 'notes.txt'), 'keep me');

    const res = await deleteImage(base, saved);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deleted: saved, frameKept: false });
    assert.deepEqual(await fs.readdir(imagesDir), ['notes.txt']);
    assert.deepEqual((await (await fetch(`${base}/api/generations`)).json()).generations, []);

    assert.equal((await deleteImage(base, saved)).status, 404);
    assert.equal((await deleteImage(base, '../server')).status, 400);
    assert.equal((await fetch(`${base}/api/delete`)).status, 405);
  });
});

test('delete keeps the frame a display is still showing', async () => {
  await withSendServer(asAmpyDisplay, async (base, { imagesDir }) => {
    const { saved } = await (await generate(base, { prompt: 'a fox' })).json();
    await sendImage(base, { name: saved, frame: whiteFrame.toString('base64') });

    assert.deepEqual(await (await deleteImage(base, saved)).json(), { deleted: saved, frameKept: true });
    assert.deepEqual(await fs.readdir(imagesDir), [`${saved}-240.bin`]);
    // Ampy's display can still fetch what it was sent.
    const frame = await fetch(`${base}/api/device/frame`);
    assert.equal(frame.status, 200);
    assert.deepEqual(Buffer.from(await frame.arrayBuffer()), whiteFrame);
  });
});

// Ampy has a 1.54inch display and a 7.3inch one.
const panelConfig = parseConfig({
  users: [
    { email: 'rod@example.com', name: 'Rod', partner: 'ampy@example.com' },
    { email: 'ampy@example.com', name: 'Ampy', partner: 'rod@example.com' },
  ],
  devices: [
    { id: 'ampy-small', clientId: 'ampy-small.access', owner: 'ampy@example.com' },
    { id: 'ampy-large', clientId: 'ampy-large.access', owner: 'ampy@example.com', panel: '7.3' },
  ],
});
// White in the 7.3's codes, the right size for that panel.
const whiteLarge = Buffer.alloc(192_000, 0x11);
const postJson = (base, route, body) => fetch(`${base}${route}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('panels: config gives each display a panel, 1.54 unless it says otherwise', () => {
  const config = parseConfig({
    users: [{ email: 'a@x' }],
    devices: [{ id: 'd', clientId: 'c', owner: 'a@x' }, { id: 'e', clientId: 'f', owner: 'a@x', panel: '7.3' }],
  });
  assert.equal(config.devices.get('c').panel, '1.54');
  assert.equal(config.devices.get('f').panel, '7.3');
  assert.throws(() => parseConfig({ users: [{ email: 'a@x' }], devices: [{ id: 'd', clientId: 'c', owner: 'a@x', panel: '2.9' }] }), /panel 2\.9/);
  assert.throws(() => parseConfig({ users: [{ email: 'a@x' }], devices: [{ id: 'd', clientId: 'c', owner: 'a@x', panel: 'constructor' }] }), /panel constructor/);
});

test('panels: a 7.3 generation asks for the landscape size and records its panel', async () => {
  const sizes = [];
  const fetchImpl = async (url, init) => {
    sizes.push(JSON.parse(init.body).size);
    return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 });
  };
  const imagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eink-'));
  try {
    await withServer({ apiKey: 'sk-test', imagesDir, fetchImpl }, async (base) => {
      const large = await (await generate(base, { prompt: 'a fox', panel: '7.3' })).json();
      await (await generate(base, { prompt: 'a fox' })).json();
      assert.deepEqual(sizes, ['1536x1024', '1024x1024']);
      const meta = JSON.parse(await fs.readFile(path.join(imagesDir, `${large.saved}.json`), 'utf8'));
      assert.equal(meta.panel, '7.3');

      assert.equal((await generate(base, { prompt: 'a fox', panel: '2.9' })).status, 400);
      assert.equal(sizes.length, 2);

      const { generations } = await (await fetch(`${base}/api/generations`)).json();
      assert.deepEqual(generations.map((g) => g.panel).sort(), ['1.54', '7.3']);
    });
  } finally {
    await fs.rm(imagesDir, { recursive: true, force: true });
  }
});

test('panels: each panel keeps its own dithered copy, named by its width', async () => {
  const imagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eink-'));
  const fetchImpl = async () => new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 });
  try {
    await withServer({ apiKey: 'sk-test', imagesDir, fetchImpl }, async (base) => {
      const { saved } = await (await generate(base, { prompt: 'a fox', panel: '7.3' })).json();
      const copy = await postJson(base, '/api/dithered', { name: saved, image: fakePng(800, 480).toString('base64') });
      assert.deepEqual(await copy.json(), { saved: `${saved}-800.png` });
      assert.equal((await postJson(base, '/api/dithered', { name: saved, image: fakePng(1000, 1000).toString('base64') })).status, 400);

      const { generations } = await (await fetch(`${base}/api/generations`)).json();
      assert.equal(generations[0].copy, `${saved}-800.png`);
      assert.equal((await fetch(`${base}/api/images/${saved}-800.png`)).status, 200);

      assert.equal((await deleteImage(base, saved)).status, 200);
      assert.deepEqual(await fs.readdir(imagesDir), []);
    });
  } finally {
    await fs.rm(imagesDir, { recursive: true, force: true });
  }
});

test('panels: a frame goes to every partner display, in the inbox of its panel', async () => {
  await withSendServer({ config: panelConfig }, async (base, { inboxDir }) => {
    const { saved } = await (await generate(base, { prompt: 'a fox' })).json();

    const large = await (await sendImage(base, { name: saved, frame: whiteLarge.toString('base64') })).json();
    assert.deepEqual(large, { sent: saved, to: 'Ampy', panel: '7.3', orientation: 'landscape', devices: ['ampy-small', 'ampy-large'] });
    assert.deepEqual((await fs.readdir(inboxDir)).sort(), ['ampy-large-7in3.json', 'ampy-small-7in3.json']);
    const small = await (await sendImage(base, { name: saved, frame: whiteFrame.toString('base64') })).json();
    assert.deepEqual(small.devices, ['ampy-small', 'ampy-large']);
    assert.deepEqual((await fs.readdir(inboxDir)).sort(), ['ampy-large-7in3.json', 'ampy-large.json', 'ampy-small-7in3.json', 'ampy-small.json']);
  });
});

// The 1.54 board calls /api/device/frame and the 7.3 board /api/device/frame-7in3,
// both with one display's token, as when one service token is on both boards.
async function withBothSent(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eink-'));
  const imagesDir = path.join(dir, 'images');
  const inboxDir = path.join(dir, 'inbox');
  const fetchImpl = async () => new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 });
  try {
    let saved;
    await withServer({ apiKey: 'sk-test', imagesDir, inboxDir, fetchImpl, config: panelConfig, devUser: 'rod@example.com' }, async (base) => {
      saved = (await (await generate(base, { prompt: 'a fox' })).json()).saved;
      await sendImage(base, { name: saved, frame: whiteLarge.toString('base64') });
      await sendImage(base, { name: saved, frame: whiteFrame.toString('base64') });
    });
    await withServer({ imagesDir, inboxDir, config: panelConfig, devDevice: 'ampy-small' }, (base) => fn(base, saved, inboxDir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('panels: /api/device/frame hands out only 240x240 frames, /api/device/frame-7in3 only 800x480', async () => {
  await withBothSent(async (base, saved) => {
    const small = await fetch(`${base}/api/device/frame?after=`);
    assert.equal(small.status, 200);
    assert.equal(small.headers.get('content-length'), '28800');
    assert.equal(small.headers.get('x-frame-id'), saved);
    assert.deepEqual(Buffer.from(await small.arrayBuffer()), whiteFrame);

    const large = await fetch(`${base}/api/device/frame-7in3?after=`);
    assert.equal(large.status, 200);
    assert.equal(large.headers.get('content-length'), '192000');
    assert.equal(large.headers.get('x-frame-id'), `${saved}-7in3`);
    assert.deepEqual(Buffer.from(await large.arrayBuffer()), whiteLarge);

    assert.equal((await fetch(`${base}/api/device/frame?after=${saved}`)).status, 204);
    assert.equal((await fetch(`${base}/api/device/frame-7in3?after=${saved}-7in3`)).status, 204);
    assert.equal((await fetch(`${base}/api/device/frame-7in3`, { method: 'POST' })).status, 405);
  });
});

test('panels: with nothing of its size sent, a route answers 204', async () => {
  await withSendServer({ config: panelConfig, devDevice: 'ampy-small' }, async (base) => {
    const { saved } = await (await generate(base, { prompt: 'a fox' })).json();
    await sendImage(base, { name: saved, frame: whiteLarge.toString('base64') });
    assert.equal((await fetch(`${base}/api/device/frame`)).status, 204);
    assert.equal((await fetch(`${base}/api/device/frame-7in3`)).status, 200);
  });
});

test('panels: each board acknowledges its own frame, the id says which', async () => {
  await withBothSent(async (base, saved, inboxDir) => {
    const res = await ack(base, `${saved}-7in3`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).frame, `${saved}-7in3`);
    const inbox = (file) => fs.readFile(path.join(inboxDir, file), 'utf8').then(JSON.parse);
    assert.ok((await inbox('ampy-small-7in3.json')).deliveredAt);
    assert.equal((await inbox('ampy-small.json')).deliveredAt, null);
    assert.equal((await ack(base, saved)).status, 200);
    assert.ok((await inbox('ampy-small.json')).deliveredAt);
    assert.equal((await ack(base, '2000-01-01T00-00-00-000Z-abcdef-7in3')).status, 409);
  });
});

test('panels: a frame with a color its panel lacks, or the wrong size, is refused', async () => {
  await withSendServer({ config: panelConfig }, async (base) => {
    const { saved } = await (await generate(base, { prompt: 'a fox' })).json();
    // Both panels use codes 0-3, 5 and 6; code 4 and 7 are inks on neither.
    const four = await sendImage(base, { name: saved, frame: Buffer.alloc(192_000, 0x44).toString('base64') });
    assert.equal(four.status, 400);
    assert.deepEqual(await four.json(), { error: 'frame holds a color the panel does not have' });
    const seven = await sendImage(base, { name: saved, frame: Buffer.alloc(28_800, 0x77).toString('base64') });
    assert.equal(seven.status, 400);
    const green = await sendImage(base, { name: saved, frame: Buffer.alloc(192_000, 0x66).toString('base64') });
    assert.equal(green.status, 200);
    const other = await sendImage(base, { name: saved, frame: Buffer.alloc(100, 0x11).toString('base64') });
    assert.equal(other.status, 400);
    assert.match((await other.json()).error, /28800 or 192000 bytes/);
  });
});

test('panels: a converted image must be the size of its frame\'s panel', async () => {
  await withSendServer({ config: panelConfig }, async (base, { imagesDir }) => {
    const bad = await sendImage(base, { image: fakePng().toString('base64'), frame: whiteLarge.toString('base64') });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'image must be 800x480' });

    const good = await (await sendImage(base, { image: fakePng(800, 480).toString('base64'), frame: whiteLarge.toString('base64') })).json();
    assert.equal(good.panel, '7.3');
    assert.deepEqual((await fs.readdir(imagesDir)).sort(), [`${good.sent}-800.bin`, `${good.sent}-800.png`, `${good.sent}.json`].sort());
  });
});

// A portrait 7.3 display, mounted upright, next to the landscape one.
const orientationConfig = parseConfig({
  users: [
    { email: 'rod@example.com', name: 'Rod', partner: 'ampy@example.com' },
    { email: 'ampy@example.com', name: 'Ampy', partner: 'rod@example.com' },
  ],
  devices: [
    { id: 'ampy-wide', clientId: 'ampy-wide.access', owner: 'ampy@example.com', panel: '7.3' },
    { id: 'ampy-tall', clientId: 'ampy-tall.access', owner: 'ampy@example.com', panel: '7.3', orientation: 'portrait' },
  ],
});

test('orientation: config defaults to landscape and refuses anything else', () => {
  const config = parseConfig({ users: [{ email: 'a@x' }], devices: [{ id: 'd', clientId: 'c', owner: 'a@x', orientation: 'portrait' }, { id: 'e', clientId: 'f', owner: 'a@x' }] });
  assert.equal(config.devices.get('c').orientation, 'portrait');
  assert.equal(config.devices.get('f').orientation, 'landscape');
  assert.throws(() => parseConfig({ users: [{ email: 'a@x' }], devices: [{ id: 'd', clientId: 'c', owner: 'a@x', orientation: 'upside down' }] }), /orientation upside down/);
});

test('orientation: a portrait 7.3 generation asks for the tall size and records its orientation', async () => {
  const sizes = [];
  const fetchImpl = async (url, init) => {
    sizes.push(JSON.parse(init.body).size);
    return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 });
  };
  const imagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eink-'));
  try {
    await withServer({ apiKey: 'sk-test', imagesDir, fetchImpl }, async (base) => {
      const tall = await (await generate(base, { prompt: 'a fox', panel: '7.3', orientation: 'portrait' })).json();
      assert.deepEqual(sizes, ['1024x1536']);
      const meta = JSON.parse(await fs.readFile(path.join(imagesDir, `${tall.saved}.json`), 'utf8'));
      assert.equal(meta.orientation, 'portrait');

      assert.equal((await generate(base, { prompt: 'a fox', orientation: 'sideways' })).status, 400);
      const { generations } = await (await fetch(`${base}/api/generations`)).json();
      assert.deepEqual(generations[0].view, { width: 480, height: 800 });
    });
  } finally {
    await fs.rm(imagesDir, { recursive: true, force: true });
  }
});

test('orientation: a portrait copy is named apart from the landscape one', async () => {
  const imagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eink-'));
  const fetchImpl = async () => new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 });
  try {
    await withServer({ apiKey: 'sk-test', imagesDir, fetchImpl }, async (base) => {
      const { saved } = await (await generate(base, { prompt: 'a fox', panel: '7.3', orientation: 'portrait' })).json();
      const copy = await postJson(base, '/api/dithered', { name: saved, orientation: 'portrait', image: fakePng(480, 800).toString('base64') });
      assert.deepEqual(await copy.json(), { saved: `${saved}-480-portrait.png` });
      // A landscape-sized image is not a portrait copy.
      assert.equal((await postJson(base, '/api/dithered', { name: saved, orientation: 'portrait', image: fakePng(800, 480).toString('base64') })).status, 400);

      const { generations } = await (await fetch(`${base}/api/generations`)).json();
      assert.equal(generations[0].copy, `${saved}-480-portrait.png`);
      assert.equal((await fetch(`${base}/api/images/${saved}-480-portrait.png`)).status, 200);
    });
  } finally {
    await fs.rm(imagesDir, { recursive: true, force: true });
  }
});

test('orientation: the last 7.3 frame sent is the one served, landscape or portrait', async () => {
  await withSendServer({ config: orientationConfig, devDevice: 'ampy-wide' }, async (base) => {
    const { saved } = await (await generate(base, { prompt: 'a fox' })).json();
    await sendImage(base, { name: saved, frame: whiteLarge.toString('base64'), orientation: 'portrait' });
    assert.deepEqual(Buffer.from(await (await fetch(`${base}/api/device/frame-7in3`)).arrayBuffer()), whiteLarge);
    const other = Buffer.alloc(192_000, 0x55);
    await sendImage(base, { name: saved, frame: other.toString('base64') });
    assert.deepEqual(Buffer.from(await (await fetch(`${base}/api/device/frame-7in3`)).arrayBuffer()), other);
  });
});

test('orientation: a converted image must match the orientation it is sent for', async () => {
  await withSendServer({ config: orientationConfig }, async (base, { imagesDir }) => {
    const wrong = await sendImage(base, { image: fakePng(800, 480).toString('base64'), orientation: 'portrait', frame: whiteLarge.toString('base64') });
    assert.equal(wrong.status, 400);
    assert.deepEqual(await wrong.json(), { error: 'image must be 480x800' });

    const right = await (await sendImage(base, { image: fakePng(480, 800).toString('base64'), orientation: 'portrait', frame: whiteLarge.toString('base64') })).json();
    assert.equal(right.orientation, 'portrait');
    assert.deepEqual((await fs.readdir(imagesDir)).sort(), [`${right.sent}-800-portrait.bin`, `${right.sent}-480-portrait.png`, `${right.sent}.json`].sort());
  });
});
