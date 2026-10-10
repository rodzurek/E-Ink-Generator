import { test } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.deepEqual(await res.json(), { image: 'aGVsbG8=' });
    assert.equal(sent.auth, 'Bearer sk-test');
    assert.equal(sent.body.prompt, 'a fox');
    assert.equal(sent.body.model, 'gpt-image-1');
  });
});

test('generate passes an upstream error message through as 502', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'billing limit' } }), { status: 400 });
  await withServer({ apiKey: 'sk-test', fetchImpl }, async (base) => {
    const res = await generate(base, { prompt: 'a fox' });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'billing limit');
  });
});

test('paths cannot climb out of public/', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 404);
  });
});
