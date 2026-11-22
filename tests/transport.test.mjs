import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { createCodec } from '../hub/codec.mjs';
import { createMaritimeCoach } from '../hub/maritime.mjs';
import { createHub } from '../hub/server.mjs';
import { findLanAddress, hotspotIPv6Peers } from '../hub/tls.mjs';
import { createCoachServer } from '../maritime/server.mjs';

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
    async take(predicate, after = 0, timeout = 750) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
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

test('the Mac prefers hotspot IPv6 over a CLAT address and keeps local IPv4 on ordinary Wi-Fi', () => {
  const wifi = [
    { family: 'IPv6', address: 'fe80::7', cidr: 'fe80::7/64' },
    { family: 'IPv6', address: '2001:db8:1:2::7', cidr: '2001:db8:1:2::7/64' },
    { family: 'IPv4', address: '192.0.0.2', cidr: '192.0.0.2/32' },
  ];
  assert.equal(findLanAddress({ en0: wifi }), '2001:db8:1:2::7');
  assert.equal(findLanAddress({ en0: wifi.slice(0, 2) }), 'localhost');
  assert.equal(findLanAddress({ en0: [...wifi, { family: 'IPv4', address: '172.20.10.2' }] }), '172.20.10.2');
});

test('the hotspot peer filter accepts its IPv6 subnet and rejects adjacent networks and mapped IPv4', () => {
  const accepts = hotspotIPv6Peers('2001:db8:1:2::7');
  assert.ok(accepts('2001:0db8:0001:0002:3::4'));
  assert.equal(accepts('2001:db8:1:3::8'), false);
  assert.equal(accepts('::ffff:192.168.1.23'), false);
  assert.equal(hotspotIPv6Peers('192.168.1.2'), null);
});

async function hubFixture(context, options = {}) {
  const hub = createHub({ env: {}, settings: { roomSenseMs: 0 }, lan: 'localhost', ...options });
  context.after(() => hub.close());
  const started = await hub.start({ port: 0, host: '127.0.0.1' });
  return { hub, base: started.stageUrl };
}

test('reference upload is session-scoped, atomic, lobby-only and absent from phone snapshots', async context => {
  const { hub, base } = await hubFixture(context);
  const info = await (await fetch(new URL('/info', base))).json();
  const upload = (files, sessionId = hub.session.sessionId) => fetch(new URL('/references', base), {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-telepathy-hub': info.hubId, 'x-telepathy-session': sessionId },
    body: JSON.stringify({ files }),
  });
  const document = { name: 'brief.md', data: Buffer.from('Our pilot lasts six weeks.').toString('base64') };
  assert.equal((await upload([document], 'obsolete')).status, 403);
  assert.equal((await upload([document])).status, 200);
  assert.equal(hub.session.references.length, 1);
  assert.equal(hub.session.snapshot('A').references, undefined);
  assert.equal((await upload([{ name: 'bad.exe', data: document.data }])).status, 400);
  assert.equal(hub.session.references[0].name, 'brief.md');
  hub.session.phase = 'live';
  assert.equal((await upload([])).status, 409);
  hub.session.phase = 'lobby';
  assert.equal((await upload([])).status, 200);
  assert.equal(hub.session.references.length, 0);
});

test('only the owning stage tab can stream room audio; disconnect and stale-session frames cannot keep it live', async context => {
  const audioFrames = [];
  const hub = createHub({ env: {}, audio: {
    listen: async (seat, enabled) => ({ listening: enabled }),
    mic: async (seat, audio, level, callbacks) => { audioFrames.push([seat, audio]); callbacks.committed('Shared room speech.'); },
  } });
  context.after(() => hub.close());
  const { stageUrl: base } = await hub.start({ port: 0, host: '127.0.0.1' });
  const legacyRoom = await fetch(new URL('/room', base), { redirect: 'manual' });
  assert.equal(legacyRoom.headers.get('location'), '/stage#room-microphone-panel');
  const owner = await open(base, { role: 'stage' });
  const other = await open(base, { role: 'stage' });
  const { state } = await owner.take(stateFrame);
  const scope = { hubId: state.hubId, sessionId: state.sessionId };
  owner.send({ ...scope, type: 'operator', action: 'room_listen', enabled: true });
  await owner.take(frame => frame.type === 'room_ack' && frame.listening);
  other.send({ ...scope, type: 'operator', action: 'room_listen', enabled: true });
  const rejected = await other.take(frame => frame.type === 'operator_ack');
  assert.equal(rejected.reason, 'microphone_owned');
  other.send({ ...scope, type: 'room_mic', audio: 'OTHER', level: .1 });
  owner.send({ ...scope, type: 'room_mic', audio: 'OWNER', level: .1 });
  await owner.take(frame => frame.state?.room?.transcript?.length === 1);
  assert.deepEqual(audioFrames, [['room', 'OWNER']]);
  owner.socket.close();
  await other.take(frame => frame.state?.room?.transcription === 'off' && frame.state?.room?.transcript?.length === 1);
  assert.equal(hub.session.room.listening, false);
  await hub.session.reset();
  other.send({ ...scope, type: 'operator', action: 'room_listen', enabled: true });
  await delay(20);
  assert.equal(hub.session.room.listening, false);
});

