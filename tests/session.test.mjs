import assert from 'node:assert/strict';
import test from 'node:test';
import { Session } from '../hub/session.mjs';
import { createCodec } from '../hub/codec.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { parseReferences } from '../hub/references.mjs';
import { normalizeState, pairAnnouncement, pairView } from '../public/stage.mjs';

const EMPTY_CODEC = { evaluate: async () => ({}) };

const supportedAnswer = request => ({ status: 'answer', question: 'Who buys it?', answer: 'The buyer is a sales team lead.',
  sources: [{ id: request.passages[0].id, quote: 'The buyer is a sales team lead.' }] });

async function answerFixture(t, options = {}) {
  const fixture = await createLiveSession({ ...options,
    codec: { questionAnswering: true, answer: async request => supportedAnswer(request), ...options.codec },
    settings: { questionDebounceMs: 5, questionQuietMs: 60_000, ...options.settings },
  });
  t.after(() => fixture.session.close());
  fixture.session.references = await parseReferences([{ name: 'brief.md', data: Buffer.from('The buyer is a sales team lead.').toString('base64') }]);
  return fixture;
}

async function eventually(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5); }
  assert.fail('Expected answer state did not arrive.');
}

test('completed transcripts promptly retrieve a cited answer through the existing approval flow', async t => {
  const { session, act, state, audioFrames } = await answerFixture(t);
  session.addTranscript('A', 'Who buys it? I do not know.');
  await eventually(() => state().seats.B.pending);
  const pending = state().seats.B.pending;
  assert.equal(audioFrames('A', 'soft').length, 0);
  assert.equal(pending.sources[0].name, 'brief.md');
  await act('B', { type: 'signal', id: 'blind', signal: 'R1', draftId: pending.id });
  assert.equal(audioFrames('A', 'soft').length, 0);
  await act('B', { type: 'heard', messageId: pending.id });
  await act('B', { type: 'signal', id: 'approved', signal: 'R1', draftId: pending.id });
  assert.equal(audioFrames('A', 'soft').at(-1).text, 'The buyer is a sales team lead.');
  assert.equal(state().log.filter(item => item.kind === 'answer_evidence').length, 1);
});

test('new speech cancels an audible answer and an old approval cannot send it', async t => {
  const { session, act, state, audioFrames } = await answerFixture(t, { codec: { answer: async request => request.turns.length > 1
    ? { status: 'resolved', question: 'Who buys it?', answer: '', sources: [] } : supportedAnswer(request) } });
  session.addTranscript('A', 'Who buys it?');
  await eventually(() => state().seats.B.pending);
  const pending = state().seats.B.pending;
  await act('B', { type: 'heard', messageId: pending.id });
  session.addTranscript('A', 'Actually, the buyer is a sales team lead.');
  assert.equal(state().seats.B.pending, null);
  await act('B', { type: 'signal', id: 'obsolete', signal: 'R1', draftId: pending.id });
  await eventually(() => state().questionState.status === 'resolved');
  assert.equal(audioFrames('A', 'soft').length, 0);
});

test('a result from superseded conversation cannot preview even when the model ignores abort', async t => {
  let resolveOld, oldSignal, calls = 0;
  const { session, state, audioFrames } = await answerFixture(t, { codec: { answer: request => {
    calls++;
    if (calls === 1) { oldSignal = request.signal; return new Promise(resolve => { resolveOld = () => resolve(supportedAnswer(request)); }); }
    return Promise.resolve({ status: 'resolved', question: 'Who buys it?', answer: '', sources: [] });
  } } });
  session.addTranscript('A', 'Who buys it?');
  await eventually(() => resolveOld);
  session.addTranscript('B', 'We know the answer now, move on.');
  assert.equal(oldSignal.aborted, true);
  resolveOld();
  await eventually(() => state().questionState.status === 'resolved');
  assert.equal(audioFrames('B', 'draft').length, 0);
});

test('new speech cancels already approved speech while it is being synthesized', async t => {
  let releaseSpeech, speechSignal;
  const { session, act, state, audioFrames } = await answerFixture(t, { audio: { speech: async (seat, text, options) => {
    if (options.role === 'assistant') return { url: '/preview' };
    speechSignal = options.signal;
    return new Promise(resolve => { releaseSpeech = () => resolve({ url: '/answer' }); });
  } } });
  session.addTranscript('A', 'Who buys it?');
  await eventually(() => state().seats.B.pending);
  const pending = state().seats.B.pending;
  await act('B', { type: 'heard', messageId: pending.id });
  const approval = act('B', { type: 'signal', signal: 'R1', id: 'approve', draftId: pending.id });
  await eventually(() => releaseSpeech);
  session.addTranscript('A', 'Never mind. Let us move on.');
  assert.equal(speechSignal.aborted, true);
  releaseSpeech();
  await approval;
  assert.equal(audioFrames('A', 'soft').length, 0);
});

test('unsupported and invalid-source answers remain silent and fixed whispers still work', async t => {
  const { session, state, act, audioFrames } = await answerFixture(t, { codec: { answer: async request => ({ ...supportedAnswer(request), sources: [{ id: 'fake', quote: 'A fabricated source.' }] }) } });
  session.addTranscript('A', 'Who buys it?');
  await eventually(() => state().questionState.status === 'unavailable');
  assert.equal(audioFrames('B', 'draft').length, 0);
  await act('B', { type: 'signal', id: 'fixed', signal: 'R1' });
  assert.equal(audioFrames('A', 'soft').at(-1).text, 'Slow down');
  session.codec.answer = async () => ({ status: 'unsupported', question: 'Revenue?', answer: '', sources: [] });
  session.addTranscript('A', 'What is our revenue?');
  await eventually(() => state().questionState.status === 'unsupported');
  assert.equal(audioFrames('B', 'draft').length, 0);
});

