import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaritimeCoach } from '../hub/maritime.mjs';

const ENV = { MARITIME_API_KEY: 'test-key', TELEPATHY_MARITIME_AGENT_ID: 'test-agent' };
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