test('the Safari playback anchor supports media byte-range requests', async context => {
  const { base } = await hubFixture(context);
  const audio = new URL('/assets/keepalive.wav', base);
  const first = await fetch(audio, { headers: { Range: 'bytes=0-1' } });
  assert.equal(first.status, 206);
  assert.equal(first.headers.get('accept-ranges'), 'bytes');
  assert.match(first.headers.get('content-range'), /^bytes 0-1\/\d+$/);
  assert.equal(await first.text(), 'RI');
  const tail = await fetch(audio, { headers: { Range: 'bytes=-4' } });
  assert.equal(tail.status, 206);
  assert.equal((await tail.arrayBuffer()).byteLength, 4);
  const invalid = await fetch(audio, { headers: { Range: 'bytes=999999-' } });
  assert.equal(invalid.status, 416);
  assert.match(invalid.headers.get('content-range'), /^bytes \*\/\d+$/);
});

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
  const echo = await a.take(frame => frame.type === 'heard_ack' && frame.messageId === clip_a.messageId);
  assert.deepEqual([echo.hubId, echo.sessionId], [current.hubId, current.sessionId]);
  const duplicate_mark = a.frames.length;
  a.send({ type: 'heard', messageId: clip_a.messageId, hubId: current.hubId, sessionId: current.sessionId });
  await a.take(frame => frame.type === 'heard_ack' && frame.messageId === clip_a.messageId, duplicate_mark);
  assert.ok(b.frames.every(frame => frame.type !== 'heard_ack'));
  b.send({ type: 'heard', messageId: clip_b.messageId, hubId: current.hubId, sessionId: current.sessionId });
  const complete = (await stage.take(frame => stateFrame(frame) && frame.state.announcement?.status === 'played')).state;
  assert.deepEqual(complete.announcement.heard, ['A', 'B']);
  assert.equal(complete.bits, 0);
  assert.equal(complete.log.filter(entry => entry.kind === 'announcement').length, 1);
  assert.ok(a.frames.every(frame => frame.state?.announcement == null));
});

test('an announcement records which original seat disconnected when the other times out', async context => {
  const { base } = await hubFixture(context, { settings: { announcementPlaybackMs: 400 } });
  const stage = await open(base, { role: 'stage' });
  const a = await open(base, { role: 'seat', seat: 'A', sim: '1' });
  const b = await open(base, { role: 'seat', seat: 'B', sim: '1' });
  const { state } = await stage.take(frame => frame.state?.online.A && frame.state?.online.B);
  stage.send({ type: 'operator', action: 'announce', text: 'Thirty seconds left.',
    sessionId: state.sessionId, hubId: state.hubId });
  await Promise.all([a, b].map(seat => seat.take(frame => frame.kind === 'announcement')));
  b.socket.close();
  await stage.take(frame => frame.state?.announcement?.disconnected.includes('B'));
  const replacement = await open(base, { role: 'seat', seat: 'B', sim: '1' });
  await replacement.take(stateFrame);
  const failed = await stage.take(frame => frame.state?.announcement?.reason === 'playback_timeout');
  assert.deepEqual(failed.state.announcement.disconnected, ['B']);
  assert.deepEqual(failed.state.announcement.heard, []);
  assert.equal(failed.state.online.B, true);
});

