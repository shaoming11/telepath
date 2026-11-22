import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
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
  const bundled = 'window.telepathy = true;\n'.repeat(100);
  const compressed = gzipSync(bundled);
  await writeFile(join(root, 'wasp-assets', 'app-abcdefgh.js'), bundled);
  await writeFile(join(root, 'wasp-assets', 'app-abcdefgh.js.gz'), compressed);
  const { stageUrl } = await hub.start({ host: '127.0.0.1', port: 0 });
  const hit = (path, options) => fetch(new URL(path, stageUrl), options);
  for (const path of ['/?sim=1&seat=A', '/stage']) {
    const response = await hit(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(await response.text(), /\/wasp-assets\/app\.js/);
  }
  assert.match((await hit('/wasp-assets/app.js')).headers.get('content-type'), /javascript/);
  const gzipped = await hit('/wasp-assets/app-abcdefgh.js', { headers: { 'Accept-Encoding': 'gzip, br' } });
  assert.equal(gzipped.headers.get('content-encoding'), 'gzip');
  assert.equal(gzipped.headers.get('content-length'), String(compressed.length));
  assert.equal(gzipped.headers.get('vary'), 'Accept-Encoding');
  assert.match(gzipped.headers.get('cache-control'), /immutable/);
  assert.equal(await gzipped.text(), bundled);
  const identity = await hit('/wasp-assets/app-abcdefgh.js', { headers: { 'Accept-Encoding': 'gzip;q=0, *;q=1' } });
  assert.equal(identity.headers.get('content-encoding'), null);
  assert.equal(identity.headers.get('content-length'), String(Buffer.byteLength(bundled)));
  assert.equal(await identity.text(), bundled);
  assert.equal((await hit('/wasp-assets/app-abcdefgh.js.gz')).status, 404);
  const alias = await hit('/index.html?sim=1', { redirect: 'manual' });
  assert.equal(alias.status, 302);
  assert.equal(alias.headers.get('location'), '/?sim=1');
  assert.equal((await hit('/info').then(response => response.json())).frontend, 'wasp');
  assert.equal((await hit('/assets/keepalive.wav', { headers: { Range: 'bytes=0-1' } })).status, 206);
  assert.equal((await hit('/stage.mjs')).status, 200);
  assert.equal((await hit('/wasp-assets/missing.js')).status, 404);
  const classic = createHub({ env: {}, lan: '127.0.0.1' });
  t.after(() => classic.close());
  assert.equal((await classic.start({ host: '127.0.0.1', port: 0 })).frontend, 'classic');
  const question = 'How did you build the UI?';
  for (const [session, answer, source] of [[hub.session, /Wasp builds React routes/, /Wasp frontend/],
    [classic.session, /HTML, CSS, and JavaScript modules/, /classic browser client/]]) {
    const at = Date.now();
    session.room.transcript.push({ text: question, at });
    const context = session.pitchContext('A', at);
    assert.match(context.project, answer);
    assert.equal(context.passages[0].id, context.frontendStack.id);
    const cue = await session.composePitchCue(context, AbortSignal.timeout(1000), performance.now());
    assert.match(cue.answer, answer);
    assert.match(cue.sources[0].name, source);
  }
});