test('partial speech cancels a preview immediately before the completed transcript arrives', async t => {
  const { session, state } = await answerFixture(t);
  session.addTranscript('A', 'Who buys it?');
  await eventually(() => state().seats.B.pending);
  const callbacks = session.transcriptionCallbacks('A', session.generation, session.seats.A.listenVersion);
  callbacks.partial('Actually');
  assert.equal(state().seats.B.pending, null);
  await session.answerQuestion('B');
  assert.equal(state().seats.B.pending, null);
  callbacks.committed('Actually, let us move on.');
  assert.equal(session.questionSpeechPending, false);
});

test('overlapping microphone partials do not lose a question when the second completed transcript is a duplicate', async t => {
  let calls = 0;
  const { session, state } = await answerFixture(t, { codec: { answer: async request => { calls++; return supportedAnswer(request); } } });
  const a = session.transcriptionCallbacks('A', session.generation, session.seats.A.listenVersion);
  const b = session.transcriptionCallbacks('B', session.generation, session.seats.B.listenVersion);
  a.partial('Who buys');
  b.partial('Who buys');
  a.committed('Who buys it?');
  await delay(15);
  assert.equal(calls, 0);
  b.committed('Who buys it?');
  await eventually(() => state().seats.B.pending);
  assert.equal(calls, 1);
  assert.equal(session.questionTurns.length, 1);
});

test('quiet follow-up retries a waiting question and expiry never sends an answer', async t => {
  let calls = 0;
  const { session, state, audioFrames, advance } = await answerFixture(t, { settings: { questionQuietMs: 30 }, codec: { answer: async request => {
    calls++;
    return calls === 1 ? { status: 'waiting', question: 'Who buys it?', answer: '', sources: [] } : supportedAnswer(request);
  } } });
  session.addTranscript('A', 'Who buys it?');
  await eventually(() => state().questionState.status === 'waiting');
  advance(3000);
  await eventually(() => state().seats.B.pending);
  advance(6001);
  session.expirePending('B');
  assert.equal(session.seats.B.pending, null);
  assert.equal(audioFrames('A', 'soft').length, 0);
  assert.equal(session.questionState.status, 'expired');
});

test('reset erases references and rejects an in-flight answer', async t => {
  let release;
  const { session, state, audioFrames } = await answerFixture(t, { codec: { answer: request => new Promise(resolve => { release = () => resolve(supportedAnswer(request)); }) } });
  session.addTranscript('A', 'Who buys it?');
  await eventually(() => release);
  await session.reset();
  release();
  await delay(10);
  assert.equal(state().references.length, 0);
  assert.equal(state().phase, 'lobby');
  assert.equal(audioFrames('B', 'draft').length, 0);
});

test('the same question on both microphones is evaluated once and discarded answers do not repeat', async t => {
  let calls = 0;
  const { session, act, state, audioFrames, advance } = await answerFixture(t, { codec: { answer: async request => { calls++; return supportedAnswer(request); } } });
  session.addTranscript('A', 'Who buys it?');
  session.addTranscript('B', 'Who buys it?');
  await eventually(() => state().seats.B.pending);
  assert.equal(calls, 1);
  const pending = state().seats.B.pending;
  await act('B', { type: 'signal', signal: 'L1', id: 'discard', draftId: pending.id });
  advance(31_000);
  session.addTranscript('A', 'Who buys it?');
  await eventually(() => state().questionState.status === 'already_offered');
  assert.equal(audioFrames('B', 'draft').length, 1);
});

test('a timed-out answer does not block fixed cues or a subsequent evaluation', async t => {
  const { session, state, act, audioFrames } = await answerFixture(t, { settings: { questionTimeoutMs: 15 }, codec: { answer: () => new Promise(() => {}) } });
  session.addTranscript('A', 'Who buys it?');
  await eventually(() => state().questionState.status === 'unavailable');
  assert.equal(session.answerTask, null);
  await act('B', { type: 'signal', signal: 'R1', id: 'still-fixed' });
  assert.equal(audioFrames('A', 'soft').length, 1);
});

const missedPoint = request => ({ status: 'advice', question: 'How does the pilot work?',
  answer: 'You forgot to mention the six-week pilot.', responseQuote: 'We run it with one sales team.',
  sources: [{ id: request.passages[0].id, quote: 'The pilot lasts six weeks.' }] });

test('missed-point coaching waits for a pause, cites the spoken answer, and whispers only after approval', async t => {
  const { session, state, act, audioFrames, advance } = await answerFixture(t, { codec: { answer: async request => missedPoint(request) } });
  session.references = await parseReferences([{ name: 'pilot.md', data: Buffer.from('The pilot lasts six weeks.').toString('base64') }]);
  session.addTranscript('A', 'How does the pilot work?');
  session.addTranscript('B', 'We run it with one sales team.');
  await eventually(() => state().questionState.status === 'waiting');
  assert.equal(audioFrames('B', 'draft').length, 0);
  advance(2600);
  await session.answerQuestion();
  const pending = state().seats.B.pending;
  assert.equal(pending.suggestionKind, 'advice');
  assert.equal(pending.responseQuote, 'We run it with one sales team.');
  assert.equal(audioFrames('A', 'soft').length, 0);
  assert.match(state().log.find(entry => entry.kind === 'answer_evidence').text, /Answer heard/);
  await act('B', { type: 'heard', messageId: pending.id });
  await act('B', { type: 'signal', signal: 'R1', id: 'approve-reminder', draftId: pending.id });
  assert.equal(audioFrames('A', 'soft').at(-1).text, 'You forgot to mention the six-week pilot.');
});

