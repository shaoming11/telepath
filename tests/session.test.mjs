import assert from 'node:assert/strict';
import test from 'node:test';
import { Session } from '../hub/session.mjs';

const EMPTY_CODEC = { evaluate: async () => ({}) };

async function createLiveSession({ audio = {}, codec = EMPTY_CODEC, coach, settings = {}, sim = { A: true, B: true } } = {}) {
  let now = 1000;
  const seatFrames = { A: [], B: [] };
  const stageFrames = [];
  const session = new Session({
    emitSeat: (seat, frame) => seatFrames[seat].push(frame),
    emitStage: frame => stageFrames.push(frame),
    audio: {
      buildCache: async (speaker, preset, messages) => Object.keys(messages).map(signal => {
        const key = [speaker, preset, signal].join(':');
        return { key, url: '/assets/' + key };
      }),
      speech: async (speaker, text) => ({ url: '/assets/' + encodeURIComponent(text) }),
      ...audio,
    },
    codec,
    coach,
    settings: { roomSenseMs: 0, ...settings },
    now: () => now,
  });

  const state = () => stageFrames.at(-1)?.state;
  const act = (seat, frame) => session.handleSeat(seat, frame);
  const audioFrames = (seat, cue) => seatFrames[seat].filter(frame => frame.type === 'audio' && frame.cue === cue);
  const ack = seat => {
    const manifest = seatFrames[seat].findLast(frame => frame.type === 'cache');
    assert.ok(manifest);
    return act(seat, { type: 'cache_ready', activeId: manifest.activeId });
  };

  await session.connect('A', sim.A);
  await session.connect('B', sim.B);
  for (const seat of ['A', 'B']) {
    for (const step of ['voice', 'earbuds', 'calibrate', 'ready']) {
      await act(seat, { type: 'setup', step, complete: true });
    }
  }
  for (const seat of ['A', 'B']) await ack(seat);
  await session.handleStage({ action: 'begin' });
  assert.equal(state().phase, 'live');
  return { session, state, seatFrames, audioFrames, ack, act, advance: ms => { now += ms; } };
}

test('fixed whisper uses the receiver cache and one receipt, even after retry', async t => {
  const { session, state, audioFrames, act, advance } = await createLiveSession();
  t.after(() => session.close());
  const signal = { type: 'signal', id: 'one', signal: 'R1' };
  await act('B', signal);
  await act('B', signal);
  assert.equal(state().bits, 2);
  assert.equal(audioFrames('B', 'sent').length, 1);
  assert.equal(audioFrames('A', 'soft').length, 1);
  const whisper = audioFrames('A', 'soft')[0];
  assert.equal(whisper.key, 'B:Pitch:R1');
  assert.equal(whisper.activeId, state().cacheId);
  assert.equal(whisper.url, undefined);

  advance(5000);
  await act('A', { type: 'heard', messageId: whisper.messageId });
  advance(3999);
  await act('A', { type: 'signal', id: 'receipt', signal: 'R1' });
  await act('A', { type: 'heard', messageId: whisper.messageId });
  assert.equal(audioFrames('B', 'receipt').length, 1);
  assert.equal(state().log.filter(entry => entry.kind === 'message').length, 1);
  assert.equal(state().log.filter(entry => entry.kind === 'receipt').length, 1);
});

test('coach suggests privately and sends the approved ElevenLabs line only once', async t => {
  const { session, state, seatFrames, audioFrames, act, advance } = await createLiveSession({
    coach: { recommend: async input => {
      assert.deepEqual(input, { beat: 'problem', elapsedSeconds: 73, onlineSeats: 2, readySeats: 2, acknowledgedMessages: 0 });
      return { cueId: 'demo-cue', reason: 'Start the working demo.', source: 'maritime' };
    } },
  });
  t.after(() => session.close());
  await act('A', { type: 'sim_transcript', text: 'This stays in Telepathy.' });
  advance(73_000);
  await session.handleStage({ action: 'coach_ask', beat: 'problem' });
  const draft = state().coach;
  assert.equal(draft.available, true);
  assert.equal(draft.status, 'ready');
  assert.equal(draft.source, 'maritime');
  assert.equal(draft.text, 'Show the working demo now.');
  for (const seat of ['A', 'B']) {
    assert.ok(seatFrames[seat].every(frame => frame.state?.coach == null));
    assert.equal(audioFrames(seat, 'system').length, 0);
  }

  await session.handleStage({ action: 'coach_send', coachId: 'old' });
  assert.equal(state().coach.status, 'ready');
  await session.handleStage({ action: 'coach_send', coachId: draft.id, text: 'A forged message.' });
  await session.handleStage({ action: 'coach_send', coachId: draft.id });
  assert.equal(state().coach.status, 'sent');
  for (const seat of ['A', 'B']) {
    const [audio] = audioFrames(seat, 'system');
    assert.equal(audioFrames(seat, 'system').length, 1);
    assert.equal(audio.text, draft.text);
    assert.equal(audio.messageId, state().coach.announcementId);
    await act(seat, { type: 'heard', messageId: audio.messageId });
  }
  assert.equal(state().announcement.status, 'played');
  assert.deepEqual(state().announcement.heard, ['A', 'B']);
  assert.equal(state().bits, 0);
});

test('a cloud timeout falls back locally without delaying a fixed tap or sending to one seat', async t => {
  let request;
  const { session, state, act, audioFrames } = await createLiveSession({
    coach: { recommend: (input, { signal }) => { request = signal; return new Promise(() => {}); } },
    settings: { coachTimeoutMs: 20 },
  });
  t.after(() => session.close());
  const waiting = session.handleStage({ action: 'coach_ask', beat: 'closing' });
  assert.equal(state().coach.status, 'asking');
  await act('B', { type: 'signal', signal: 'R1', id: 'while-coaching' });
  assert.equal(audioFrames('A', 'soft').at(-1).key, 'B:Pitch:R1');
  await waiting;
  assert.equal(request.aborted, true);
  assert.equal(state().coach.source, 'local');
  assert.equal(state().coach.text, 'Time to bring up the reveal.');

  session.disconnect('B');
  await session.handleStage({ action: 'coach_send', coachId: state().coach.id });
  assert.equal(state().coach.status, 'ready');
  assert.equal(state().announcement, null);
});

