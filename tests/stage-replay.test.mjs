import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { StageReplay } from '../hub/stage-replay.mjs';
import { createHub } from '../hub/server.mjs';

const asset = text => ({ mime: 'audio/mpeg', buffer: Buffer.from(text) });
const frame = id => ({ messageId: id, text: 'A private cue' });
test('replay preserves bytes, hides them from snapshots, and expires on session reset', () => {
  const store = new StageReplay();
  store.add('one', frame('message-1'), 'B', asset('actual audio'));
  const [clip] = store.snapshot('one');
  assert.equal(clip.asset, undefined);
  assert.equal(store.get(clip.url, 'one').buffer.toString(), 'actual audio');
  assert.deepEqual(store.snapshot('two'), []);
  assert.equal(store.get(clip.url, 'two'), undefined);
});
test('replay bounds memory, replaces corrected audio, and evicts oldest clips', () => {
  const store = new StageReplay({ maxBytes: 6, maxClips: 2 });
  store.add('one', frame('1'), 'A', asset('aaa'));
  store.add('one', frame('2'), 'B', asset('bbb'));
  store.add('one', frame('2'), 'B', asset('c'));
  assert.equal(store.bytes, 4);
  store.add('one', frame('3'), 'A', asset('ddd'));
  assert.deepEqual(store.snapshot('one').map(clip => clip.messageId), ['2', '3']);
  store.add('one', frame('4'), 'A', asset('oversize'));
  assert.equal(store.clips.size, 2);
});
test('stage receives the original delivered clip; phone state omits replay metadata; old replay expires', async t => {
  const hub = createHub({ env: {}, lan: 'localhost', settings: { roomSenseMs: 0 } });
  t.after(() => hub.close());
  const { stageUrl } = await hub.start({ port: 0, host: '127.0.0.1' });
  const url = new URL('/ws?role=stage', stageUrl); url.protocol = 'ws:';
  const socket = new WebSocket(url);
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const directory = new URL('../public/assets/', import.meta.url);
  const filename = (await readdir(directory)).find(name => name.endsWith('.mp3'));
  assert.ok(filename);
  const received = new Promise(resolve => socket.on('message', data => {
    const event = JSON.parse(String(data));
    if (event.state?.stageAudio?.length) resolve(event.state);
  }));
  hub.session.emitSeat('A', { type: 'audio', ...frame('test-clip'), url: '/assets/' + filename });
  hub.session.publish();
  const snapshot = await received;
  assert.equal(hub.session.snapshot('A').stageAudio, undefined);
  const clip = snapshot.stageAudio[0];
  const response = await fetch(new URL(clip.url, stageUrl));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL(filename, directory)));
  hub.session.sessionId = 'new-session';
  assert.equal((await fetch(new URL(clip.url, stageUrl))).status, 404);
});