test('the pitch coach sends a reviewed cue through the real two-seat transport', async context => {
  const live = process.env.TELEPATHY_VERIFY_MARITIME === '1';
  const env = live ? {
    TELEPATHY_MARITIME: 'on',
    MARITIME_API_KEY: process.env.MARITIME_API_KEY,
    TELEPATHY_MARITIME_AGENT_ID: process.env.TELEPATHY_MARITIME_AGENT_ID,
    TELEPATHY_MARITIME_ASSIST: process.env.TELEPATHY_MARITIME_ASSIST,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    TELEPATHY_OPENAI_MODEL: process.env.TELEPATHY_OPENAI_MODEL,
  } : {};
  const coach = live ? undefined : { recommend: async () => ({
    cueId: 'reveal-cue', reason: 'The pitch has reached closing.', source: 'maritime',
  }) };
  const { base } = await hubFixture(context, { coach, env });
  const stage = await open(base, { role: 'stage' });
  const a = await open(base, { role: 'seat', seat: 'A', sim: '1' });
  const b = await open(base, { role: 'seat', seat: 'B', sim: '1' });
  for (const seat of [a, b]) {
    for (const step of ['voice', 'earbuds', 'calibrate', 'ready']) seat.send({ type: 'setup', step, complete: true });
  }
  await Promise.all([a, b].map(async seat => {
    const cache = await seat.take(frame => frame.type === 'cache');
    seat.send({ type: 'cache_ready', activeId: cache.activeId });
  }));
  await stage.take(frame => stateFrame(frame) && frame.state.canBegin);
  stage.send({ type: 'operator', action: 'begin' });
  const liveState = (await stage.take(frame => stateFrame(frame) && frame.state.phase === 'live')).state;
  assert.equal(liveState.coach.available, true);
  const scope = { hubId: liveState.hubId, sessionId: liveState.sessionId };

  b.send({ type: 'signal', id: 'coach-proof-whisper', signal: 'R1', ...scope });
  const whisper = await a.take(frame => frame.type === 'audio' && frame.cue === 'soft' && frame.messageId);
  a.send({ type: 'heard', messageId: whisper.messageId, ...scope });
  await a.take(frame => frame.state?.seats.A.receipt?.messageId === whisper.messageId);
  a.send({ type: 'signal', id: 'coach-proof-receipt', signal: 'R1', receiptId: whisper.messageId, ...scope });
  const exchange = (await stage.take(frame => frame.state?.log.some(entry =>
    entry.kind === 'receipt' && entry.messageId === whisper.messageId))).state;

  const start = performance.now();
  stage.send({ type: 'operator', action: 'coach_ask', beat: 'closing', ...scope });
  const draft = (await stage.take(frame => frame.state?.coach?.status === 'ready', 0, 14_000)).state.coach;
  const latency = Math.round(performance.now() - start);
  const expected_source = env.TELEPATHY_MARITIME_ASSIST === 'openai' ? 'maritime-assisted' : 'maritime';
  assert.equal(draft.source, expected_source, 'the verification requires a Maritime-reviewed model cue');
  assert.equal(draft.text, 'Time to bring up the reveal.');
  for (const seat of [a, b]) {
    assert.ok(seat.frames.every(frame => frame.state?.coach == null && frame.kind !== 'announcement'));
  }

  stage.send({ type: 'operator', action: 'coach_send', coachId: draft.id, ...scope });
  const audio = await Promise.all([a, b].map(seat => seat.take(frame => frame.kind === 'announcement')));
  assert.equal(audio[0].messageId, audio[1].messageId);
  assert.equal(audio[0].url, audio[1].url);
  const clip = await fetch(new URL(audio[0].url, base));
  assert.equal(clip.headers.get('content-type'), 'audio/mpeg');
  assert.ok((await clip.arrayBuffer()).byteLength > 500);
  [a, b].forEach((seat, index) => seat.send({ type: 'heard', messageId: audio[index].messageId, ...scope }));
  const result = (await stage.take(frame => frame.state?.announcement?.status === 'played')).state;
  assert.equal(result.coach.announcementId, audio[0].messageId);
  assert.deepEqual(result.announcement.heard, ['A', 'B']);
  assert.equal(result.bits, exchange.bits);
  if (live) context.diagnostic(draft.source + ' response at the Operator in ' + latency + ' ms. Both simulated seats acknowledged the ElevenLabs clip.');
});