test('reveal, canned and reset discard in-flight coaching', async t => {
  for (const action of ['reveal', 'canned', 'reset']) {
    let complete;
    const { session, state } = await createLiveSession({
      coach: { recommend: () => new Promise(resolve => { complete = resolve; }) },
    });
    t.after(() => session.close());
    const waiting = session.handleStage({ action: 'coach_ask', beat: 'problem' });
    await Promise.resolve();
    await session.handleStage({ action });
    complete({ cueId: 'demo-cue', reason: 'Late result.', source: 'maritime' });
    await waiting;
    assert.equal(state().coach.status, 'idle');
    assert.equal(state().announcement, null);
    await session.close();
  }
});

test('preset swaps atomically on both cache acknowledgments', async t => {
  const { session, state, audioFrames, act, ack } = await createLiveSession();
  t.after(() => session.close());
  await session.handleStage({ action: 'preset', preset: 'Party' });
  assert.equal(state().preset, 'Pitch');
  await ack('A');
  await act('B', { type: 'signal', id: 'pitch', signal: 'R2' });
  assert.equal(audioFrames('A', 'soft').at(-1).text, 'One minute left');
  await ack('B');
  await act('B', { type: 'signal', id: 'party', signal: 'R2' });
  assert.equal(state().preset, 'Party');
  assert.equal(audioFrames('A', 'soft').at(-1).text, 'Save me from this conversation');
});

const CANDIDATE = {
  situations: { A: 'Explaining the setup', B: 'Watching the clock' },
  candidates: { B: { text: 'Show the working demo next', confidence: 0.95 } },
};

test('smart draft has a private preview and requires R1 to reach the partner', async t => {
  const calls = [];
  const { session, state, audioFrames, act, advance } = await createLiveSession({
    audio: { speech: async (seat, text, options) => {
      calls.push({ seat, text, role: options.role });
      return { url: '/assets/spoken' };
    } },
    codec: { evaluate: async request => {
      assert.equal(request.requestedSeat, 'B');
      assert.equal(request.sim, true);
      return CANDIDATE;
    } },
  });
  t.after(() => session.close());

  await act('B', { type: 'signal', signal: 'LR', id: 'request' });
  const preview = audioFrames('B', 'draft')[0];
  assert.ok(preview);
  assert.equal(audioFrames('A', 'soft').length, 0);
  assert.equal(session.snapshot('A').seats.B.pending, null);
  assert.equal(state().seats.B.pending.text, CANDIDATE.candidates.B.text);
  advance(146);
  await act('B', { type: 'heard', messageId: preview.messageId });
  assert.equal(state().log.find(entry => entry.kind === 'preview_playback').latencyMs, 146);

  await act('B', { type: 'signal', signal: 'R1', id: 'approve' });
  assert.equal(state().seats.B.pending, null);
  assert.equal(audioFrames('A', 'soft').length, 1);
  assert.equal(state().bits, 1);
  assert.deepEqual(calls, [
    { seat: 'B', text: 'Send: Show the working demo next?', role: 'assistant' },
    { seat: 'B', text: 'Show the working demo next', role: 'seat' },
  ]);
});

test('draft discard, expiry and cooldown preserve the seat’s fixed signals', async t => {
  const { session, state, audioFrames, act, advance } = await createLiveSession({
    codec: { evaluate: async () => CANDIDATE },
  });
  t.after(() => session.close());
  await act('B', { type: 'configure', mode: 1 });
  await act('B', { type: 'signal', signal: 'LR', id: 'ask1' });
  await act('B', { type: 'signal', signal: 'R2', id: 'discard' });
  assert.equal(audioFrames('A', 'soft').length, 0);
  assert.equal(state().log.find(entry => entry.kind === 'discard').reason, 'discarded');
  await act('B', { type: 'signal', signal: 'LR', id: 'blockedByCooldown' });
  assert.equal(audioFrames('B', 'draft').length, 1);
  advance(30000);
  await act('B', { type: 'signal', signal: 'LR', id: 'ask2' });
  advance(6000);
  await act('B', { type: 'signal', signal: 'R1', id: 'fixed' });
  assert.equal(state().log.filter(entry => entry.kind === 'discard').at(-1).reason, 'expired');
  assert.equal(audioFrames('A', 'soft').at(-1).key, 'B:Pitch:R1');
  assert.equal(state().bits, Math.log2(3));
});

test('slow assistant fails quietly and does not prevent fixed sends', async t => {
  let resolved;
  const { session, state, audioFrames, act } = await createLiveSession({
    audio: { speech: () => new Promise(resolve => { resolved = resolve; }) },
    codec: { evaluate: async () => CANDIDATE },
    settings: { serviceTimeoutMs: 10 },
  });
  t.after(() => session.close());
  await act('B', { type: 'signal', signal: 'LR' });
  assert.equal(state().seats.B.pending, null);
  resolved({ url: '/assets/too-late' });
  await act('B', { type: 'signal', signal: 'R2' });
  assert.equal(audioFrames('B', 'draft').length, 0);
  assert.equal(audioFrames('A', 'soft').at(-1).key, 'B:Pitch:R2');
});