test('covering a missed point cancels its preview and prevents a repeated reminder', async t => {
  const { session, state, act, audioFrames, advance } = await answerFixture(t, { codec: { answer: async request => missedPoint(request) } });
  session.references = await parseReferences([{ name: 'pilot.md', data: Buffer.from('The pilot lasts six weeks.').toString('base64') }]);
  session.addTranscript('A', 'How does the pilot work?');
  session.addTranscript('A', 'We run it with one sales team.');
  await session.answerQuestion('B');
  const pending = state().seats.B.pending;
  assert.ok(pending);
  await act('B', { type: 'heard', messageId: pending.id });
  session.addTranscript('A', 'The pilot lasts six weeks.');
  assert.equal(state().seats.B.pending, null);
  advance(2600);
  await session.answerQuestion();
  assert.equal(state().questionState.status, 'resolved');
  await act('B', { type: 'signal', signal: 'R1', id: 'stale-reminder', draftId: pending.id });
  assert.equal(audioFrames('A', 'soft').length, 0);
  assert.equal(audioFrames('B', 'draft').length, 1);
});

test('Mac room audio drives grounded answers without phone microphones and stops pending work on pause', async t => {
  let callbacks;
  const calls = [];
  const { session, state } = await answerFixture(t, { settings: { roomInput: 'mac' }, audio: {
    listen: async (seat, enabled, next) => { calls.push([seat, enabled]); if (enabled) callbacks = next; return { listening: enabled }; },
    mic: async (seat, audio, level, next) => { assert.equal(seat, 'room'); callbacks = next; next.committed('Who buys it? I do not know.'); },
  } });
  await session.setListening('A', true);
  assert.equal(calls.length, 0);
  await session.setRoomListening(true);
  await session.receiveMic('A', { audio: 'QUJD', level: .2 });
  assert.equal(session.seats.A.transcript.length, 0);
  await session.receiveRoomMic({ audio: 'QUJD', level: .2 });
  await eventually(() => state().seats.B.pending);
  assert.equal(state().room.transcript[0].text, 'Who buys it? I do not know.');
  assert.equal(state().seats.A.transcript.length, 0);
  assert.equal(session.snapshot('A').room.transcript, undefined);
  const late = callbacks;
  await session.setRoomListening(false);
  assert.equal(state().seats.B.pending, null);
  late.committed('This callback is stale.');
  assert.equal(state().room.transcript.length, 1);
  assert.deepEqual(calls, [['room', true], ['room', false]]);
});

test('Mac shared-room transcripts reach ordinary coaching and Reveal freezes the stream', async t => {
  let request, callbacks;
  const { session, state } = await createLiveSession({ settings: { roomInput: 'mac' }, audio: {
    listen: async (seat, enabled, cb) => { if (enabled) callbacks = cb; return { listening: enabled }; },
  }, codec: { evaluate: async input => { request = input; return {}; } } });
  t.after(() => session.close());
  await session.setRoomListening(true);
  callbacks.committed('Show the working demo now.');
  await session.sense();
  assert.equal(request.room.transcript[0].text, 'Show the working demo now.');
  assert.equal(request.sim, false);
  await session.handleStage({ action: 'reveal' });
  callbacks.committed('Late room speech.');
  assert.equal(state().room.listening, false);
  assert.equal(state().room.transcript.length, 1);
});

test('reset while Mac transcription starts prevents a late activation', async t => {
  let finish;
  const { session, state } = await createLiveSession({ audio: {
    listen: (seat, enabled) => enabled ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ listening: false }),
  } });
  t.after(() => session.close());
  const starting = session.setRoomListening(true);
  await session.reset();
  finish({ listening: true });
  await starting;
  assert.equal(state().room.listening, false);
  assert.equal(state().room.transcript.length, 0);
});

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
    settings: { roomSenseMs: 0, automaticQuietMs: 0, automaticCooldownMs: 0, automaticPlaybackGuard: false, ...settings },
    now: () => now,
  });

  const state = () => stageFrames.findLast(frame => frame.type === 'state')?.state;
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

test('the Stage pair follows a real dispatch, playback clock report and matching acknowledgement', async t => {
  const { session, state, act, advance } = await createLiveSession();
  t.after(() => session.close());
  const current = () => pairView(normalizeState(state()));
  const empty = current();
  await act('B', { type: 'signal', signal: 'R2' });
  const sent = current();
  assert.equal(sent.cards[0].current, null);
  assert.equal(sent.cards[1].current.signal, 'Double');
  assert.equal(sent.cards[1].current.label, 'Sent to Seat A');
  assert.equal(sent.cards[1].current.detail, 'Waiting for playback');
  assert.match(pairAnnouncement(empty, sent), /Seat B sent One minute left to Seat A/);

  advance(200);
  const messageId = sent.cards[1].current.id;
  await act('A', { type: 'heard', messageId });
  const started = current();
  assert.equal(started.cards[0].current.label, 'Playback started');
  assert.equal(started.cards[1].current.detail, '');
  assert.match(pairAnnouncement(sent, started), /Playback started on Seat A/);

  advance(200);
  await act('A', { type: 'signal', signal: 'R1', receiptId: messageId });
  const acknowledged = current();
  assert.equal(acknowledged.cards[0].current.label, 'Acknowledged');
  assert.equal(acknowledged.cards[1].current.label, 'Seat A acknowledged');
  assert.match(pairAnnouncement(started, acknowledged), /Seat A acknowledged One minute left/);
  assert.equal(pairAnnouncement(acknowledged, current()), '');
});

