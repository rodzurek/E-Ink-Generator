import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './server.js';

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