test('out and reinsert use urgent whisper and back cue, with one log message', async t => {
  const { session, state, audioFrames, act } = await createLiveSession();
  t.after(() => session.close());
  await act('B', { type: 'signal', signal: 'OUT' });
  await act('B', { type: 'signal', signal: 'OUT' });
  await act('B', { type: 'signal', signal: 'BACK' });
  await act('B', { type: 'signal', signal: 'BACK' });
  assert.equal(audioFrames('A', 'urgent').length, 1);
  assert.equal(audioFrames('A', 'urgent')[0].key, 'B:Pitch:OUT');
  assert.equal(audioFrames('A', 'back').length, 1);
  assert.equal(state().log.filter(entry => entry.kind === 'message').length, 1);
});

test('hearing receipt expires independently from signal and deduplication', async t => {
  const { session, state, audioFrames, act, advance } = await createLiveSession();
  t.after(() => session.close());
  await act('B', { type: 'signal', signal: 'R2' });
  await act('A', { type: 'heard', messageId: audioFrames('A', 'soft')[0].messageId });
  advance(4001);
  await act('A', { type: 'signal', signal: 'R1' });
  assert.equal(audioFrames('B', 'receipt').length, 0);
  assert.equal(audioFrames('B', 'soft')[0].key, 'A:Pitch:R1');
  assert.equal(state().bits, 4);
});

test('transcripts and the calibrated profile reach only intended viewers and reset clears both', async t => {
  let realtime;
  const { session, state, seatFrames, act } = await createLiveSession({
    sim: { A: false, B: true },
    audio: { listen: (seat, enabled, transcript) => {
      if (enabled) realtime = transcript;
      return enabled;
    } },
  });
  t.after(() => session.close());
  await act('A', { type: 'listen', enabled: true });
  realtime('This is in the presenter’s room.');
  await act('B', { type: 'sim_transcript', text: 'Coach can see the timer.', level: 0.2 });
  assert.equal(state().seats.A.listening, true);
  assert.equal(state().seats.B.transcript.length, 1);
  assert.equal(session.snapshot('A').seats.B.transcript.length, 0);
  assert.equal(session.snapshot('B').seats.A.transcript.length, 0);

  const profile = { timing: { duplicateMs: 82 } };
  await act('A', { type: 'calibration', profile });
  assert.deepEqual(state().calibration, profile);
  assert.deepEqual(seatFrames.B.findLast(frame => frame.type === 'calibration')?.profile, profile);
  await session.reset();
  assert.equal(session.snapshot('A').setupReset, session.sessionId);
  assert.equal(session.snapshot('B').setupReset, session.sessionId);
  realtime('Old connection callback');
  assert.equal(state().seats.A.transcript.length, 0);
  assert.equal(state().phase, 'lobby');
  assert.equal(state().calibration, null);
  assert.equal(state().cacheId, null);
});

test('offline stage can play canned take to completion without ElevenLabs or connected seats', async t => {
  const frames = [];
  let revealed;
  const revealedPromise = new Promise(resolve => { revealed = resolve; });
  const session = new Session({
    emitSeat() {},
    emitStage(frame) {
      frames.push(frame);
      if (frame.state?.phase === 'reveal') revealed(frame.state);
    },
    audio: {},
    settings: { roomSenseMs: 0, cannedTimeScale: 0.001 },
  });
  t.after(() => session.close());
  await session.handleStage({ action: 'canned' });
  const state = await revealedPromise;
  assert.equal(state.canned, true);
  assert.equal(state.bits, 7);
  const kinds = state.log.map(entry => entry.kind);
  assert.deepEqual(state.log.filter(entry => entry.kind === 'message').map(entry => entry.signal), ['R1', 'R2', 'R1', 'OUT']);
  assert.ok(kinds.indexOf('draft') >= 0 && kinds.indexOf('draft') < kinds.indexOf('confirm'));
  assert.ok(kinds.includes('receipt'));
  const audio = frames.filter(frame => frame.type === 'audio');
  assert.equal(audio.length, 5);
  assert.equal(audio.find(frame => frame.cue === 'draft')?.voiceRole, 'assistant');
});

test('reconnect restores the old cache before a deferred preset can activate', async t => {
  const { session, state, audioFrames, act, ack, seatFrames } = await createLiveSession();
  t.after(() => session.close());
  session.disconnect('A');
  await session.handleStage({ action: 'preset', preset: 'Custom', context: 'The slide order has changed' });
  await act('B', { type: 'signal', signal: 'R2' });
  assert.equal(audioFrames('A', 'soft').length, 0);
  assert.equal(state().presetPending, 'Custom');

  await session.connect('A', true);
  const oldManifest = seatFrames.A.findLast(frame => frame.type === 'cache' && frame.activeId === state().cacheId);
  await act('A', { type: 'cache_ready', activeId: oldManifest.activeId });
  await act('B', { type: 'signal', signal: 'R2' });
  assert.equal(audioFrames('A', 'soft').at(-1).key, 'B:Pitch:R2');
  await ack('A');
  await ack('B');
  assert.equal(state().context, 'The slide order has changed');
  await act('B', { type: 'signal', signal: 'R2' });
  assert.equal(audioFrames('A', 'soft').at(-1).key, 'B:Custom:R2');
  assert.equal(audioFrames('A', 'soft').at(-1).text, 'One minute left');
});

