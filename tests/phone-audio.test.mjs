import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createAudioEngine, createDraftTracker, is_preview } from '../public/phone-audio.mjs';
import { createWorld } from './phone-fakes.mjs';

const TIMING = { audioRetryMs: 1, cueGapMs: 70 };
let world;
let restore;
let heard;
let heard_result;
let status;

beforeEach(() => {
  world = createWorld();
  restore = world.install();
  heard = [];
  heard_result = true;
  status = [];
});
afterEach(() => restore());

async function ready_engine() {
  const engine = createAudioEngine({
    volumes: { cue: 1, voice: 1 },
    timing: TIMING,
    on_status: item => status.push(item),
    on_heard: id => { heard.push(id); return heard_result; },
  });
  await engine.unlock();
  world.durations['https://hub.test/assets/cue-soft.mp3'] = 0.2;
  world.durations['https://hub.test/assets/cue-draft.mp3'] = 0.5;
  world.durations['https://hub.test/assets/cue-urgent.mp3'] = 0.2;
  await engine.preload_cues();
  world.durations['https://hub.test/assets/long.mp3'] = 4;
  world.durations['https://hub.test/assets/short.mp3'] = 1;
  world.durations['https://hub.test/assets/draft.mp3'] = 2;
  await engine.load_manifest({
    activeId: 'cache-1',
    items: [
      { key: 'A:Pitch:R1', url: '/assets/short.mp3' },
      { key: 'A:Pitch:R2', url: '/assets/long.mp3' },
    ],
  });
  await world.flush();
  return engine;
}

const context = () => world.contexts[0];
const fixed = (key, messageId) => ({ type: 'audio', cue: 'soft', key, activeId: 'cache-1', messageId });
const preview = (id, extra = {}) => ({
  type: 'audio', cue: 'draft', url: '/assets/draft.mp3', messageId: id, decisionAt: 1000, expiresAt: 7000, ...extra,
});

test('audio that was waiting for resume is dropped when the session resets before it can start', async () => {
  const engine = await ready_engine();
  const base = context().started().length;
  context().set_state('suspended');
  engine.play(fixed('A:Pitch:R1', 'message-1'));
  await world.flush();
  engine.clear_session();
  context().allow_resume();
  await world.flush();
  assert.equal(context().started().length, base, 'nothing from the old session may start after reset');
  world.advance(5000);
  assert.deepEqual(heard, []);
});

test('a live url that finishes loading after reset never plays', async () => {
  const engine = await ready_engine();
  const base = context().started().length;
  engine.play({ type: 'audio', cue: 'soft', url: '/assets/short.mp3', messageId: 'message-9' });
  engine.clear_session();
  await world.flush();
  assert.equal(context().started().length, base);
});

test('heard ack waits out a suspended context and fires once when audio actually starts', async () => {
  const engine = await ready_engine();
  engine.play(fixed('A:Pitch:R1', 'message-1'));
  context().set_state('suspended');
  world.advance(3000);
  assert.deepEqual(heard, [], 'no ack while the audio clock is frozen');
  context().set_state('running');
  world.advance(100);
  assert.deepEqual(heard, [], 'still before the speech start');
  world.advance(500);
  assert.deepEqual(heard, ['message-1']);
  world.advance(5000);
  assert.deepEqual(heard, ['message-1'], 'one ack only');
});

test('heard ack is still sent when a background timer fires after the audio already played and the context is interrupted', async () => {
  const engine = await ready_engine();
  engine.play(fixed('A:Pitch:R1', 'message-2'));
  world.advance(0);
  const speech = context().live().at(-1);
  context().currentTime = speech.startAt + 0.5;
  context().state = 'interrupted';
  world.advance(1000, { audio: false });
  assert.deepEqual(heard, ['message-2']);
});

test('a heard ack the socket could not carry is retried until it is accepted', async () => {
  const engine = await ready_engine();
  heard_result = false;
  engine.play(fixed('A:Pitch:R1', 'message-3'));
  world.advance(600);
  assert.equal(heard.length >= 1, true);
  const attempts = heard.length;
  world.advance(500);
  assert.ok(heard.length > attempts, 'keeps retrying while the link is down');
  heard_result = true;
  world.advance(300);
  const accepted = heard.length;
  world.advance(3000);
  assert.equal(heard.length, accepted, 'stops after the hub accepts it');
});

test('cancel_previews drops a queued draft before it starts and pulls the queue back', async () => {
  const engine = await ready_engine();
  engine.play(fixed('A:Pitch:R2', 'message-4'));
  await world.flush();
  engine.play(preview('draft-1'));
  await world.flush();
  const sources = context().sources.filter(source => source.startAt !== null);
  const draft_speech = sources.at(-1);
  assert.ok(draft_speech.startAt > 4, 'the draft waits behind the 4 s message');
  assert.equal(engine.cancel_previews({ message_id: 'draft-1' }) > 0, true);
  assert.equal(draft_speech.stopped, true);
  engine.play(fixed('A:Pitch:R1', 'message-5'));
  await world.flush();
  const next = context().sources.filter(source => source.startAt !== null && !source.stopped).at(-1);
  assert.ok(next.startAt < draft_speech.startAt, 'the queue no longer reserves time for the cancelled draft');
  world.advance(30000);
  assert.ok(!heard.includes('draft-1'), 'a cancelled draft is never reported as heard');
});