test('the companion room mic stays active in phone-input mode while the phone sends signals and ignores phone PCM', async t => {
  const chunks = [];
  const { session, state, act, audioFrames } = await createLiveSession({
    sim: { A: false, B: false },
    audio: { listen: async () => true, mic: async (_, audio) => chunks.push(audio) },
  });
  t.after(() => session.close());
  await act('A', { type: 'listen', enabled: true });
  await session.setListening('A', true, 'companion');
  await act('A', { type: 'listen', enabled: false });
  await act('A', { type: 'mic', audio: 'phone' });
  await session.receiveMic('A', { audio: 'companion', level: 0.1 }, 'companion');
  assert.equal(state().seats.A.roomMicSource, 'companion');
  assert.deepEqual(chunks, ['companion']);
  await act('A', { type: 'signal', signal: 'R1', id: 'while-mac-listens' });
  assert.equal(audioFrames('B', 'soft').length, 1);
  assert.equal(state().seats.A.listening, true);
});

test('the shared mic uses one diarized stream and updates speaker labels without duplicating transcript', async t => {
  const calls = [];
  let callbacks;
  const { session, state, seatFrames } = await createLiveSession({
    sim: { A: false, B: false },
    settings: { roomInput: 'mac' },
    audio: { listen: async (seat, enabled, cb, options) => {
      calls.push([seat, enabled, options?.diarize ?? false]);
      if (enabled) callbacks = cb;
      return true;
    } },
  });
  t.after(() => session.close());
  await session.setListening('A', true, 'phone');
  await session.setRoomListening(true);
  await session.setRoomListening(true);
  assert.deepEqual(calls, [['room', true, true]]);
  callbacks.committed('First. Second.', { streamId: 4, segment: 0 });
  callbacks.diarized({ segment_index: 0, words: [
    { speaker_id: 'speaker_0', text: 'First.' },
    { speaker_id: null, type: 'spacing', text: ' ' },
    { speaker_id: 'speaker_1', text: 'Second.' },
  ] }, 4);
  assert.equal(state().room.transcript.length, 1);
  assert.deepEqual(state().room.transcript[0].speakers.map(run => run.label), ['Speaker 1', 'Speaker 2']);
  const seat_a_monitor = seatFrames.A.findLast(frame => frame.type === 'monitor').monitor;
  assert.deepEqual(Object.keys(seat_a_monitor.seats), ['A']);
  assert.deepEqual(seat_a_monitor.seats.A.speakers, ['Speaker 1', 'Speaker 2']);
  await session.handleStage({ action: 'room_speaker_assign', stream: 3, speaker: 'speaker_0', seat: 'A' });
  assert.equal(state().room.transcript[0].speakers[0].label, 'Speaker 1');
  await session.handleStage({ action: 'room_speaker_assign', stream: 4, speaker: 'speaker_0', seat: 'A' });
  await session.handleStage({ action: 'room_speaker_assign', stream: 4, speaker: 'speaker_1', seat: 'B' });
  await session.handleStage({ action: 'room_speaker_assign', stream: 4, speaker: 'speaker_0', seat: 'B' });
  assert.deepEqual(state().room.transcript[0].speakers.map(run => run.label), ['Seat B', 'Seat A']);
  callbacks.merged({ from_speaker_id: 'speaker_0', to_speaker_id: 'speaker_1' }, 4);
  assert.equal(state().room.transcript[0].speakers[0].speaker, 'speaker_1');
  await session.handleStage({ action: 'room_transcript_clear' });
  assert.deepEqual(state().room.transcript, []);
  assert.equal(state().room.listening, true);
});