test('late speech may not escape a reset and deadline cancellation reaches the adapter', async t => {
  let serviceSignal;
  let finishSpeech;
  const { session, state, audioFrames, act } = await createLiveSession({
    audio: { speech: async (seat, text, options) => {
      serviceSignal = options.signal;
      return new Promise(resolve => { finishSpeech = resolve; });
    } },
    codec: { evaluate: async () => CANDIDATE },
  });
  t.after(() => session.close());
  const drafting = act('B', { type: 'signal', signal: 'LR' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(serviceSignal.aborted, false);
  await session.reset();
  assert.equal(serviceSignal.aborted, true);
  finishSpeech({ url: '/assets/late' });
  await drafting;
  assert.equal(audioFrames('B', 'draft').length, 0);
  assert.deepEqual(state().log, []);
});

test('AI preset suggestion is private and the live preset waits for both new banks', async t => {
  const { session, state, audioFrames, act, ack } = await createLiveSession({
    codec: { evaluate: async () => ({ suggestedPreset: { B: 'Party' } }) },
  });
  t.after(() => session.close());
  await act('B', { type: 'sim_transcript', text: 'The music has started.', level: 0.2 });
  await session.sense();
  assert.equal(state().seats.B.pending.kind, 'preset');
  assert.equal(audioFrames('B', 'system').length, 1);
  assert.equal(audioFrames('A', 'system').length, 0);
  await act('B', { type: 'heard', messageId: audioFrames('B', 'system')[0].messageId });
  await act('B', { type: 'signal', signal: 'R1' });
  assert.equal(state().preset, 'Pitch');
  await ack('A');
  assert.equal(state().preset, 'Pitch');
  await ack('B');
  assert.equal(state().preset, 'Party');
  assert.equal(state().bits, 0);
});

test('an unheard draft neither sends on R1 nor steals a valid receipt', async t => {
  const { session, state, audioFrames, act } = await createLiveSession({
    codec: { evaluate: async () => CANDIDATE },
  });
  t.after(() => session.close());
  await act('A', { type: 'signal', signal: 'R2' });
  const fixed = audioFrames('B', 'soft')[0];
  await act('B', { type: 'signal', signal: 'LR' });
  await act('B', { type: 'signal', signal: 'R1', id: 'unheard' });
  assert.ok(state().seats.B.pending);
  assert.equal(audioFrames('A', 'soft').length, 0);

  await act('B', { type: 'heard', messageId: fixed.messageId });
  await act('B', { type: 'signal', signal: 'R1', id: 'receipt' });
  assert.equal(audioFrames('A', 'receipt').length, 1);
  assert.equal(audioFrames('A', 'soft').length, 0);
  assert.ok(state().seats.B.pending);
});

test('the full confirmation window starts at observed draft playback', async t => {
  const { session, state, audioFrames, act, advance } = await createLiveSession({
    codec: { evaluate: async () => CANDIDATE },
  });
  t.after(() => session.close());
  await act('B', { type: 'signal', signal: 'LR' });
  const preview = audioFrames('B', 'draft')[0];
  assert.equal(preview.expiresAt, 7000);
  assert.equal(preview.sessionId, state().sessionId);
  advance(1800);
  await act('B', { type: 'heard', messageId: preview.messageId });
  assert.equal(state().seats.B.pending.expiresAt, 8800);
  advance(5999);
  await act('B', { type: 'signal', signal: 'R1' });
  assert.equal(audioFrames('A', 'soft').at(-1).text, CANDIDATE.candidates.B.text);
});

test('late playback acknowledgements cannot revive an expired draft', async t => {
  const { session, state, audioFrames, act, advance } = await createLiveSession({
    codec: { evaluate: async () => CANDIDATE },
  });
  t.after(() => session.close());
  await act('B', { type: 'signal', signal: 'LR' });
  advance(6001);
  await act('B', { type: 'heard', messageId: audioFrames('B', 'draft')[0].messageId });
  assert.equal(state().seats.B.pending, null);
  assert.ok(state().log.some(entry => entry.kind === 'discard' && entry.reason === 'expired'));
  assert.ok(!state().log.some(entry => entry.kind === 'preview_playback'));
});

test('disconnect aborts a preview before it can be whispered to the replacement connection', async t => {
  let serviceSignal;
  let finishSpeech;
  const { session, state, audioFrames, act } = await createLiveSession({
    audio: { speech: (seat, text, options) => {
      serviceSignal = options.signal;
      return new Promise(resolve => { finishSpeech = resolve; });
    } },
    codec: { evaluate: async () => CANDIDATE },
  });
  t.after(() => session.close());
  const drafting = act('B', { type: 'signal', signal: 'LR' });
  await new Promise(resolve => setImmediate(resolve));
  session.disconnect('B');
  await session.connect('B', true);
  assert.equal(serviceSignal.aborted, true);
  finishSpeech({ url: '/assets/late' });
  await drafting;
  assert.equal(audioFrames('B', 'draft').length, 0);
  assert.equal(state().seats.B.pending, null);
});

test('a confirmed draft cannot arrive on a connection that replaced its original recipient', async t => {
  let finishSpeech;
  let serviceSignal;
  const { session, state, audioFrames, act } = await createLiveSession({
    audio: { speech: (seat, text, options) => {
      if (options.role !== 'seat') return '/assets/preview';
      serviceSignal = options.signal;
      return new Promise(resolve => { finishSpeech = resolve; });
    } },
    codec: { evaluate: async () => CANDIDATE },
  });
  t.after(() => session.close());
  await act('B', { type: 'signal', signal: 'LR' });
  await act('B', { type: 'heard', messageId: audioFrames('B', 'draft')[0].messageId });
  const confirming = act('B', { type: 'signal', signal: 'R1' });
  await new Promise(resolve => setImmediate(resolve));
  session.disconnect('A');
  await session.connect('A', true);
  assert.equal(serviceSignal.aborted, true);
  finishSpeech('/assets/late');
  await confirming;
  assert.equal(audioFrames('A', 'soft').length, 0);
  assert.equal(state().bits, 0);
});

test('selecting the same pending preset resends an unacknowledged cache manifest', async t => {
  const { session, state, seatFrames, ack } = await createLiveSession();
  t.after(() => session.close());
  await session.handleStage({ action: 'preset', preset: 'Party' });
  await ack('A');
  const manifestsBefore = seatFrames.B.filter(frame => frame.type === 'cache');
  const pending = manifestsBefore.at(-1);
  await session.handleStage({ action: 'preset', preset: 'Party' });
  const manifestsAfter = seatFrames.B.filter(frame => frame.type === 'cache');
  assert.equal(manifestsAfter.length, manifestsBefore.length + 1);
  assert.equal(manifestsAfter.at(-1).activeId, pending.activeId);
  await ack('B');
  assert.equal(state().preset, 'Party');
});

test('a preset switch drops an audio preview generated against the old room context', async t => {
  let finishSpeech;
  const { session, state, audioFrames, act, ack } = await createLiveSession({
    audio: { speech: () => new Promise(resolve => { finishSpeech = resolve; }) },
    codec: { evaluate: async () => CANDIDATE },
  });
  t.after(() => session.close());
  const drafting = act('B', { type: 'signal', signal: 'LR' });
  await new Promise(resolve => setImmediate(resolve));
  await session.handleStage({ action: 'preset', preset: 'Party' });
  await ack('A');
  await ack('B');
  finishSpeech('/assets/old-preset');
  await drafting;
  assert.equal(state().preset, 'Party');
  assert.equal(state().seats.B.pending, null);
  assert.equal(audioFrames('B', 'draft').length, 0);
});

test('Reveal freezes both transcript feeds and closes the live transcription stream', async t => {
  const calls = [];
  let realtime;
  const { session, state, act } = await createLiveSession({
    sim: { A: false, B: true },
    audio: { listen: (seat, enabled, transcript) => {
      calls.push({ seat, enabled });
      if (enabled) realtime = transcript;
      return enabled;
    } },
  });
  t.after(() => session.close());
  await act('A', { type: 'listen', enabled: true });
  realtime('The real room before Reveal.');
  await act('B', { type: 'sim_transcript', text: 'The sim room before Reveal.' });
  await session.handleStage({ action: 'reveal' });
  realtime('The room after Reveal.');
  await act('B', { type: 'sim_transcript', text: 'The sim room after Reveal.' });
  await act('A', { type: 'listen', enabled: true });
  assert.deepEqual(calls, [{ seat: 'A', enabled: true }, { seat: 'A', enabled: false }]);
  assert.equal(state().seats.A.listening, false);
  assert.equal(state().seats.A.transcript.length, 1);
  assert.equal(state().seats.B.transcript.length, 1);
});

test('moving a seat from simulation to real hardware requires a fresh voice cache and setup', async t => {
  const built = [];
  const { session, state, act, ack, audioFrames } = await createLiveSession({
    audio: { buildCache: async (speaker, preset, messages, options) => {
      built.push({ speaker, sim: options.sim });
      return Object.keys(messages).map(signal => {
        const key = [speaker, preset, signal].join(':');
        return { key, url: '/assets/' + key };
      });
    } },
  });
  t.after(() => session.close());
  const oldCache = state().cacheId;
  session.disconnect('B');
  await session.connect('B', false);
  assert.equal(state().seats.B.voice, 'idle');
  assert.equal(state().seats.B.ready, false);
  assert.equal(state().cacheId, null);
  await act('A', { type: 'signal', signal: 'R2' });
  assert.equal(audioFrames('B', 'soft').length, 0);
  for (const step of ['voice', 'earbuds', 'calibrate', 'ready']) {
    await act('B', { type: 'setup', step, complete: true });
  }
  await ack('A');
  await ack('B');
  assert.ok(state().seats.B.ready);
  assert.notEqual(state().cacheId, oldCache);
  assert.deepEqual(built.filter(entry => entry.speaker === 'B').map(entry => entry.sim), [true, false]);
});

test('a delayed draft approval cannot degrade into a fixed whisper or approve a newer draft', async t => {
  const { session, state, audioFrames, act, advance } = await createLiveSession({
    codec: { evaluate: async () => CANDIDATE },
  });
  t.after(() => session.close());
  await act('B', { type: 'signal', signal: 'LR' });
  const old = audioFrames('B', 'draft')[0].messageId;
  await act('B', { type: 'heard', messageId: old });
  advance(6001);
  await act('B', { type: 'signal', signal: 'R1', draftId: old });
  assert.equal(audioFrames('A', 'soft').length, 0);

  advance(30000);
  await act('B', { type: 'signal', signal: 'LR' });
  const latest = audioFrames('B', 'draft').at(-1).messageId;
  assert.notEqual(latest, old);
  await act('B', { type: 'heard', messageId: latest });
  await act('B', { type: 'signal', signal: 'R1', draftId: old });
  assert.equal(state().seats.B.pending.id, latest);
  assert.equal(audioFrames('A', 'soft').length, 0);
  await act('B', { type: 'signal', signal: 'R1', draftId: latest });
  assert.equal(audioFrames('A', 'soft').at(-1).text, CANDIDATE.candidates.B.text);
});

test('an ordinary tap keeps its fixed meaning when a preview becomes audible during recognition', async t => {
  const { session, state, audioFrames, act } = await createLiveSession({
    codec: { evaluate: async () => CANDIDATE },
  });
  t.after(() => session.close());
  await act('B', { type: 'signal', signal: 'LR' });
  const preview = audioFrames('B', 'draft')[0];
  await act('B', { type: 'heard', messageId: preview.messageId });
  await act('B', { type: 'signal', signal: 'L1', draftId: null, cacheId: state().cacheId });
  assert.equal(audioFrames('A', 'soft').at(-1).key, 'B:Pitch:L1');
  assert.equal(state().seats.B.pending.id, preview.messageId);
  await act('B', { type: 'signal', signal: 'R1', draftId: null, cacheId: state().cacheId });
  assert.equal(audioFrames('A', 'soft').at(-1).key, 'B:Pitch:R1');
  assert.equal(state().seats.B.pending.id, preview.messageId);
});

test('a tap recognized against a stale cache cannot send a new preset meaning', async t => {
  const { session, state, audioFrames, act, ack } = await createLiveSession();
  t.after(() => session.close());
  const old = state().cacheId;
  await session.handleStage({ action: 'preset', preset: 'Party' });
  await ack('A');
  await ack('B');
  await act('B', { type: 'signal', signal: 'R1', draftId: null, cacheId: old });
  assert.equal(audioFrames('A', 'soft').length, 0);
  assert.equal(audioFrames('B', 'error').length, 1);
  await act('B', { type: 'signal', signal: 'R1', draftId: null, cacheId: state().cacheId });
  assert.equal(audioFrames('A', 'soft').at(-1).text, 'Come find me');
});

test('a receipt intent only acknowledges its named playback and expires quietly', async t => {
  const { session, state, audioFrames, act, advance } = await createLiveSession({
    codec: { evaluate: async () => CANDIDATE },
  });
  t.after(() => session.close());
  await act('A', { type: 'signal', signal: 'R2' });
  const fixed = audioFrames('B', 'soft')[0];
  advance(180);
  await act('B', { type: 'heard', messageId: fixed.messageId });
  const entry = state().log.find(item => item.messageId === fixed.messageId);
  assert.equal(entry.playedAt, 1180);
  assert.equal(entry.playbackLatencyMs, 180);
  assert.equal(session.snapshot('B').seats.B.receipt.messageId, fixed.messageId);
  assert.equal(session.snapshot('A').seats.B.receipt, null);

  await act('B', { type: 'signal', signal: 'LR' });
  const preview = audioFrames('B', 'draft')[0];
  await act('B', { type: 'heard', messageId: preview.messageId });
  await act('B', { type: 'signal', signal: 'R1', draftId: null, receiptId: 'stale' });
  assert.equal(audioFrames('A', 'receipt').length, 0);
  assert.equal(state().seats.B.pending.id, preview.messageId);
  await act('B', { type: 'signal', signal: 'R1', draftId: null, receiptId: fixed.messageId });
  assert.equal(audioFrames('A', 'receipt').length, 1);
  advance(4001);
  await act('B', { type: 'signal', signal: 'R1', draftId: null, receiptId: fixed.messageId });
  assert.equal(audioFrames('A', 'soft').length, 0);
  assert.equal(state().seats.B.pending.id, preview.messageId);
});

test('cache retries target missing acknowledgements and stop after a preset commits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, state, seatFrames, ack } = await createLiveSession({
    settings: { cacheAckRetryMs: 10 },
  });
  t.after(() => session.close());
  await session.handleStage({ action: 'preset', preset: 'Party' });
  await ack('A');
  const manifests = seat => seatFrames[seat].filter(frame => frame.type === 'cache');
  const previous = manifests('B').at(-1);
  const a_count = manifests('A').length;
  const b_count = manifests('B').length;
  t.mock.timers.tick(10);
  assert.equal(manifests('A').length, a_count);
  assert.equal(manifests('B').length, b_count + 1);
  assert.equal(manifests('B').at(-1).activeId, previous.activeId);
  await ack('B');
  t.mock.timers.tick(10);
  assert.equal(manifests('B').length, b_count + 1);
  assert.equal(state().preset, 'Party');
});

