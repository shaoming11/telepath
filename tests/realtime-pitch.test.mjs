import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { openRealtimePitch } from '../hub/realtime-pitch.mjs';

class Socket extends EventEmitter {
  static current;
  readyState = 1;
  frames = [];
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    Socket.current = this;
  }
  send(frame) { this.frames.push(JSON.parse(frame)); }
  close() { this.readyState = 3; this.emit('close'); }
  receive(frame) { this.emit('message', JSON.stringify(frame)); }
}

test('Realtime keeps the connection warm, sends separate text revisions, and rejects a cancelled response', async () => {
  const lifecycle = new AbortController();
  const first = new AbortController();
  const second = new AbortController();
  const coach = openRealtimePitch({ env: { OPENAI_API_KEY: 'fixture' }, signal: lifecycle.signal, instructions: 'Cue', WebSocketImpl: Socket });
  const socket = Socket.current;
  assert.equal(socket.url.searchParams.get('model'), 'gpt-realtime-mini');
  socket.receive({ type: 'session.created' });
  assert.deepEqual(socket.frames[0].session.output_modalities, ['text']);
  socket.receive({ type: 'session.updated' });
  const old = coach.generate({ turns: ['How does it'] }, first.signal);
  await Promise.resolve();
  const initial = socket.frames.at(-1).response;
  assert.equal(initial.conversation, 'none');
  assert.equal(initial.tool_choice.name, 'submit_pitch_cue');
  assert.deepEqual(JSON.parse(initial.input[0].content[0].text), { turns: ['How does it'] });
  first.abort();
  socket.receive({ type: 'response.created', response: { id: 'stale', metadata: initial.metadata } });
  assert.equal(socket.frames.at(-1).response_id, 'stale');
  const next = coach.generate({ turns: ['How does it preserve earbud controls?'] }, second.signal);
  await Promise.resolve();
  const latest = socket.frames.at(-1).response;
  const done = (metadata, answer) => ({ type: 'response.done', response: {
    metadata, status: 'completed', output: [{ type: 'function_call', name: 'submit_pitch_cue', arguments: JSON.stringify({ answer, sourceId: "brief", quote: "The Mac captures the room." }) }],
  } });
  socket.receive(done(initial.metadata, 'Stale cue'));
  socket.receive(done(latest.metadata, 'Separate room input.'));
  assert.equal(await old, null);
  assert.equal((await next).answer, 'Separate room input.');
  const textReply = coach.generate({ turns: ['Why a Mac?'] }, second.signal);
  await Promise.resolve();
  socket.receive({ type: 'response.done', response: {
    metadata: socket.frames.at(-1).response.metadata, status: 'completed',
    output: [{ content: [{ type: 'output_text', text: 'Here is the cue.\n{"answer":"Mac listens.","sourceId":"brief","quote":"The Mac captures the room."}' }] }],
  } });
  assert.equal((await textReply).answer, 'Mac listens.');
  lifecycle.abort();
  assert.equal(socket.readyState, 3);
});

test('a partial-question draft still fits when the final question only adds a few words', async () => {
  const { nearlySameQuestion } = await import('../hub/pitch-question.mjs');
  assert.equal(nearlySameQuestion('What is the hardest latency problem you', 'What is the hardest latency problem you solved?'), true);
  assert.equal(nearlySameQuestion('Why the Mac', 'Why the Mac?'), true);
  assert.equal(nearlySameQuestion('What is the hardest', 'What is the hardest latency problem you have ever solved at work?'), false);
  assert.equal(nearlySameQuestion('Where did you grow', 'What do you do for fun?'), false);
  assert.equal(nearlySameQuestion('', 'Anything?'), false);
});