test('pitch help passes labelled room context through Maritime planning and OpenAI to one private whisper', async t => {
  const quote = 'The MacBook microphone hears the room.';
  const spoken = 'Mac listens. Phones keep earbud controls.';
  let modelInput, planInput, roomCallbacks;
  const codec = createCodec({ env: { OPENAI_API_KEY: 'fake' }, fetchImpl: async (url, request) => {
    const body = JSON.parse(request.body);
    assert.match(body.instructions, /private in-ear coach/);
    modelInput = JSON.parse(body.input);
    const { id } = modelInput.passages.find(passage => passage.text.includes(quote));
    const answer = { status: 'answer', question: 'Why the Mac?', answer: spoken, sources: [{ id, quote }], responseQuote: '' };
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] });
  } });
  const { session, act, state, seatFrames, audioFrames } = await createLiveSession({
    sim: { A: false, B: false }, settings: { roomInput: 'mac' }, codec,
    coach: { planPitchHelp: async input => {
      planInput = input;
      return { intent: 'answer', passageIds: [input.passages.find(passage => passage.text.includes(quote)).id], source: 'maritime' };
    } },
    audio: {
      listen: async (_, enabled, callbacks) => { if (enabled) roomCallbacks = callbacks; return { listening: enabled }; },
      speech: async (seat, text, options) => {
        assert.equal(seat, 'A');
        assert.equal(text, spoken);
        assert.equal(options.role, 'assistant');
        return '/assets/pitch-help.mp3';
      },
    },
  });
  t.after(() => session.close());
  const docs = (name, text) => parseReferences([{ name, data: Buffer.from(text).toString('base64') }]);
  session.pitchReferences = await docs('brief.md', quote);
  session.references = await docs('Notes.md', 'Telepathy is an event demo.');
  await session.setRoomListening(true);
  roomCallbacks.committed('Who handles the audio?', { streamId: 1, segment: 2 });
  roomCallbacks.diarized({ segment_index: 2, words: [{ speaker_id: 'speaker_0', text: 'Who handles the audio?' }] }, 1);
  roomCallbacks.partial('Why use the MacBook?');
  const help = { type: 'signal', signal: 'LR', id: 'help', purpose: 'pitch_help' };
  await act('A', help);
  assert.deepEqual(planInput.turns, [
    { speaker: 'Speaker 1', text: 'Who handles the audio?' },
    { speaker: 'Room (live partial)', text: 'Why use the MacBook?' },
  ]);
  assert.equal(modelInput.plan.intent, 'answer');
  assert.equal(modelInput.passages[0].text, quote);
  const cue = audioFrames('A', 'sent').filter(frame => frame.kind === 'pitch_help').at(-1);
  assert.equal(cue?.text, spoken);
  assert.equal(cue?.kind, 'pitch_help');
  assert.equal(seatFrames.B.some(frame => JSON.stringify(frame).includes(spoken)), false);
  assert.equal(state().seats.A.pending, null);
  assert.equal(state().bits, 0);
  assert.equal(state().log.find(entry => entry.kind === 'pitch_help')?.source, 'maritime');
  await act('A', { type: 'heard', messageId: cue.messageId });
  assert.equal(state().seats.A.receipt, null);
  assert.equal(state().log.find(entry => entry.kind === 'pitch_help').requestToPlaybackMs, 0);
  await act('A', help);
  assert.equal(audioFrames('A', 'sent').filter(frame => frame.kind === 'pitch_help').length, 1);
});

test('pitch help replaces a lengthy script with a short fallback cue', async t => {
  const { session, act, seatFrames } = await createLiveSession({
    sim: { A: false, B: false },
    codec: { pitchHelp: async request => ({
      ...supportedAnswer(request), answer: 'The MacBook hears the room so both phones can keep receiving earbud controls while the team rehearses the full final pitch.',
    }) },
    audio: { speech: async () => { return null; } },
  });
  t.after(() => session.close());
  session.pitchReferences = await parseReferences([{ name: 'brief.md', data: Buffer.from('The buyer is a sales team lead.').toString('base64') }]);
  await act('A', { type: 'signal', signal: 'LR', id: 'verbose', purpose: 'pitch_help' });
  assert.ok(seatFrames.A.some(frame => frame.type === 'pitch_help_status' && frame.text === 'Show one private cue live.'));
  assert.ok(!seatFrames.A.some(frame => frame.kind === 'pitch_help'));
});

test('pitch help uses the local plan when Maritime fails and drops a late result after Reveal', async t => {
  let release, input;
  const { session, act, audioFrames } = await createLiveSession({
    sim: { A: false, B: false },
    coach: { planPitchHelp: async () => { throw Error('planner unavailable'); } },
    codec: { pitchHelp: async args => {
      input = args;
      return new Promise(resolve => { release = resolve; });
    } },
  });
  t.after(() => session.close());
  session.pitchReferences = await parseReferences([{ name: 'brief.md', data: Buffer.from('The buyer is a sales team lead.').toString('base64') }]);
  const call = act('A', { type: 'signal', signal: 'LR', id: 'late', purpose: 'pitch_help' });
  await eventually(() => release);
  assert.equal(input.plan.intent, 'next_beat');
  await session.handleStage({ action: 'reveal' });
  release(supportedAnswer(input));
  await call;
  assert.equal(audioFrames('A', 'sent').filter(frame => frame.kind === 'pitch_help').some(frame => frame.kind === 'pitch_help'), false);
});

test('completed room turns prewarm one exact plan and a changed question falls back without reusing it', async t => {
  let roomCallbacks;
  const plans = [];
  const used = [];
  const { session, act, advance } = await createLiveSession({
    sim: { A: false, B: false },
    settings: { roomInput: 'mac', pitchPlanDebounceMs: 5 },
    codec: { pitchHelp: async input => { used.push(input.plan); return supportedAnswer(input); } },
    audio: { listen: async (_, enabled, callbacks) => { if (enabled) roomCallbacks = callbacks; return { listening: enabled }; } },
    coach: { planPitchHelp: async input => {
      plans.push(input);
      return { intent: 'add_point', passageIds: [input.passages[0].id], source: 'maritime' };
    } },
  });
  t.after(() => session.close());
  session.pitchReferences = await parseReferences([{ name: 'brief.md', data: Buffer.from('The buyer is a sales team lead.').toString('base64') }]);
  await session.setRoomListening(true);
  roomCallbacks.committed('Who buys it?', { streamId: 1, segment: 2 });
  roomCallbacks.diarized({ segment_index: 2, words: [{ speaker_id: 'speaker_0', text: 'Who buys it?' }] }, 1);
  await eventually(() => plans.length === 1);
  await act('A', { type: 'signal', signal: 'LR', id: 'warm', purpose: 'pitch_help' });
  assert.equal(used[0].intent, 'add_point');
  assert.equal(plans[0].turns[0].speaker, 'Speaker 1');
  assert.equal(plans.length, 1);
  advance(1501);
  roomCallbacks.partial('What should I demonstrate now?');
  await act('A', { type: 'signal', signal: 'LR', id: 'changed', purpose: 'pitch_help' });
  assert.equal(used[1].intent, 'answer');
  assert.equal(plans.length, 1);
});