test('old-session frames cannot reconfigure seats after a stage reset', async t => {
  const { session, state, act } = await createLiveSession();
  t.after(() => session.close());
  const old = state().sessionId;
  await session.reset();
  await act('A', { type: 'setup', step: 'voice', complete: true, sessionId: old });
  await act('A', { type: 'sim_transcript', text: 'Previous show', sessionId: old });
  assert.equal(state().seats.A.voice, 'idle');
  assert.deepEqual(state().seats.A.transcript, []);
  await act('A', { type: 'setup', step: 'voice', complete: true, sessionId: state().sessionId });
  assert.equal(state().seats.A.voice, 'fallback');
});

test('provider status only follows an online real seat with an active microphone subscription', async t => {
  const { session, state, act } = await createLiveSession({
    sim: { A: false, B: true },
    audio: { listen: (seat, enabled) => ({ listening: enabled }) },
  });
  t.after(() => session.close());
  session.updateTranscriptionStatus({ seat: 'A', status: 'live' });
  assert.equal(state().seats.A.transcription, 'off');
  await act('A', { type: 'listen', enabled: true });
  assert.equal(state().seats.A.transcription, 'waiting');
  session.updateTranscriptionStatus({ seat: 'A', status: 'live' });
  assert.equal(state().seats.A.transcription, 'live');
  await act('B', { type: 'listen', enabled: true });
  session.updateTranscriptionStatus({ seat: 'B', status: 'live' });
  assert.equal(state().seats.B.transcription, 'off');
  session.disconnect('A');
  await session.connect('A', false);
  session.updateTranscriptionStatus({ seat: 'A', status: 'recovering' });
  assert.equal(state().seats.A.transcription, 'off');
});

