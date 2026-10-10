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

test('paths cannot climb out of public/', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 404);
  });
});