test('a phone request uses a prepared Maritime context plan and reports private playback through the hub', async t => {
  let prepared = 0;
  const agent = createCoachServer({ env: {} }).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => agent.close(resolve)));
  await once(agent, 'listening');
  const coach = createMaritimeCoach({
    env: { TELEPATHY_MARITIME: 'on', TELEPATHY_MARITIME_PITCH_HELP: 'on', MARITIME_API_KEY: 'stub', TELEPATHY_MARITIME_AGENT_ID: 'stub' },
    fetchImpl: async (_, request) => {
      const response = await fetch('http://127.0.0.1:' + agent.address().port + '/chat', request);
      await response.clone().json();
      prepared++;
      return response;
    },
  });
  const finalLine = 'Mac listens. Phones keep earbud controls.';
  const codec = createCodec({
    env: { OPENAI_API_KEY: 'stub' },
    fetchImpl: async (_, request) => {
      const input = JSON.parse(JSON.parse(request.body).input);
      assert.equal(input.plan.intent, 'answer');
      assert.equal(input.turns.at(-1)?.speaker, 'Speaker 1');
      const passage = input.passages.find(item => item.name === 'Telepathy pitch brief.md');
      const answer = { status: 'answer', question: 'Why the MacBook?', answer: finalLine, responseQuote: '',
        sources: [{ id: passage.id, quote: passage.text.slice(0, 50).trim() }] };
      return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] });
    },
  });
  const { base } = await hubFixture(t, {
    coach, codec, settings: { roomSenseMs: 0, pitchPlanDebounceMs: 5 },
    audio: {
      buildCache: async (seat, preset, messages) => Object.keys(messages).map(signal => ({ key: seat + ':' + preset + ':' + signal, url: '/assets/cue-system.mp3' })),
      listen: async (_, enabled) => ({ listening: enabled }),
      mic: async (_, audio, level, callbacks) => {
        callbacks.committed('Why does this pitch use the MacBook microphone?', { streamId: 1, segment: 0 });
        callbacks.diarized({ segment_index: 0, words: [{ speaker_id: 'speaker_1', text: 'Why does this pitch use the MacBook microphone?' }] }, 1);
      },
      speech: async (_, text) => { assert.equal(text, finalLine); return '/assets/cue-system.mp3'; },
    },
  });
  const stage = await open(base, { role: 'stage' });
  const a = await open(base, { role: 'seat', seat: 'A' });
  const b = await open(base, { role: 'seat', seat: 'B' });
  for (const seat of [a, b]) {
    seat.send({ type: 'setup', step: 'voice', complete: true, choice: 'premade' });
    for (const step of ['earbuds', 'calibrate', 'ready']) seat.send({ type: 'setup', step, complete: true });
  }
  await Promise.all([a, b].map(async seat => {
    const cache = await seat.take(frame => frame.type === 'cache');
    seat.send({ type: 'cache_ready', activeId: cache.activeId });
  }));
  await stage.take(frame => frame.state?.canBegin);
  stage.send({ type: 'operator', action: 'begin' });
  const { state } = await stage.take(frame => frame.state?.phase === 'live');
  const tags = { hubId: state.hubId, sessionId: state.sessionId };
  stage.send({ type: 'operator', action: 'room_listen', enabled: true, ...tags });
  await stage.take(frame => frame.type === 'room_ack' && frame.listening);
  stage.send({ type: 'room_mic', audio: 'PCM', level: 0.1, ...tags });
  const deadline = Date.now() + 750;
  while (!prepared && Date.now() < deadline) await delay(10);
  assert.equal(prepared, 1);
  a.send({ type: 'signal', signal: 'LR', purpose: 'pitch_help', id: 'phone-help', ...tags });
  const audio = await a.take(frame => frame.kind === 'pitch_help');
  assert.equal(audio.cue, 'sent');
  assert.equal(audio.text, finalLine);
  b.send({ type: 'heard', messageId: audio.messageId, ...tags });
  a.send({ type: 'heard', messageId: audio.messageId, ...tags });
  const result = await stage.take(frame => frame.state?.log.some(entry => entry.kind === 'pitch_help' && entry.requestToPlaybackMs >= 0));
  assert.equal(result.state.log.find(entry => entry.kind === 'pitch_help').source, 'maritime-rules');
  assert.equal(result.state.seats.A.receipt, null);
  assert.equal(result.state.seats.B.receipt, null);
  assert.ok(!b.frames.some(frame => frame.kind === 'pitch_help' || frame.state?.log.some(entry => entry.kind === 'pitch_help')));
  assert.equal(prepared, 1);
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
