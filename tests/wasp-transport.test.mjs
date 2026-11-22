import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHub } from '../hub/server.mjs';

test('the Wasp client owns phone and Stage navigations while the hub retains session and audio routes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'telepathy-wasp-client-'));
  const hub = createHub({ env: {}, lan: '127.0.0.1', waspClient: root });
  t.after(async () => {
    await hub.close();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'wasp-assets'));
  await writeFile(join(root, 'index.html'), '<title>Telepathy</title><script type="module" src="/wasp-assets/app.js"></script>');
  await writeFile(join(root, 'wasp-assets', 'app.js'), 'export {};');
  const { stageUrl } = await hub.start({ host: '127.0.0.1', port: 0 });
  const hit = (path, options) => fetch(new URL(path, stageUrl), options);
  for (const path of ['/?sim=1&seat=A', '/stage']) {
    const response = await hit(path);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /\/wasp-assets\/app\.js/);
  }
  assert.match((await hit('/wasp-assets/app.js')).headers.get('content-type'), /javascript/);
  const alias = await hit('/index.html?sim=1', { redirect: 'manual' });
  assert.equal(alias.status, 302);
  assert.equal(alias.headers.get('location'), '/?sim=1');
  assert.equal((await hit('/info').then(response => response.json())).frontend, 'wasp');
  assert.equal((await hit('/assets/keepalive.wav', { headers: { Range: 'bytes=0-1' } })).status, 206);
  assert.equal((await hit('/stage.mjs')).status, 200);
  assert.equal((await hit('/wasp-assets/missing.js')).status, 404);
});