test('a preview that is already playing is not cut off by cancel_previews', async () => {
  const engine = await ready_engine();
  engine.play(preview('draft-2'));
  await world.flush();
  world.advance(800);
  const speech = context().live().at(-1);
  assert.ok(speech.playing);
  engine.cancel_previews({ message_id: 'draft-2' });
  assert.equal(speech.stopped, false);
  world.advance(1000);
  assert.ok(heard.includes('draft-2'));
});

test('a retired preview that finishes loading late stays silent', async () => {
  const engine = await ready_engine();
  const base = context().started().length;
  engine.play(preview('draft-3'));
  engine.cancel_previews({ message_id: 'draft-3' });
  await world.flush();
  assert.equal(context().started().length, base);
  engine.play(preview('draft-3'));
  await world.flush();
  assert.equal(context().started().length, base, 'a late frame for a retired draft is ignored');
});

test('cancel_previews without an id clears every unstarted preview and leaves fixed whispers', async () => {
  const engine = await ready_engine();
  engine.play(fixed('A:Pitch:R2', 'message-6'));
  await world.flush();
  engine.play(preview('draft-4'));
  engine.play(preview('draft-5'));
  await world.flush();
  engine.cancel_previews();
  const stopped = context().sources.filter(source => source.stopped).length;
  assert.ok(stopped >= 2);
  assert.ok(context().live().some(source => source.startAt !== null), 'the fixed whisper survives');
});

test('a preview queued past its decision window is never scheduled', async () => {
  const engine = await ready_engine();
  engine.play(fixed('A:Pitch:R2', 'message-7'));
  engine.play(fixed('A:Pitch:R2', 'message-8'));
  await world.flush();
  const before = context().started().length;
  engine.play(preview('draft-6', { decisionAt: 0, expiresAt: 3000 }));
  await world.flush();
  assert.equal(context().started().length, before, 'it would start after its 3 s window, so it is dropped');
});

test('is_preview only accepts frames carrying a decision time', () => {
  assert.equal(is_preview({ messageId: 'draft-1', decisionAt: 5 }), true);
  assert.equal(is_preview({ messageId: 'message-1' }), false);
  assert.equal(is_preview({ decisionAt: 5 }), false);
});

test('draft tracker retires replaced and cleared drafts, and expires a draft whose clearing state never arrives', () => {
  const retired = [];
  const tracker = createDraftTracker({
    set_timer: world.set_timeout, clear_timer: world.clear_timer,
    on_retire: (id, reason) => retired.push([id, reason]),
  });
  const first = { id: 'draft-1', decisionAt: 0, expiresAt: 6000 };
  tracker.observe(first);
  assert.equal(tracker.visible(first), true);
  assert.equal(tracker.can_approve(first), false, 'approval stays off until the hub reports the preview was heard');
  const heard_first = { ...first, heardAt: 800, expiresAt: 6800 };
  tracker.observe(heard_first);
  assert.equal(tracker.can_approve(heard_first), true);
  tracker.observe({ id: 'draft-2', decisionAt: 9000, expiresAt: 15000 });
  assert.deepEqual(retired, [['draft-1', 'replaced']]);
  tracker.observe(null);
  assert.deepEqual(retired.at(-1), ['draft-2', 'cleared']);

  const stuck = { id: 'draft-3', decisionAt: 0, expiresAt: 6000 };
  tracker.observe(stuck);
  world.advance(6000);
  assert.deepEqual(retired.at(-1), ['draft-2', 'cleared'], 'inside the grace period the hub state still wins');
  world.advance(1500);
  assert.deepEqual(retired.at(-1), ['draft-3', 'expired']);
  assert.equal(tracker.visible(stuck), false);
  assert.equal(tracker.can_approve({ ...stuck, heardAt: 100 }), false, 'a locally expired draft cannot be approved');
  tracker.observe(null);
  assert.equal(tracker.visible({ id: 'draft-4', decisionAt: 0, expiresAt: 6000 }), true);
});

test('draft tracker reset cancels its timer', () => {
  const retired = [];
  const tracker = createDraftTracker({ set_timer: world.set_timeout, clear_timer: world.clear_timer, on_retire: id => retired.push(id) });
  tracker.observe({ id: 'draft-1', decisionAt: 0, expiresAt: 1000 });
  tracker.reset();
  world.advance(10000);
  assert.deepEqual(retired, []);
});

test('an operator announcement queued behind speech cannot begin after leaving the live take', async () => {
  const engine = await ready_engine();
  engine.play(fixed('A:Pitch:R2', 'message-12'));
  engine.play({ type: 'audio', kind: 'announcement', cue: 'system', url: '/assets/short.mp3', messageId: 'announcement-1', expiresAfterMs: 8000 });
  await world.flush();
  assert.ok(context().sources.at(-1).startAt > 4);
  engine.cancel_announcements();
  world.advance(12_000);
  assert.deepEqual(heard, ['message-12']);
});

test('an announcement received too late to start does not echo a playback confirmation', async () => {
  const engine = await ready_engine();
  engine.play(fixed('A:Pitch:R2', 'message-13'));
  engine.play({ type: 'audio', kind: 'announcement', cue: 'system', url: '/assets/short.mp3', messageId: 'announcement-2', expiresAfterMs: 1000 });
  await world.flush();
  world.advance(12_000);
  assert.deepEqual(heard, ['message-13']);
});

test('the same cue balance applies to live notifications and calibration taps', async () => {
  const engine = await ready_engine();
  engine.play_cue('receipt');
  engine.play({ type: 'audio', cue: 'sent' });
  await world.flush();
  const [receipt, sent] = context().sources.slice(-2);
  assert.equal(receipt.destination.gain.value, 0.43);
  assert.equal(sent.destination.gain.value, 2.25);
});
