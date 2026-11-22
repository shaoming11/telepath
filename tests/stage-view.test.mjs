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

test('the room console distinguishes permission, provider connection, live input, and errors', () => {
  const base = { link: 'live', phase: 'lobby' };
  assert.equal(stage.roomConsoleStatus({ ...base, starting: true, wanted: true }).label, 'Starting');
  assert.equal(stage.roomConsoleStatus({ ...base, wanted: true, transcription: 'waiting' }).label, 'Connecting');
  assert.deepEqual(stage.roomConsoleStatus({ ...base, wanted: true, transcription: 'live', device: 'MacBook Microphone' }),
    { tone: 'live', label: 'Transcribing', detail: 'MacBook Microphone' });
  assert.equal(stage.roomConsoleStatus({ ...base, wanted: true, transcription: 'recovering' }).label, 'Reconnecting');
  assert.equal(stage.roomConsoleStatus({ ...base, wanted: true, interrupted: true, transcription: 'live' }).label, 'Interrupted');
  assert.equal(stage.roomConsoleStatus({ ...base, transcription: 'unavailable' }).tone, 'error');
  assert.equal(stage.roomConsoleStatus({ ...base, ownedElsewhere: true }).label, 'In use');
  assert.equal(stage.roomConsoleStatus({ ...base, phase: 'reveal', wanted: true }).label, 'Off');
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

test('coach approval carries only the current cue ID', () => {
  assert.deepEqual(stage.operatorFrame('coach_ask', { beat: 'problem' }),
    { type: 'operator', action: 'coach_ask', beat: 'problem' });
  assert.equal(stage.operatorFrame('coach_ask', { beat: 'unknown' }), null);
  assert.equal(stage.operatorFrame('coach_send', { text: 'Skip to the demo.' }), null);
  assert.deepEqual(stage.operatorFrame('coach_send', { coachId: 'coach-9', text: 'Skip to the demo.' }),
    { type: 'operator', action: 'coach_send', coachId: 'coach-9' });
});

const COACH_DRAFT = {
  available: true, status: 'ready', beat: 'problem', id: 'coach-9',
  text: 'Skip to the demo.', reason: 'The pitch is running long.', source: 'maritime',
};
const LIVE_PITCH = {
  phase: 'live', preset: 'Pitch', seats: { A: { online: true }, B: { online: true } }, coach: COACH_DRAFT,
};

test('pitch coach appears only in a live Pitch take and distinguishes availability and source', () => {
  const view = (options, connected = true) => stage.pitchCoachView(stage.normalizeState({ ...LIVE_PITCH, ...options }), connected, 'problem');
  assert.equal(view({ phase: 'lobby' }), null);
  assert.equal(view({ phase: 'reveal' }), null);
  assert.equal(view({ preset: 'Party' }), null);
  assert.equal(view({ canned: true }), null);
  assert.equal(view({ coach: null }), null);
  assert.deepEqual(view({ coach: { available: false, status: 'idle' } }), {
    canAsk: true, canSend: false, draft: false, note: 'Ask the local coach for a cue.',
  });
  assert.deepEqual(view({ coach: { available: true, status: 'asking' } }), {
    canAsk: false, canSend: false, draft: false, note: 'Waiting for Maritime…',
  });
  assert.match(view({ coach: { ...COACH_DRAFT, source: 'maritime-rules' } }).note, /^Maritime rules fallback/);
  assert.match(view({ coach: { ...COACH_DRAFT, source: 'local' } }).note, /^Local fallback/);
});

test('coach send requires a connected hub, both seats, current pitch beat and idle audio', () => {
  const view = (options, connected = true, beat = 'problem') =>
    stage.pitchCoachView(stage.normalizeState({ ...LIVE_PITCH, ...options }), connected, beat);
  assert.deepEqual(view({}), { canAsk: true, canSend: true, draft: true, note: 'Maritime agent · Ready to send.' });
  assert.equal(view({}, false).canSend, false);
  assert.match(view({}, true, 'demo').note, /Ask again/);
  assert.equal(view({}, true, 'demo').canSend, false);
  const missing_seat = view({ seats: { A: { online: true } } });
  assert.equal(missing_seat.canAsk, true);
  assert.equal(missing_seat.canSend, false);
  assert.match(missing_seat.note, /Connect both seats/);
  const playing = view({ announcement: { id: 'manual-8', status: 'queued' } });
  assert.equal(playing.canSend, false);
  assert.match(playing.note, /current announcement/);
});

test('coach receipts report the approved announcement and ignore unrelated playback', () => {
  const coach = { ...COACH_DRAFT, status: 'sent', announcementId: 'announcement-10' };
  const announcement = { id: 'announcement-10', status: 'played', targets: ['A', 'B'], heard: ['A', 'B'] };
  const view = value => stage.pitchCoachView(stage.normalizeState({ ...LIVE_PITCH, coach, announcement: value }), true, 'problem');
  assert.equal(view(announcement).canSend, false);
  assert.match(view(announcement).note, /Playback confirmed on both seats/);
  assert.match(view({ ...announcement, status: 'partial', heard: ['A'] }).note, /confirmed on Seat A/);
  assert.equal(view({ ...announcement, id: 'manual-11', text: COACH_DRAFT.text }).note, 'Maritime agent · Cue sent.');
});