test('a verified voice preview goes only to its owner as speaking audio', async t => {
  const roles = [];
  const { session, act, seatFrames } = await createLiveSession({
    sim: { A: false, B: false },
    audio: {
      makeVoice: async () => ({ id: 'my-clone', status: 'ready' }),
      speech: async (_, text, options) => {
        roles.push([text, options.role]);
        return '/assets/voice-preview.mp3';
      },
    },
  });
  t.after(() => session.close());
  await act('A', { type: 'voice', wav: 'A'.repeat(144), requestId: 'sample' });
  await act('A', { type: 'voice_preview' });
  assert.equal(roles.at(-1)?.[1], 'voice-preview');
  assert.ok(seatFrames.A.some(frame => frame.kind === 'voice_preview'));
  assert.ok(!seatFrames.B.some(frame => frame.kind === 'voice_preview'));
});

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
  assert.equal(session.snapshot('B').seats.B.receipt.openedAt, 1180);
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

test('a receipt gesture that started in its window can finish recognition after the deadline', async t => {
  const { session, state, audioFrames, act, advance } = await createLiveSession();
  t.after(() => session.close());
  await act('A', { type: 'signal', signal: 'R2' });
  const { messageId } = audioFrames('B', 'soft')[0];
  await act('B', { type: 'heard', messageId });
  const { until } = state().seats.B.receipt;
  advance(6490);

  for (const receiptPressedAt of [undefined, until + 1, until - 4001]) {
    await act('B', { type: 'signal', signal: 'R1', draftId: null, receiptId: messageId, receiptPressedAt });
  }
  assert.equal(audioFrames('A', 'receipt').length, 0);
  await act('B', { type: 'signal', signal: 'R1', draftId: null, receiptId: messageId, receiptPressedAt: until - 1 });
  assert.equal(audioFrames('A', 'receipt').length, 1);
  assert.ok(state().log.some(entry => entry.kind === 'receipt' && entry.messageId === messageId));
  assert.equal(state().log.filter(entry => entry.kind === 'message').length, 1);
});

test('a captured receipt intent cannot be applied beyond the bounded recognition delay', async t => {
  const { session, state, audioFrames, act, advance } = await createLiveSession();
  t.after(() => session.close());
  await act('A', { type: 'signal', signal: 'R2' });
  const { messageId } = audioFrames('B', 'soft')[0];
  await act('B', { type: 'heard', messageId });
  const { until } = state().seats.B.receipt;
  advance(7001);
  await act('B', { type: 'signal', signal: 'R1', draftId: null, receiptId: messageId, receiptPressedAt: until - 1 });
  assert.equal(audioFrames('A', 'receipt').length, 0);
  assert.equal(state().log.filter(entry => entry.kind === 'message').length, 1);
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
  assert.equal(state().canReplay, false);
  await act('B', { type: 'signal', signal: 'R2' });
  assert.equal(state().canReplay, true);
  assert.equal(session.snapshot('A').canReplay, undefined);
  const original = audioFrames('A', 'soft').at(-1);
  assert.equal(original.url, undefined);
  await session.handleStage({ action: 'preset', preset: 'Party' });
  await ack('A');
  await ack('B');
  session.disconnect('A');
  assert.equal(state().canReplay, false);
  await session.connect('A', true);
  await ack('A');
  assert.equal(state().canReplay, true);
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
  await session.handleStage({ action: 'reveal' });
  assert.equal(state().canReplay, false);
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

test('a single room-answer gesture sends the full transcript and hybrid evidence only once', async t => {
  const calls = [];
  const whispers = [];
  const { session, act, seatFrames } = await createLiveSession({
    sim: { A: false, B: false }, settings: { roomInput: 'mac' },
    audio: { listen: async () => ({ listening: true }), speech: async (seat, text, options) => {
      whispers.push({ seat, text, whisper: options.whisper }); return '/cue.mp3';
    } },
    codec: { pitchHelp: async input => {
      calls.push(input);
      return supportedAnswer(input);
    } },
  });
  t.after(() => session.close());
  session.pitchReferences = await parseReferences([{ name: 'brief.md', data: Buffer.from('The buyer is a sales team lead.').toString('base64') }]);
  await session.setRoomListening(true);
  session.addTranscript('room', 'Our first introduction starts here.');
  for (let turn = 1; turn <= 64; turn++) session.addTranscript('room', 'Setup detail ' + turn);
  session.addTranscript('room', 'Who is the target buyer?');
  session.addTranscript('room', 'Let me pull up the previous slide.');
  assert.equal(calls.length, 0);
  assert.equal(session.snapshot().room.transcript.length, 60);
  const gesture = { type: 'signal', signal: 'LR', purpose: 'answer_room_question', id: 'ask' };
  await act('A', gesture);
  await act('A', gesture);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].roomTranscript.length, 67);
  assert.equal(calls[0].roomTranscript[0].text, 'Our first introduction starts here.');
  assert.ok(calls[0].roomTranscript.some(turn => turn.text === 'Who is the target buyer?'));
  assert.ok(calls[0].passages.some(passage => passage.text.includes('sales team lead')));
  assert.deepEqual(whispers, [{ seat: 'A', text: 'The buyer is a sales team lead.', whisper: true }]);
  assert.equal(seatFrames.A.filter(frame => frame.kind === 'pitch_help').length, 1);
  assert.equal(seatFrames.B.some(frame => frame.kind === 'pitch_help'), false);
  session.addTranscript('room', 'Who are your competitors?');
  assert.equal(calls.length, 1);
});