test('operator replay uses the exact last message asset after a preset swap and receiver reconnect', async t => {
  const pins = [];
  const { session, state, act, ack, audioFrames } = await createLiveSession({
    audio: { retainReplayAsset: url => pins.push(url) },
  });
  t.after(() => session.close());
  await act('B', { type: 'signal', signal: 'R2' });
  const original = audioFrames('A', 'soft').at(-1);
  assert.equal(original.url, undefined);
  await session.handleStage({ action: 'preset', preset: 'Party' });
  await ack('A');
  await ack('B');
  session.disconnect('A');
  await session.connect('A', true);
  await ack('A');
  const bits = state().bits;
  await session.handleStage({ action: 'replay' });
  const replay = audioFrames('A', 'soft').at(-1);
  assert.equal(pins.at(-1), '/assets/B:Pitch:R2');
  assert.equal(replay.url, '/assets/B:Pitch:R2');
  assert.equal(replay.key, undefined);
  assert.equal(replay.messageId, undefined);
  assert.equal(replay.text, original.text);
  assert.equal(state().bits, bits);
  assert.equal(state().log.filter(entry => entry.kind === 'message').length, 1);
});

test('one neutral system announcement fans out to both seats without tap bits or receipts', async t => {
  const calls = [];
  const { session, state, act, audioFrames } = await createLiveSession({
    audio: { announcement: async (text, { sim }) => {
      calls.push({ text, sim });
      return { url: '/assets/shared-announcement.mp3' };
    } },
  });
  t.after(() => session.close());
  await session.handleStage({ type: 'operator', action: 'announce', text: '  Sound check.\nCan you hear me?  ' });
  assert.deepEqual(calls, [{ text: 'Sound check. Can you hear me?', sim: true }]);
  const announcement = state().announcement;
  assert.equal(announcement.status, 'queued');
  assert.deepEqual(announcement.targets, ['A', 'B']);
  assert.equal(session.snapshot('A').announcement, undefined);
  for (const seat of ['A', 'B']) {
    const frames = audioFrames(seat, 'system');
    assert.equal(frames.length, 1);
    assert.equal(frames[0].kind, 'announcement');
    assert.equal(frames[0].url, '/assets/shared-announcement.mp3');
    assert.equal(frames[0].messageId, announcement.id);
    assert.equal(frames[0].expiresAt, 9000);
  }
  await session.handleStage({ action: 'announce', text: 'Thirty seconds left.' });
  assert.equal(calls.length, 1);
  await act('A', { type: 'heard', messageId: announcement.id });
  await act('A', { type: 'heard', messageId: announcement.id });
  assert.equal(state().announcement.status, 'queued');
  assert.deepEqual(state().announcement.heard, ['A']);
  await act('B', { type: 'heard', messageId: announcement.id });
  assert.equal(state().announcement.status, 'played');
  assert.deepEqual(state().announcement.heard, ['A', 'B']);
  assert.equal(state().bits, 0);
  assert.equal(state().log.filter(entry => entry.kind === 'announcement').length, 1);
  assert.equal(state().log.some(entry => entry.kind === 'message'), false);
  assert.ok(state().seats.A.receipt === null && state().seats.B.receipt === null);
  await act('A', { type: 'signal', signal: 'R1' });
  assert.equal(audioFrames('B', 'soft').at(-1).key, 'A:Pitch:R1');
});

