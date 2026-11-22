import assert from 'node:assert/strict';
import test from 'node:test';
import { createResearch } from '../hub/research.mjs';
import { createTextReference } from '../hub/references.mjs';
import { Session } from '../hub/session.mjs';
const turns = [{ text: 'Our judge Jane Doe works at Example Ventures.' }];
test('agent tool lookup retains professional evidence and deduplicates targets', async () => {
  const calls = []; let time = 0;
  const worker = createResearch({ env: { FIBER_API_KEY: 'fiber-test', OPENAI_API_KEY: 'openai-test' }, now: () => time, fetchImpl: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return Response.json(url.includes('openai') ? { output: [{ type: 'function_call', name: 'research_person', arguments: JSON.stringify({ name: 'Jane Doe', company: 'Example Ventures' }) }] } : { output: { data: [{
      name: 'Jane Doe', primary_slug: 'jane-doe', current_job: { company_name: 'Example University', is_current: true, title: 'Trustee' },
      experiences: [{ company_name: 'Example Ventures', is_current: false, title: 'Former associate' }, { company_name: 'Example Ventures', is_current: true, title: 'Partner' }],
      headline: 'Investor in infrastructure', email: 'private@example.com',
    }] } });
  } });
  const doc = await worker.observe(turns);
  assert.equal(doc.kind, 'research');
  assert.match(doc.chunks[0].text, /Partner/);
  assert.doesNotMatch(doc.chunks[0].text, /Former associate|Trustee/);
  assert.doesNotMatch(JSON.stringify(doc), /private@example/);
  assert.equal(calls[1].body.forceCompanyMatch, true);
  assert.equal(calls[1].body.liveFetch, false);
  time += 16000;
  assert.equal(await worker.observe(turns), null);
  assert.equal(calls.filter(c => c.url.includes('fiber')).length, 1);
});
test('missing credentials, local text, or disabled research never invoke providers', async () => {
  const keys = { FIBER_API_KEY: 'fiber-test', OPENAI_API_KEY: 'openai-test' };
  for (const env of [{}, { ...keys, TELEPATHY_LLM: 'local' }, { ...keys, TELEPATHY_LLM: 'off' }, { ...keys, TELEPATHY_RESEARCH: 'off' }]) {
    const worker = createResearch({ env, fetchImpl: () => { throw new Error('Unexpected provider call'); } });
    assert.equal(worker.enabled, false);
    assert.equal(await worker.observe(turns), null);
  }
});
test('a match at a former employer does not become evidence', async () => {
  const worker = createResearch({
    env: { FIBER_API_KEY: 'fiber-test', OPENAI_API_KEY: 'openai-test' },
    fetchImpl: async url => Response.json(url.includes('openai') ? {
      output: [{ type: 'function_call', name: 'research_person', arguments: JSON.stringify({ name: 'Jane Doe', company: 'Example Ventures' }) }],
    } : {
      output: { data: [{
        name: 'Jane Doe',
        current_job: { company_name: 'Other Ventures', is_current: true },
        experiences: [{ company_name: 'Example Ventures', is_current: false }],
      }] },
    }),
  });
  assert.equal(await worker.observe(turns), null);
});
test('accepted research enters the coaching corpus and only its label reaches Stage', async () => {
  const reference = createTextReference('Fiber background: Jane Doe', 'Jane Doe is a Partner at Example Ventures.', { kind: 'research' });
  const session = new Session({
    emitSeat() {}, emitStage() {}, audio: {}, codec: {},
    researchFactory: () => ({ enabled: true, observe: async () => reference }),
  });
  try {
    session.phase = 'live';
    session.room.listening = true;
    session.addTranscript('room', turns[0].text);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(session.referenceCorpus(), [reference]);
    assert.ok(session.pitchContext('A', Date.now()).passages.some(passage => passage.name === reference.name));
    assert.deepEqual(session.snapshot().researchSources, [{ id: reference.id, name: reference.name }]);
    assert.equal(session.snapshot('A').researchSources, undefined);
  } finally {
    await session.close();
  }
});
test('reset rejects late research and keeps profiles out of seat snapshots', async () => {
  let finish;
  const session = new Session({ emitSeat() {}, emitStage() {}, audio: {}, codec: {}, researchFactory: () => ({ observe: () => new Promise(resolve => { finish = resolve; }) }) });
  session.phase = 'live'; session.researchInBackground(turns);
  await session.reset();
  finish({ id: 'stale', chunks: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(session.researchReferences, []);
  assert.equal(session.snapshot('A').researchReferences, undefined);
  await session.close();
});