test('a sourced but generic grounding line is replaced with a concrete cue', async t => {
  let room;
  const { session, act, seatFrames } = await createLiveSession({
    sim: { A: false, B: false }, settings: { roomInput: 'mac' },
    audio: { listen: async (_, enabled, callbacks) => { if (enabled) room = callbacks; return { listening: enabled }; } },
    codec: { pitchHelp: async input => ({ ...supportedAnswer(input), answer: 'Grounded in project references.' }) },
  });
  t.after(() => session.close());
  session.pitchReferences = await parseReferences([{ name: 'brief.md', data: Buffer.from('The buyer is a sales team lead.').toString('base64') }]);
  await session.setRoomListening(true);
  room.committed('Why use the Mac microphone?');
  await act('A', { type: 'signal', signal: 'LR', purpose: 'pitch_help', id: 'manual' });
  assert.equal(seatFrames.A.find(frame => frame.kind === 'pitch_help')?.text, 'Mac listens. Phones keep earbud controls.');
});

function scenarioCodec(onRequest, answer) {
  return createCodec({ env: { OPENAI_API_KEY: 'fake' }, fetchImpl: async (url, request) => {
    const body = JSON.parse(request.body);
    const input = JSON.parse(body.input);
    onRequest(body, input);
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(answer(input)) }] }] });
  } });
}

test('social scenario whispers an ungrounded conversation prompt without any uploaded documents', async t => {
  const spoken = 'Ask what got them into climbing.';
  let instructions, modelInput;
  const codec = scenarioCodec((body, input) => { instructions = body.instructions; modelInput = input; },
    () => ({ status: 'answer', question: '', answer: spoken, sources: [{ id: 'made-up', quote: 'An invented source quote.' }], responseQuote: '' }));
  const { session, act, state, audioFrames } = await createLiveSession({
    sim: { A: false, B: false }, settings: { roomInput: 'mac', coachScenario: 'social' }, codec,
    audio: { speech: async (seat, text) => { assert.equal(text, spoken); return '/assets/social.mp3'; } },
  });
  t.after(() => session.close());
  session.pitchReferences = await parseReferences([{ name: 'brief.md', data: Buffer.from('Telepathy uses the MacBook microphone.').toString('base64') }]);
  session.room.transcript = [{ at: session.now(), text: 'I spent the weekend climbing in Squamish.' }];
  await act('A', { type: 'signal', signal: 'LR', id: 'social', purpose: 'pitch_help' });
  assert.match(instructions, /shy or awkward/);
  assert.deepEqual(modelInput.passages, []);
  assert.equal(modelInput.project, undefined);
  assert.equal(audioFrames('A', 'sent').filter(frame => frame.kind === 'pitch_help').at(-1)?.text, spoken);
  const entry = state().log.find(item => item.kind === 'pitch_help');
  assert.equal(entry.scenario, 'social');
  assert.equal(entry.ungrounded, true);
  assert.deepEqual(entry.sources, []);
  assert.equal(state().coachScenario, 'social');
});

test('interview scenario only retrieves uploaded persona documents and keeps cues grounded', async t => {
  const quote = 'Cut end-to-end audio latency from 220 ms to 90 ms.';
  const spoken = 'Lead with the Lumen latency win. 220 to 90 milliseconds.';
  let instructions, modelInput;
  const codec = scenarioCodec((body, input) => { instructions = body.instructions; modelInput = input; }, input => ({
    status: 'answer', question: 'Hardest problem?', answer: spoken,
    sources: [{ id: input.passages.find(passage => passage.text.includes(quote)).id, quote }], responseQuote: '',
  }));
  const { session, act, state, audioFrames } = await createLiveSession({
    sim: { A: false, B: false }, settings: { roomInput: 'mac' }, codec,
    audio: { speech: async () => '/assets/interview.mp3' },
  });
  t.after(() => session.close());
  await session.handleStage({ action: 'coach_scenario', scenario: 'interview' });
  assert.equal(state().coachScenario, 'interview');
  session.pitchReferences = await parseReferences([{ name: 'brief.md', data: Buffer.from('Telepathy cut latency with a MacBook hub.').toString('base64') }]);
  session.references = await parseReferences([{ name: 'persona.md', data: Buffer.from(quote).toString('base64') }]);
  session.room.transcript = [{ at: session.now(), text: 'What is the hardest latency problem you solved?' }];
  await act('A', { type: 'signal', signal: 'LR', id: 'interview', purpose: 'pitch_help' });
  assert.match(instructions, /being interviewed/);
  assert.ok(modelInput.passages.length > 0);
  assert.ok(modelInput.passages.every(passage => passage.name.startsWith('persona.md')));
  assert.equal(audioFrames('A', 'sent').filter(frame => frame.kind === 'pitch_help').at(-1)?.text, spoken);
  const entry = state().log.find(item => item.kind === 'pitch_help');
  assert.equal(entry.scenario, 'interview');
  assert.equal(entry.ungrounded, undefined);
  assert.equal(entry.sources[0].quote, quote);
});