test('announcing before Begin reports the only connected seat as partial', async t => {
  const { session, state, act, audioFrames } = await createLiveSession();
  t.after(() => session.close());
  await session.reset();
  session.disconnect('B');
  await session.handleStage({ action: 'announce', text: 'Thirty seconds left.' });
  assert.equal(state().phase, 'lobby');
  assert.deepEqual(state().announcement.targets, ['A']);
  assert.equal(audioFrames('B', 'system').length, 0);
  const messageId = audioFrames('A', 'system').at(-1).messageId;
  await act('A', { type: 'heard', messageId });
  assert.equal(state().announcement.status, 'partial');
  assert.equal(state().announcement.reason, 'seat_offline');
});

test('a replacement seat never receives or acknowledges an announcement addressed to its old connection', async t => {
  let resolve;
  const { session, state, act, audioFrames } = await createLiveSession({
    audio: { announcement: () => new Promise(done => { resolve = done; }) },
  });
  t.after(() => session.close());
  const sending = session.handleStage({ action: 'announce', text: 'Thirty seconds left.' });
  await Promise.resolve();
  session.disconnect('B');
  await session.connect('B', true);
  resolve('/assets/shared-announcement.mp3');
  await sending;
  assert.equal(audioFrames('B', 'system').length, 0);
  const messageId = audioFrames('A', 'system').at(-1).messageId;
  await act('B', { type: 'heard', messageId });
  assert.deepEqual(state().announcement.heard, []);
  await act('A', { type: 'heard', messageId });
  assert.equal(state().announcement.status, 'partial');
  assert.equal(state().announcement.reason, 'seat_left');
});

test('announcement generation and playback timeouts settle and late responses cannot confirm playback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let serviceSignal;
  const { session, state, act } = await createLiveSession({
    audio: { announcement: (text, { signal }) => {
      serviceSignal = signal;
      return text === 'Stalled' ? new Promise(() => {}) : '/assets/shared-announcement.mp3';
    } },
  });
  t.after(() => session.close());
  const sending = session.handleStage({ action: 'announce', text: 'Stalled' });
  await Promise.resolve();
  t.mock.timers.tick(3000);
  await sending;
  assert.ok(serviceSignal.aborted);
  assert.equal(state().announcement.status, 'failed');
  assert.equal(state().announcement.reason, 'speech_timeout');

  await session.handleStage({ action: 'announce', text: 'Sound check.' });
  const messageId = state().announcement.id;
  await act('A', { type: 'heard', messageId });
  t.mock.timers.tick(8000);
  assert.equal(state().announcement.status, 'partial');
  assert.equal(state().announcement.reason, 'playback_timeout');
  await act('B', { type: 'heard', messageId });
  assert.deepEqual(state().announcement.heard, ['A']);
});

