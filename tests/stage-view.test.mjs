import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as stage from '../public/stage.mjs';

test('reveal compares tap bits with spoken words and distinguishes playback evidence', () => {
  const state = stage.normalizeState({
    hubId: 'pitch-hub', sessionId: '4', phase: 'reveal', bits: 3,
    log: [
      { kind: 'signal', text: 'unrecognized noise', at: 1 },
      { kind: 'message', text: "Let's show the demo.", bits: 2, at: 2, playedAt: 10 },
      { kind: 'draft', text: 'Do not count unapproved copy', at: 3 },
      { kind: 'message', text: 'Slow down.', bits: 1, at: 4 },
    ],
  });
  assert.equal(state.hubId, 'pitch-hub');
  assert.deepEqual(stage.revealSummary(state), { messages: 2, words: 6, playbackStarts: 1 });
});

test('operator room status distinguishes a local mic from an accepted ElevenLabs stream', () => {
  const waiting = stage.normalizeState({ seats: { A: { online: true, listening: true, transcription: 'recovering' } } });
  const live = stage.normalizeState({ seats: { A: { online: true, listening: true, transcription: 'live' } } });
  assert.equal(stage.roomStatus(waiting.seats.A), 'Reconnecting');
  assert.equal(stage.roomStatus(live.seats.A), 'Transcribing');
  assert.equal(stage.roomStatus({ sim: true }), 'Simulated');
});

test('the operator sends a short explicit announcement rather than a seat signal', () => {
  assert.equal(stage.operatorFrame('announce', { text: '  ' }), null);
  assert.deepEqual(stage.operatorFrame('announce', { text: '  Thirty  seconds left.   ' }),
    { type: 'operator', action: 'announce', text: 'Thirty seconds left.' });
  assert.equal(stage.operatorFrame('announce', { text: 'x'.repeat(190) }).text.length, 140);
});

test('the operator sees when a seat left during an otherwise valid announcement', () => {
  assert.match(stage.announcementNote({ status: 'failed', reason: 'seat_left', targets: ['B'], heard: [] }), /seat disconnected/i);
  assert.match(stage.announcementNote({ status: 'failed', reason: 'voice_unavailable', targets: ['A','B'], heard: [] }), /voice was unavailable/i);
});
