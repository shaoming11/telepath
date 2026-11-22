import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { createHub } from '../hub/server.mjs';

async function open(base, params) {
  const url = new URL('/ws?' + new URLSearchParams(params), base);
  url.protocol = 'ws:';
  const socket = new WebSocket(url);
  const frames = [];
  socket.on('message', value => frames.push(JSON.parse(String(value))));
  await once(socket, 'open');
  return {
    socket, frames,
    send(frame) { socket.send(JSON.stringify(frame)); },
    async take(predicate, after = 0) {
      for (let attempt = 0; attempt < 75; attempt += 1) {
        const frame = frames.slice(after).find(predicate);
        if (frame) return frame;
        await delay(10);
      }
      throw new Error('WebSocket did not supply the expected frame');
    },
  };
}

function stateFrame(frame) {
  return frame.type === 'state';
}

async function hubFixture(context) {
  const hub = createHub({ env: {}, settings: { roomSenseMs: 0 }, lan: 'localhost' });
  context.after(() => hub.close());
  const started = await hub.start({ port: 0, host: '127.0.0.1' });
  return { hub, base: started.stageUrl };
}

test('state includes a stable hub identity and frame scope across operator reset', async context => {
  const { base } = await hubFixture(context);
  const stage = await open(base, { role: 'stage' });
  const seat = await open(base, { role: 'seat', seat: 'A', sim: '1' });
  const previous = await seat.take(stateFrame);
  assert.match(previous.state.hubId, /^[\da-f-]{36}$/);
  const after_stage = stage.frames.length;
  stage.send({ type: 'operator', action: 'reset', sessionId: previous.state.sessionId, hubId: previous.state.hubId });
  const after = await stage.take(frame => stateFrame(frame) && frame.state.sessionId !== previous.state.sessionId, after_stage);
  assert.equal(after.state.hubId, previous.state.hubId);

  const mark = seat.frames.length;
  seat.send({ type: 'signal', id: 'late-old-signal', signal: 'R1', sessionId: previous.state.sessionId, hubId: previous.state.hubId });
  const rejected = await seat.take(frame => frame.type === 'signal_ack' && frame.id === 'late-old-signal', mark);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'session_changed');

  seat.send({ type: 'signal', id: 'signal-here', signal: 'R1', sessionId: after.state.sessionId, hubId: after.state.hubId });
  const accepted = await seat.take(frame => frame.type === 'signal_ack' && frame.id === 'signal-here');
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.sessionId, after.state.sessionId);
});

test('operator frames from a prior hub cannot control the current take', async context => {
  const { hub, base } = await hubFixture(context);
  const stage = await open(base, { role: 'stage' });
  const current = await stage.take(stateFrame);
  stage.send({ type: 'operator', action: 'canned', hubId: 'obsolete-hub', sessionId: current.state.sessionId });
  const ack = await stage.take(frame => frame.type === 'operator_ack');
  assert.equal(ack.accepted, false);
  assert.equal(ack.reason, 'session_changed');
  assert.equal(hub.session.snapshot().phase, 'lobby');
  assert.equal(hub.session.snapshot().canned, false);
});

test('a replacement closes the earlier socket before subsequent seat inputs are accepted', async context => {
  const { hub, base } = await hubFixture(context);
  const stage = await open(base, { role: 'stage' });
  const old = await open(base, { role: 'seat', seat: 'A', sim: '1' });
  old.send({ type: 'configure', mode: 1 });
  await stage.take(frame => stateFrame(frame) && frame.state.seats.A.mode === 1);
  const old_closed = once(old.socket, 'close');
  const replacement = await open(base, { role: 'seat', seat: 'A', sim: '1' });
  const [code] = await old_closed;
  assert.equal(code, 4001);
  assert.equal((await replacement.take(stateFrame)).state.seats.A.mode, 1);
  assert.equal(hub.session.snapshot().online.A, true);
  replacement.send({ type: 'configure', mode: 2 });
  await stage.take(frame => stateFrame(frame) && frame.state.seats.A.mode === 2);
});

test('the stage broadcasts one bundled system clip to both seats and sees both playback acknowledgements', async context => {
  const { base } = await hubFixture(context);
  const stage = await open(base, { role: 'stage' });
  const a = await open(base, { role: 'seat', seat: 'A', sim: '1' });
  const b = await open(base, { role: 'seat', seat: 'B', sim: '1' });
  const current = (await stage.take(frame => stateFrame(frame) && frame.state.online.A && frame.state.online.B)).state;
  stage.send({ type: 'operator', action: 'announce', text: 'Thirty seconds left.', hubId: current.hubId, sessionId: current.sessionId });
  const [clip_a, clip_b] = await Promise.all([a, b].map(seat => seat.take(frame => frame.kind === 'announcement')));
  assert.equal(clip_a.url, clip_b.url);
  assert.equal(clip_a.messageId, clip_b.messageId);
  assert.equal(clip_a.cue, 'system');
  const media = await fetch(new URL(clip_a.url, base));
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('content-type'), 'audio/mpeg');
  assert.ok((await media.arrayBuffer()).byteLength > 500);

  a.send({ type: 'heard', messageId: clip_a.messageId, hubId: current.hubId, sessionId: current.sessionId });
  const only_a = (await stage.take(frame => stateFrame(frame) && frame.state.announcement?.heard.length === 1)).state;
  assert.deepEqual(only_a.announcement.heard, ['A']);
  assert.equal(only_a.announcement.status, 'queued');
  b.send({ type: 'heard', messageId: clip_b.messageId, hubId: current.hubId, sessionId: current.sessionId });
  const complete = (await stage.take(frame => stateFrame(frame) && frame.state.announcement?.status === 'played')).state;
  assert.deepEqual(complete.announcement.heard, ['A', 'B']);
  assert.equal(complete.bits, 0);
  assert.equal(complete.log.filter(entry => entry.kind === 'announcement').length, 1);
  assert.ok(a.frames.every(frame => frame.state?.announcement == null));
});

test('loopback rehearsal advertises the address it actually listens on', async context => {
  const hub = createHub({ env: {}, lan: '192.168.31.10' });
  context.after(() => hub.close());
  const info = await hub.start({ host: '127.0.0.1', port: 0 });
  assert.equal(new URL(info.joinUrl).hostname, '127.0.0.1');
  const response = await fetch(info.joinUrl);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>Telepathy<\/title>/);
});

test('a hub without a hotspot address retains Mac rehearsal and reports phone join unavailable', async context => {
  const hub = createHub({ env: {}, lan: 'localhost' });
  context.after(() => hub.close());
  const info = await hub.start({ host: '0.0.0.0', port: 0 });
  assert.equal(info.lanAvailable, false);
  assert.equal(new URL(info.stageUrl).hostname, '127.0.0.1');
});