test('reset aborts an unfinished announcement and reveal rejects late playback acknowledgements', async t => {
  let resolve;
  let serviceSignal;
  const { session, state, act, audioFrames } = await createLiveSession({
    audio: { announcement: (text, { signal }) => {
      serviceSignal = signal;
      return text === 'Pause' ? new Promise(done => { resolve = done; }) : '/assets/shared-announcement.mp3';
    } },
  });
  t.after(() => session.close());
  const sending = session.handleStage({ action: 'announce', text: 'Pause' });
  await Promise.resolve();
  await session.reset();
  assert.ok(serviceSignal.aborted);
  resolve('/assets/late.mp3');
  await sending;
  assert.equal(state().announcement, null);
  assert.equal(audioFrames('A', 'system').length, 0);

  for (const seat of ['A', 'B']) {
    for (const step of ['voice', 'earbuds', 'calibrate', 'ready']) await act(seat, { type: 'setup', step, complete: true });
  }
  const cache = session.cacheCandidate.id;
  for (const seat of ['A', 'B']) await act(seat, { type: 'cache_ready', activeId: cache });
  await session.handleStage({ action: 'begin' });
  await session.handleStage({ action: 'announce', text: 'Finish' });
  const messageId = state().announcement.id;
  await session.handleStage({ action: 'reveal' });
  await act('A', { type: 'heard', messageId });
  assert.equal(state().announcement.status, 'failed');
  assert.equal(state().announcement.reason, 'reveal');
  assert.deepEqual(state().announcement.heard, []);
});

test('explicit premade choice unblocks an in-flight clone and cleans up its late result', async t => {
  const removed = [];
  let finishClone;
  let providerSignal;
  const { session, state, act, seatFrames } = await createLiveSession({
    audio: {
      makeVoice: (_seat, _wav, _id, { signal }) => {
        providerSignal = signal;
        return new Promise(resolve => { finishClone = resolve; });
      },
      removeVoice: voice => removed.push(voice.id),
    },
  });
  t.after(() => session.close());
  const cacheId = state().cacheId;
  const cloning = act('A', { type: 'voice', wav: 'a'.repeat(128), requestId: 'slow' });
  assert.equal(state().seats.A.voice, 'building');
  await act('A', { type: 'setup', step: 'voice', complete: true });
  assert.equal(state().seats.A.voice, 'building');

  await act('A', { type: 'setup', step: 'voice', complete: true, fallback: true });
  assert.equal(state().seats.A.voice, 'fallback');
  assert.equal(state().seats.A.ready, true);
  assert.equal(state().cacheId, cacheId);
  assert.ok(providerSignal.aborted);
  finishClone({ id: 'late-clone', status: 'ready' });
  await cloning;
  assert.equal(state().seats.A.voice, 'fallback');
  assert.deepEqual(removed, ['late-clone']);
  const voiceFrames = seatFrames.A.filter(frame => frame.type === 'voice_status');
  assert.equal(voiceFrames.at(-1).status, 'fallback');
});

test('failed re-records preserve a verified voice and reuse its acknowledged cache', async t => {
  const removed = [];
  const outcomes = [
    { id: 'verified', status: 'ready' },
    { id: null, status: 'error', detail: 'Recording is silent.' },
    { id: 'configured-premade', status: 'fallback', detail: 'Verification required.' },
  ];
  const { session, state, act, ack, audioFrames } = await createLiveSession({
    audio: {
      makeVoice: async () => outcomes.shift(),
      removeVoice: voice => removed.push(voice.id),
    },
  });
  t.after(() => session.close());
  const wav = 'a'.repeat(128);
  await act('A', { type: 'voice', wav, requestId: 'working' });
  await ack('A');
  await ack('B');
  const cacheId = state().cacheId;
  for (const requestId of ['silent', 'verification']) {
    await act('A', { type: 'voice', wav, requestId });
    assert.equal(state().seats.A.voice, 'ready');
    assert.equal(state().seats.A.ready, true);
    assert.equal(state().cacheId, cacheId);
    assert.equal(session.cacheCandidate, null);
    assert.equal(session.seats.A.voiceRef.id, 'verified');
  }
  assert.deepEqual(removed, []);
  await act('A', { type: 'signal', signal: 'R1' });
  assert.equal(audioFrames('B', 'soft').at(-1).activeId, cacheId);
});

test('choosing premade over a verified voice keeps the old cache active until both new manifests are acknowledged', async t => {
  const builds = [];
  const { session, state, act, ack, audioFrames } = await createLiveSession({
    audio: {
      makeVoice: async () => ({ id: 'verified', status: 'ready' }),
      buildCache: async (seat, preset, messages, { voice }) => {
        if (seat === 'A') builds.push(voice?.id ?? null);
        return Object.keys(messages).map(signal => {
          const key = [seat, preset, signal].join(':');
          return { key, url: '/assets/' + key + ':' + (voice?.id ?? 'fallback') };
        });
      },
    },
  });
  t.after(() => session.close());
  await act('A', { type: 'voice', wav: 'a'.repeat(128) });
  await ack('A');
  await ack('B');
  const oldCache = state().cacheId;
  await act('A', { type: 'setup', step: 'voice', complete: true, fallback: true });
  assert.equal(state().seats.A.voice, 'fallback');
  assert.equal(state().cacheId, oldCache);
  assert.deepEqual(builds, [null, 'verified', null]);
  await act('A', { type: 'signal', signal: 'R2' });
  assert.equal(audioFrames('B', 'soft').at(-1).activeId, oldCache);
  await ack('A');
  await ack('B');
  assert.notEqual(state().cacheId, oldCache);
  await act('A', { type: 'signal', signal: 'R2' });
  assert.equal(audioFrames('B', 'soft').at(-1).activeId, state().cacheId);
});

test('a voice change while the partner is offline still rebuilds the cache on reconnect', async t => {
  const { session, state, ack, act } = await createLiveSession({
    audio: { makeVoice: async () => ({ id: 'verified', status: 'ready' }) },
  });
  t.after(() => session.close());
  await act('A', { type: 'voice', wav: 'a'.repeat(128) });
  await ack('A');
  await ack('B');
  const oldCache = state().cacheId;
  session.disconnect('B');
  await act('A', { type: 'setup', step: 'voice', complete: true, fallback: true });
  assert.equal(state().seats.A.voice, 'fallback');
  assert.equal(state().cacheId, oldCache);
  await session.connect('B', true);
  await ack('A');
  await ack('B');
  assert.notEqual(state().cacheId, oldCache);
});
