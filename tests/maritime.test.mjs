import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaritimeCoach } from '../hub/maritime.mjs';

const ENV = { MARITIME_API_KEY: 'test-key', TELEPATHY_MARITIME_AGENT_ID: 'test-agent', TELEPATHY_MARITIME: 'on' };
const ASSIST_ENV = { ...ENV, OPENAI_API_KEY: 'local-model-key', TELEPATHY_MARITIME_ASSIST: 'openai' };
const PITCH = { beat: 'problem', elapsedSeconds: 73, onlineSeats: 2, readySeats: 2, acknowledgedMessages: 1 };

function openAiResult(cueId) {
  return Response.json({ status: 'completed', output: [{ content: [
    { type: 'output_text', text: JSON.stringify({ cueId, reason: 'Must stay on the hub.' }) },
  ] }] });
}

test('the Maritime adapter sends only pitch telemetry and identifies the inference engine', async () => {
  let calls = 0;
  const coach = createMaritimeCoach({
    env: { ...ENV, OPENAI_API_KEY: 'local-model-key' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.maritime.sh/api/agents/test-agent/chat');
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      assert.equal(options.redirect, 'error');
      assert.deepEqual(JSON.parse(JSON.parse(options.body).message), PITCH);
      const engine = calls++ === 0 ? 'model' : 'rules';
      return Response.json({ response: JSON.stringify({ cueId: 'demo-cue', engine, reason: 'Go to the demo.' }) });
    },
  });
  const input = { ...PITCH, transcript: 'private room text', name: 'a participant' };
  assert.deepEqual(await coach.recommend(input), { cueId: 'demo-cue', source: 'maritime', reason: 'Go to the demo.' });
  assert.equal((await coach.recommend(input)).source, 'maritime-rules');
  await assert.rejects(coach.recommend({ ...PITCH, beat: 'some room transcript' }), /Invalid pitch state/);
  assert.equal(calls, 2);
});

test('opt-in assistance sends a bounded candidate to Maritime and keeps its separate credential on the hub', async () => {
  let calls = 0;
  const coach = createMaritimeCoach({
    env: ASSIST_ENV,
    fetchImpl: async (url, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      if (url === 'https://api.openai.com/v1/responses') {
        assert.equal(options.headers.Authorization, 'Bearer local-model-key');
        assert.equal(options.redirect, 'error');
        assert.equal(body.store, false);
        assert.deepEqual(JSON.parse(body.input), PITCH);
        return openAiResult('demo-cue');
      }
      assert.equal(url, 'https://api.maritime.sh/api/agents/test-agent/chat');
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      assert.deepEqual(JSON.parse(body.message), { ...PITCH, candidateCueId: 'demo-cue' });
      return Response.json({ response: JSON.stringify({ cueId: 'demo-cue', engine: 'assisted', reason: 'Reviewed cue.' }) });
    },
  });
  assert.deepEqual(await coach.recommend({ ...PITCH, transcript: 'private room text', candidateCueId: 'untrusted' }), {
    cueId: 'demo-cue', source: 'maritime-assisted', reason: 'Reviewed cue.',
  });
  assert.equal(calls, 2);
});

test('absent or invalid OpenAI candidates still let Maritime choose a cue', async () => {
  for (const model_result of [new Response(null, { status: 429 }), openAiResult('unsupported cue')]) {
    const coach = createMaritimeCoach({
      env: ASSIST_ENV,
      fetchImpl: async (url, options) => {
        if (url === 'https://api.openai.com/v1/responses') return model_result;
        assert.deepEqual(JSON.parse(JSON.parse(options.body).message), PITCH);
        return Response.json({ response: JSON.stringify({ cueId: 'demo-cue', engine: 'rules', reason: 'Go to the demo.' }) });
      },
    });
    assert.equal((await coach.recommend(PITCH)).source, 'maritime-rules');
  }
});

