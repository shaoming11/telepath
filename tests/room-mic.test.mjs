import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoomMic, resolveSpeaker, splitRuns } from '../hub/room-mic.mjs';

const word = (text, speaker_id) => ({ text, type: 'word', speaker_id });
const space = { text: ' ', type: 'spacing' };

test('splitRuns groups consecutive words by speaker and attaches unlabelled words to neighbours', () => {
  const runs = splitRuns([
    word('maybe', null), space, word('Thanks', 'speaker_0'), space, word('all.', 'speaker_0'), space,
    word('Sorry,', 'speaker_1'), space, word('what?', 'speaker_1'), space, word('um', null), space, word('Sure.', 'speaker_0'),
  ]);
  assert.deepEqual(runs, [
    { speaker: 'speaker_0', text: 'maybe Thanks all.' },
    { speaker: 'speaker_1', text: 'Sorry, what? um' },
    { speaker: 'speaker_0', text: 'Sure.' },
  ]);
});

test('merges chain and are applied to later words', () => {
  const merges = new Map([['speaker_2', 'speaker_1'], ['speaker_1', 'speaker_0']]);
  assert.equal(resolveSpeaker(merges, 'speaker_2'), 'speaker_0');
  assert.deepEqual(splitRuns([word('hi', 'speaker_2')], merges), [{ speaker: 'speaker_0', text: 'hi' }]);
});

class FakeSocket {
  static last = null;
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.sent = [];
    this.handlers = {};
    FakeSocket.last = this;
  }
  on(event, fn) { this.handlers[event] = fn; }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; }
  emit(message) { this.handlers.message(JSON.stringify(message)); }
}

test('room mic assigns the first two voices to A and B, supports swap, assign and merges', async () => {
  const lines = [];
  const room = createRoomMic({ env: { ELEVENLABS_API_KEY: 'k' }, WebSocketImpl: FakeSocket, now: () => 1, onLine: line => lines.push(line) });
  assert.equal(await room.start(), true);
  const socket = FakeSocket.last;
  const url = new URL(socket.url);
  assert.equal(url.searchParams.get('model_id'), 'scribe_v3_live');
  assert.equal(url.searchParams.get('diarize'), 'true');
  assert.equal(socket.options.headers['xi-api-key'], 'k');

  room.push('AAAA', 0.2);
  assert.equal(socket.sent.length, 0, 'audio waits for session_started');
  socket.emit({ message_type: 'session_started' });
  assert.equal(socket.sent.length, 1);
  assert.equal(room.snapshot().status, 'live');

  socket.emit({ message_type: 'diarized_transcript', words: [word('Hello', 'speaker_0'), space, word('Question?', 'speaker_1')] });
  assert.deepEqual(lines.map(line => [line.seat, line.text]), [['A', 'Hello'], ['B', 'Question?']]);

  socket.emit({ message_type: 'diarized_transcript', words: [word('Third', 'speaker_2')] });
  assert.equal(lines.at(-1).seat, null, 'a third voice is left unassigned');

  room.swap();
  assert.deepEqual(room.snapshot().lines.slice(0, 2).map(line => line.seat), ['B', 'A']);

  room.assign('speaker_2', 'A');
  const seats = Object.fromEntries(room.snapshot().speakers.map(s => [s.id, s.seat]));
  assert.deepEqual(seats, { speaker_0: 'B', speaker_1: null, speaker_2: 'A' });

  socket.emit({ message_type: 'speakers_merged', from_speaker_id: 'speaker_2', to_speaker_id: 'speaker_1' });
  const after = room.snapshot();
  assert.equal(after.speakers.find(s => s.id === 'speaker_2'), undefined);
  assert.equal(after.lines.find(line => line.text === 'Third').speaker, 'speaker_1');

  room.stop();
  assert.equal(socket.closed, true);
  assert.equal(room.snapshot().status, 'off');
});

test('room mic reports a missing key instead of connecting', async () => {
  const room = createRoomMic({ env: {}, WebSocketImpl: FakeSocket });
  assert.equal(await room.start(), false);
  assert.equal(room.snapshot().status, 'error');
});

test('reassigning one voice relabels the lines of the voice it displaced', async () => {
  const room = createRoomMic({ env: { ELEVENLABS_API_KEY: 'k' }, WebSocketImpl: FakeSocket, now: () => 1 });
  await room.start();
  FakeSocket.last.emit({ message_type: 'session_started' });
  FakeSocket.last.emit({ message_type: 'diarized_transcript', words: [word('one', 'speaker_0'), space, word('two', 'speaker_1')] });
  room.assign('speaker_1', 'A');
  assert.deepEqual(room.snapshot().lines.map(line => [line.text, line.seat]), [['one', null], ['two', 'A']]);
  room.stop();
});