test('interview scenario stays quiet with a fallback when no persona documents are uploaded', async t => {
  let called = false;
  const { session, act, seatFrames } = await createLiveSession({
    sim: { A: false, B: false }, settings: { coachScenario: 'interview' },
    codec: { pitchHelp: async () => { called = true; return null; } },
    audio: { speech: async () => null },
  });
  t.after(() => session.close());
  session.pitchReferences = await parseReferences([{ name: 'brief.md', data: Buffer.from('Telepathy brief.').toString('base64') }]);
  await act('A', { type: 'signal', signal: 'LR', id: 'empty', purpose: 'pitch_help' });
  assert.equal(called, false);
  assert.ok(seatFrames.A.some(frame => frame.type === 'pitch_help_status' && frame.text === 'Ask what success looks like in this role.'));
});

test('a material verified correction is spoken only to the original seat', async t => {
  let releaseReview;
  const quote = 'The decision maker is the VP of Sales.';
  const { session, act, seatFrames } = await createLiveSession({
    sim: { A: false, B: false },
    coach: {
      draftPitchCue: async () => ({ status: 'unsupported' }),
      verifyPitchCue: async input => new Promise(resolve => {
        releaseReview = () => resolve({ ...supportedAnswer(input), answer: quote, sources: [{ id: input.passages[0].id, quote }] });
      }),
    },
    codec: { pitchHelp: async input => supportedAnswer(input), verifyPitchCue: async () => ({ status: 'resolved' }) },
  });
  t.after(() => session.close());
  session.pitchReferences = await parseReferences([{ name: 'brief.md',
    data: Buffer.from('The buyer is a sales team lead. ' + quote).toString('base64') }]);
  await act('A', { type: 'signal', signal: 'LR', purpose: 'pitch_help', id: 'correct' });
  await eventually(() => releaseReview);
  releaseReview();
  await eventually(() => seatFrames.A.filter(frame => frame.kind === 'pitch_help').length === 2);
  const revision = seatFrames.A.findLast(frame => frame.kind === 'pitch_help');
  assert.equal(revision.text, quote);
  assert.match(decodeURIComponent(revision.url), /Correction\./);
  assert.ok(!seatFrames.B.some(frame => frame.kind === 'pitch_help'));
});

test('automatic cues require a natural pause, no approval or receipt, cooldown and new information', async t => {
  const { session, advance } = await createLiveSession({ settings: { automaticQuietMs: 2500, automaticCooldownMs: 30000, automaticPlaybackGuard: true } });
  t.after(() => session.close());
  session.room.transcript.push({ text: 'Our answer is finished.', at: session.now() });
  assert.equal(session.canWhisperAutomatically('B', 'A useful fact.'), false);
  advance(2600);
  assert.equal(session.canWhisperAutomatically('B', 'A useful fact.'), true);
  session.room.partial = { text: 'One more thing', at: session.now() };
  assert.equal(session.canWhisperAutomatically('B'), false);
  session.room.partial = null;
  session.cue('A', 'sent', { url: '/assets/test.mp3', text: 'An explicit requested answer is playing.' });
  assert.equal(session.canWhisperAutomatically('B'), false);
  advance(5000);
  session.seats.A.receipt = { until: session.now() + 500 };
  assert.equal(session.canWhisperAutomatically('B'), false);
  session.seats.A.receipt = null;
  session.seats.A.pending = { id: 'approval' };
  assert.equal(session.canWhisperAutomatically('B'), false);
  session.seats.A.pending = null;
  session.rememberAutomaticCue('A useful fact.');
  assert.equal(session.canWhisperAutomatically('B', 'Another fact.'), false);
  advance(30001);
  assert.equal(session.canWhisperAutomatically('B', 'A useful fact!'), false);
  assert.equal(session.canWhisperAutomatically('B', 'Another fact.'), true);
});
test('low-value automatic whispers and renewed speech during audio generation never play', async t => {
  let finish;
  const { session, audioFrames } = await createLiveSession({ codec: { assessWhisper: async () => false }, audio: {
    speech: () => new Promise(resolve => { finish = resolve; }),
  } });
  t.after(() => session.close());
  const input = { kind: 'draft', text: 'A minor extra detail.', started_at: session.now(), signal: new AbortController().signal, automatic: true };
  await session.previewDraft('B', input);
  assert.equal(finish, undefined);
  session.codec.assessWhisper = async () => true;
  const attempt = session.previewDraft('B', input);
  await eventually(() => finish);
  session.room.partial = { text: 'I am still answering', at: session.now() };
  finish({ url: '/assets/test.mp3' });
  await attempt;
  assert.equal(audioFrames('B', 'draft').length, 0);
});

test('retained research alone supports future missing-point evaluation without uploaded documents', async t => {
  const { session, state, advance } = await answerFixture(t, { codec: { answer: async request => missedPoint(request) } });
  const references = await parseReferences([{ name: 'External research.md', data: Buffer.from('The pilot lasts six weeks.').toString('base64') }]);
  session.references = [];
  session.researchReferences = references;
  session.addTranscript('A', 'How does the pilot work?');
  session.addTranscript('A', 'We run it with one sales team.');
  advance(2600);
  await session.answerQuestion();
  assert.equal(state().seats.B.pending?.suggestionKind, 'advice');
  assert.equal(state().seats.B.pending?.sources[0].name, 'External research.md');
});