test('an unconfigured coach is disabled and Maritime cannot inject a custom audio message', async () => {
  assert.equal(createMaritimeCoach({ env: {} }), null);
  assert.equal(createMaritimeCoach({ env: { ...ENV, TELEPATHY_MARITIME: undefined } }), null);
  assert.equal(createMaritimeCoach({ env: { ...ENV, TELEPATHY_MARITIME: 'off' } }), null);
  for (const reply of [
    { response: JSON.stringify({ cueId: 'say custom text', engine: 'model', reason: 'anything' }) },
    { response: JSON.stringify({ cueId: 'demo-cue', reason: '   ', engine: 'model' }) },
    { response: JSON.stringify({ cueId: 'demo-cue', reason: 'a'.repeat(181), engine: 'model' }) },
    { response: JSON.stringify({ cueId: 'demo-cue', reason: 'anything' }) },
    { response: JSON.stringify({ cueId: 'demo-cue', reason: 'anything', engine: 'assisted' }) },
    { response: JSON.stringify({ cueId: 'demo-cue', reason: 'anything', engine: ['model'] }) },
    { response: { cueId: 'demo-cue' } },
    { response: 'null' },
  ]) {
    const coach = createMaritimeCoach({ env: ENV, fetchImpl: async () => Response.json(reply) });
    await assert.rejects(coach.recommend(PITCH), /Invalid Maritime/);
  }
});

test('pitch help is opt-in and its bounded request runs against the real Maritime agent server locally', async t => {
  const { createCoachServer } = await import('../maritime/server.mjs');
  const { once } = await import('node:events');
  const server = createCoachServer({ env: {} }).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  let calls = 0;
  const fetchImpl = (url, options) => {
    calls++;
    const { message } = JSON.parse(options.body);
    const input = JSON.parse(message);
    assert.deepEqual(Object.keys(input).sort(), ['elapsedSeconds', 'passages', 'seat', 'turns', 'type']);
    assert.notEqual(url, base);
    return fetch(base + '/chat', options);
  };
  assert.equal(createMaritimeCoach({ env: ENV, fetchImpl }).planPitchHelp, undefined);
  assert.equal(calls, 0);
  const adapter = createMaritimeCoach({ env: { ...ENV, TELEPATHY_MARITIME_PITCH_HELP: 'on' }, fetchImpl });
  const result = await adapter.planPitchHelp({
    type: 'pitch_help', seat: 'A', elapsedSeconds: 10,
    turns: [{ speaker: 'Speaker 2', text: 'Why does it use the MacBook?' }],
    passages: [{ id: 'brief:1', name: 'local filename', text: 'The MacBook microphone hears the room.' }],
    extra: 'discard me',
  });
  assert.deepEqual(result, { intent: 'answer', passageIds: ['brief:1'], source: 'maritime-rules' });
  assert.equal(calls, 1);
});

test('Maritime capacity errors respect Retry-After without retrying a turn', async () => {
  let calls = 0, at = 0;
  const coach = createMaritimeCoach({
    env: ENV, now: () => at, fetchImpl: async () => {
      calls++;
      if (calls === 1) return new Response(null, { status: 429, headers: { 'Retry-After': '15' } });
      if (calls === 2) return Response.json({ response: null, error: { code: 'uncertain_delivery' } });
      return Response.json({ response: JSON.stringify({ cueId: 'demo-cue', engine: 'rules', reason: 'Move to the demo.' }) });
    },
  });
  await assert.rejects(coach.recommend(PITCH), /429/);
  at += 14_999;
  await assert.rejects(coach.recommend(PITCH), /retry window/);
  assert.equal(calls, 1);
  at += 1;
  await assert.rejects(coach.recommend(PITCH), /did not confirm/);
  assert.equal(calls, 2);
  assert.equal((await coach.recommend(PITCH)).source, 'maritime-rules');
  assert.equal(calls, 3);
});
