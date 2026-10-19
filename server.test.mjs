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
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);
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
      assert.equal(generations[1].dithered, false);

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
    assert.deepEqual(await res.json(), { sent: saved, to: 'Ampy', devices: ['ampy-display'] });
    assert.deepEqual(await fs.readFile(path.join(imagesDir, `${saved}.bin`)), whiteFrame);

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
    assert.deepEqual((await fs.readdir(imagesDir)).sort(), [`${first.sent}-240.png`, `${first.sent}.bin`, `${first.sent}.json`]);
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
