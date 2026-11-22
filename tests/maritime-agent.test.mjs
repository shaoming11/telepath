import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { COACH_CUES, normalizePitch, recommendLocally } from '../maritime/policy.mjs';
import { createCoachServer } from '../maritime/server.mjs';

const PITCH = { beat: 'problem', elapsedSeconds: 73, onlineSeats: 2, readySeats: 2, acknowledgedMessages: 1 };
const ENV = { OPENAI_BASE_URL: 'https://maritime.example/api/llm/v1/', OPENAI_API_KEY: 'test-token' };

async function startCoach(t, options) {
  const server = createCoachServer({ env: {}, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = 'http://127.0.0.1:' + server.address().port;
  const chat = (payload = PITCH, envelope = {}) => fetch(address + '/chat', {
    method: 'POST',
    body: JSON.stringify({ ...envelope, message: JSON.stringify(payload) }),
  });
  return { address, chat };
}

function modelResponse(value) {
  return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
}

async function readAdvice(response) {
  assert.equal(response.status, 200);
  const { response: advice } = await response.json();
  return JSON.parse(advice);
}

test('pitch normalization copies only bounded show telemetry', () => {
  assert.deepEqual(normalizePitch({ ...PITCH, transcript: 'private', seat: 'private' }), PITCH);
  for (const invalid of [
    null, [], {}, { ...PITCH, beat: 'unrecognized' }, { ...PITCH, elapsedSeconds: Infinity },
    { ...PITCH, elapsedSeconds: '30' }, { ...PITCH, onlineSeats: 1 }, { ...PITCH, readySeats: 3 },
    { ...PITCH, acknowledgedMessages: 0.5 }, { ...PITCH, acknowledgedMessages: -1 },
  ]) {
    assert.equal(normalizePitch(invalid), null);
  }
});

test('local coaching follows show phase, readiness, tempo and receipts', () => {
  const cue = overrides => recommendLocally({ ...PITCH, ...overrides }).cueId;
  assert.equal(cue({ beat: 'opening', onlineSeats: 1, readySeats: 1 }), 'sound-check');
  assert.equal(cue({ beat: 'opening' }), 'demo-cue');
  assert.equal(cue({ beat: 'problem', elapsedSeconds: 61 }), 'demo-cue');
  assert.equal(cue({ beat: 'problem', elapsedSeconds: 60, acknowledgedMessages: 0 }), 'sound-check');
  assert.equal(cue({ beat: 'demo', acknowledgedMessages: 0 }), 'sound-check');
  assert.equal(cue({ beat: 'demo', elapsedSeconds: 100 }), 'time-cue');
  assert.equal(cue({ beat: 'closing' }), 'reveal-cue');
});

test('coach implements Maritime HTTP contract and rejects malformed or oversized turns before inference', async t => {
  const { address, chat } = await startCoach(t, {
    env: ENV,
    fetchImpl: () => assert.fail('unexpected inference'),
  });
  const health = await fetch(address + '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal((await fetch(address + '/unknown')).status, 404);
  assert.equal((await fetch(address + '/chat')).status, 405);
  assert.equal((await chat({ ...PITCH, beat: 'unknown' })).status, 400);
  assert.equal((await fetch(address + '/chat', { method: 'POST', body: 'bad JSON' })).status, 400);
  assert.equal((await chat({ ...PITCH, excess: 'x'.repeat(9000) })).status, 413);
});

test('coach sends only normalized show telemetry and accepts one approved model suggestion', async t => {
  const calls = [];
  const { chat } = await startCoach(t, {
    env: ENV,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return modelResponse({ cueId: 'demo-cue', reason: '  Move to the working demo. \n  Let the audience see it.  ', text: 'not a fixed cue' });
    },
  });
  const advice = await readAdvice(await chat({ ...PITCH, transcript: 'not for the model' }, { context: { seat: 'private' } }));
  assert.deepEqual(advice, { cueId: 'demo-cue', reason: 'Move to the working demo. Let the audience see it.', engine: 'model' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://maritime.example/api/llm/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.messages.length, 2);
  assert.deepEqual(JSON.parse(body.messages[1].content), PITCH);
  for (const id of COACH_CUES) assert.match(body.messages[0].content, new RegExp(id));
});

test('coach reports rule-based advice when model credentials are absent', async t => {
  const { chat } = await startCoach(t, { fetchImpl: () => assert.fail('unexpected inference') });
  assert.deepEqual(await readAdvice(await chat()), { ...recommendLocally(PITCH), engine: 'rules' });
});

test('hosted review accepts a useful candidate and overrides cues that clash with current telemetry', async t => {
  const { chat } = await startCoach(t, {
    env: ENV,
    fetchImpl: () => assert.fail('review should not request the hosted model'),
  });
  const opening = { ...PITCH, beat: 'opening', elapsedSeconds: 10, acknowledgedMessages: 0 };
  const promoted = await readAdvice(await chat({ ...opening, candidateCueId: 'demo-cue' }));
  assert.equal(promoted.cueId, 'demo-cue');
  assert.equal(promoted.engine, 'assisted');
  assert.equal(recommendLocally(opening).cueId, 'sound-check');

  const one_seat = { ...opening, readySeats: 1, onlineSeats: 1 };
  const rejected = await readAdvice(await chat({ ...one_seat, candidateCueId: 'demo-cue' }));
  assert.deepEqual(rejected, { ...recommendLocally(one_seat), engine: 'rules' });

  const closing = { ...PITCH, beat: 'closing' };
  const accepted = await readAdvice(await chat({ ...closing, candidateCueId: 'reveal-cue' }));
  assert.deepEqual(accepted, { ...recommendLocally(closing), engine: 'assisted' });
});

test('coach uses local rules when the model fails or returns an invalid decision', async t => {
  let response;
  const { chat } = await startCoach(t, { env: ENV, fetchImpl: async () => response });
  for (const item of [
    new Response('no credits', { status: 402 }),
    new Response('bad JSON'),
    modelResponse({ cueId: 'made-up', reason: 'Try another cue.' }),
    modelResponse({ cueId: 'demo-cue', reason: '   ' }),
    modelResponse({ cueId: 'demo-cue', reason: 'x'.repeat(500) }),
  ]) {
    response = item;
    assert.deepEqual(await readAdvice(await chat()), { ...recommendLocally(PITCH), engine: 'rules' });
  }
});

test('slow inference aborts and falls back within its deadline', async t => {
  let aborted = false;
  const { chat } = await startCoach(t, {
    env: ENV,
    timeoutMs: 20,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  });
  assert.deepEqual(await readAdvice(await chat()), { ...recommendLocally(PITCH), engine: 'rules' });
  assert.equal(aborted, true);
});
