import assert from 'node:assert/strict';
import test from 'node:test';
import { createResearch } from '../hub/research.mjs';
import { Session } from '../hub/session.mjs';
const turns = [{ text: 'Our judge Jane Doe works at Example Ventures.' }];
test('agent tool lookup retains professional evidence and deduplicates targets', async () => {
  const calls = []; let time = 0;
  const worker = createResearch({ env: { FIBER_API_KEY: 'fiber-test', OPENAI_API_KEY: 'openai-test' }, now: () => time, fetchImpl: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return Response.json(url.includes('openai') ? { output: [{ type: 'function_call', name: 'research_person', arguments: JSON.stringify({ name: 'Jane Doe', company: 'Example Ventures' }) }] } : { output: { data: [{ name: 'Jane Doe', primary_slug: 'jane-doe', current_job: { company_name: 'Example Ventures', title: 'Partner' }, headline: 'Investor in infrastructure', email: 'private@example.com' }] } });
  } });
  const doc = await worker.observe(turns);
  assert.equal(doc.kind, 'research');
  assert.match(doc.chunks[0].text, /Partner/);
  assert.doesNotMatch(JSON.stringify(doc), /private@example/);
  assert.equal(calls[1].body.forceCompanyMatch, true);
  assert.equal(calls[1].body.liveFetch, false);
  time += 16000;
  assert.equal(await worker.observe(turns), null);
  assert.equal(calls.filter(c => c.url.includes('fiber')).length, 1);
});
test('missing credentials never invoke providers', async () => {
  const worker = createResearch({ env: {}, fetchImpl: () => { throw new Error('Unexpected provider call'); } });
  assert.equal(worker.enabled, false);
  assert.equal(await worker.observe(turns), null);
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
